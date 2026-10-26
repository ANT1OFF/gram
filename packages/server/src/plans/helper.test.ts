import { describe, expect, it } from "@effect/vitest";
import { PR_RULES, type PlanStepId, type ThreadPlan } from "@gram/contracts";
import {
  applyPrFacts,
  factOf,
  PLAN_SYSTEM,
  planPrompt,
  validateHelperPlan,
  type HelperPlanOutput,
  type PlanFacts,
  type ValidateContext,
} from "./helper.ts";
import * as Effect from "effect/Effect";
import type { HelperJob, HelperSchedulerShape } from "../helper/scheduler.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { formatBasis, parseBasis, refreshPlan } from "./keeper.ts";
import { ThreadPlans } from "./service.ts";

const id = (s: string) => s as PlanStepId;

const plan: ThreadPlan = {
  goal: "Status lanes in the sidebar",
  goalBy: "helper",
  steps: [
    {
      id: id("s1"),
      text: "Lanes by status",
      status: "doing",
      source: "helper",
      pr: { number: 204 },
    },
    { id: id("s2"), text: "Hysteresis for lane moves", status: "todo", source: "helper" },
    { id: id("s3"), text: "Update FEATURES.md", status: "todo", source: "user", locked: true },
  ],
  basis: "rev=3;n=0",
  updatedAt: 1,
  updatedBy: "helper",
};

const facts: PlanFacts = {
  prs: [{ number: 204, repo: "acme/web", state: "open" }],
  uncommitted: 2,
  unpushed: 0,
  agentPlan: [],
};

const context = (overrides: Partial<ValidateContext> = {}): ValidateContext => {
  let n = 0;
  return {
    facts,
    userSpoke: false,
    basis: "rev=9;n=1",
    now: 50,
    newId: () => id(`n${++n}`),
    ...overrides,
  };
};

const answer = (steps: HelperPlanOutput["steps"], next?: string): HelperPlanOutput => ({
  goal: "Status lanes in the sidebar",
  steps,
  ...(next === undefined ? {} : { next }),
});

const locked = (n: string) => ({
  id: id(n),
  text: `Mine ${n}`,
  status: "todo" as const,
  source: "user" as const,
  locked: true,
});

describe("validateHelperPlan", () => {
  it("keeps ids and locked steps, drops unknown PRs, and wants evidence for done", () => {
    const next = validateHelperPlan(
      plan,
      answer(
        [
          { id: "s1", text: "Lanes by status", status: "done", pr: 204, evidence: "tests pass" },
          { id: "s2", text: "Hysteresis for lane moves", status: "done", pr: 999 },
          { id: "s3", text: "Rewrite FEATURES.md entirely", status: "done" },
          { id: "zz", text: "Fix Parked lane focus", status: "todo" },
        ],
        "zz",
      ),
      context(),
    );
    expect(next).toEqual({
      goal: "Status lanes in the sidebar",
      goalBy: "helper",
      steps: [
        {
          id: "s1",
          text: "Lanes by status",
          status: "done",
          source: "helper",
          // The association it had stands, since it still names a PR among the facts.
          pr: { number: 204 },
          evidence: "tests pass",
        },
        { id: "s2", text: "Hysteresis for lane moves", status: "doing", source: "helper" },
        plan.steps[2],
        { id: "n1", text: "Fix Parked lane focus", status: "todo", source: "helper" },
      ],
      next: "n1",
      basis: "rev=9;n=1",
      updatedAt: 50,
      updatedBy: "helper",
    });
  });

  it("makes a repeated id a new step, so no locked step is copied or lost", () => {
    const mine = { ...plan, steps: [locked("A"), locked("B"), locked("C")] };
    const repeated = answer([
      ...Array.from({ length: 7 }, () => ({ id: "A", text: "Mine A", status: "todo" as const })),
      { id: "C", text: "Mine C", status: "todo" as const },
    ]);
    const next = validateHelperPlan(mine, repeated, context({ userSpoke: true }));
    const ids = next?.steps.map((s) => s.id) ?? [];
    expect(ids.filter((s) => ["A", "B", "C"].includes(s)).toSorted()).toEqual(["A", "B", "C"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("puts back a locked step the answer left out", () => {
    const next = validateHelperPlan(
      plan,
      answer([
        { id: "s1", text: "Lanes by status", status: "doing" },
        { id: "s2", text: "Hysteresis for lane moves", status: "todo" },
      ]),
      context(),
    );
    expect(next?.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("refuses churn: most steps reworded when the user said nothing new", () => {
    const churn = answer([
      { id: "s1", text: "Sidebar lanes grouped by status", status: "doing" },
      { id: "s2", text: "Damp lane moves", status: "todo" },
    ]);
    expect(validateHelperPlan(plan, churn, context())).toBeUndefined();
    expect(validateHelperPlan(plan, churn, context({ userSpoke: true }))?.steps[0]?.text).toBe(
      "Sidebar lanes grouped by status",
    );
  });

  it("keeps the agent's or the user's goal, and the previous plan when nothing moved", () => {
    const agents = { ...plan, goalBy: "agent" as const };
    const same = answer(
      plan.steps.map((s) => ({
        id: s.id,
        text: s.text,
        status: s.status,
        pr: s.pr?.number ?? null,
      })),
    );
    const kept = validateHelperPlan(agents, { ...same, goal: "Other" }, context());
    expect(kept).toMatchObject({ goal: plan.goal, goalBy: "agent", updatedAt: 1 });
    expect(kept?.basis).toBe("rev=9;n=1");
  });

  it("takes a new next step even when no step changed", () => {
    const named = { ...plan, next: id("s1") };
    const same = answer(
      plan.steps.map((s) => ({
        id: s.id,
        text: s.text,
        status: s.status,
        pr: s.pr?.number ?? null,
      })),
      "s2",
    );
    expect(validateHelperPlan(named, same, context())?.next).toBe("s2");
  });

  it("lets an orchestrator's step take the answer's status, in the brief's words", () => {
    const brief = {
      ...plan,
      steps: [
        {
          id: id("o1"),
          text: "Fix the flake",
          status: "todo" as const,
          source: "orchestrator" as const,
          locked: true,
        },
      ],
    };
    const next = validateHelperPlan(
      brief,
      answer([{ id: "o1", text: "Fixed the flake", status: "done", evidence: "20 of 20 pass" }]),
      context({ userSpoke: true }),
    );
    expect(next?.steps[0]).toMatchObject({
      text: "Fix the flake",
      status: "done",
      source: "orchestrator",
      locked: true,
      evidence: "20 of 20 pass",
    });
  });

  it("marks a merged PR's step done from the facts, not the answer", () => {
    const merged = { ...facts, prs: [{ number: 204, state: "merged" as const }] };
    const next = validateHelperPlan(
      plan,
      answer([{ id: "s1", text: "Lanes by status", status: "doing", pr: 204 }]),
      context({ facts: merged }),
    );
    expect(next?.steps[0]).toMatchObject({ status: "done", evidence: "#204 merged" });
  });
});

describe("PRs of the same number in two repos", () => {
  const two: PlanFacts = {
    ...facts,
    prs: [
      { number: 42, repo: "acme/web", state: "merged" },
      { number: 42, repo: "acme/api", state: "open" },
    ],
  };
  const apiStep = {
    id: id("a"),
    text: "Ship the API half",
    status: "doing" as const,
    source: "helper" as const,
    pr: { number: 42, repo: "acme/api" },
  };

  it("matches a step's PR by its repo, and leaves a bare number shared by two unmatched", () => {
    expect(factOf({ number: 42, repo: "ACME/api" }, two.prs)?.state).toBe("open");
    const withApi = { ...plan, steps: [apiStep] };
    expect(applyPrFacts(withApi, two.prs)).toBe(withApi);
    expect(factOf({ number: 42 }, [two.prs[1]!, two.prs[0]!])?.repo).toBe("acme/api");
  });

  it("keeps a step's repo when the answer gives only the shared number, and drops a new one", () => {
    const next = validateHelperPlan(
      { ...plan, steps: [apiStep] },
      answer([
        { id: "a", text: "Ship the API half", status: "doing", pr: 42 },
        { id: null, text: "Ship the web half", status: "todo", pr: 42 },
      ]),
      context({ facts: two, userSpoke: true }),
    );
    expect(next?.steps[0]?.pr).toEqual({ number: 42, repo: "acme/api" });
    expect(next?.steps[1]?.pr).toBeUndefined();
  });
});

describe("applyPrFacts", () => {
  it("finishes a merged PR's step, reopens it when the PR does, and leaves the rest alone", () => {
    const merged = applyPrFacts(plan, [{ number: 204, state: "merged" }]);
    expect(merged?.steps[0]).toMatchObject({ status: "done", evidence: "#204 merged" });
    const reopened = applyPrFacts(merged, [{ number: 204, state: "open" }]);
    expect(reopened?.steps[0]).toMatchObject({ status: "doing" });
    expect(reopened?.steps[0]?.evidence).toBeUndefined();
    expect(applyPrFacts(plan, [{ number: 204, state: "open" }])).toBe(plan);
  });
});

describe("the plan prompt", () => {
  it("fences the facts, the plan with its locks, and ends on the cue", () => {
    const prompt = planPrompt(facts, plan, "<conversation>\n\nUser: hi\n\n</conversation>");
    expect(prompt).toContain('<facts>{"prs":[{"number":204,"repo":"acme/web","state":"open"}]');
    expect(prompt).toContain('"id":"s3","text":"Update FEATURES.md","status":"todo","locked":true');
    expect(prompt.endsWith("Plan JSON:")).toBe(true);
  });

  it("carries the <pr> block after the facts, with the rules for it", () => {
    const pr =
      "<pr>\nPR #204 (acme/web): open\nBot review (example-code-review): no review yet\n</pr>";
    const prompt = planPrompt(facts, plan, "<conversation>\n</conversation>", pr);
    expect(prompt).toContain(`</facts>\n${pr}\n<plan>`);
    expect(planPrompt(facts, plan, "<conversation>\n</conversation>")).not.toContain("<pr>");
    expect(PLAN_SYSTEM).toContain(PR_RULES);
  });

  it("reads back the basis it writes", () => {
    expect(parseBasis(formatBasis({ rev: 12, n: 3 }))).toEqual({ rev: 12, n: 3 });
    expect(parseBasis("")).toBeUndefined();
  });
});

describe("refreshPlan", () => {
  it.effect("asks the scheduler with the fenced material, and keeps the checked answer", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const plans = yield* ThreadPlans;
      const fake = yield* FakeAgentControl;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "fix the retry flake, then open a PR" },
      });
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      yield* session.completeTurn("switched it to the fake clock; 20 of 20 pass");
      yield* waitFor(
        "the reply",
        store.listMessages(thread.id).pipe(Effect.map((messages) => messages.length === 2)),
      );
      yield* plans.setByAgent(thread.id, { goal: "Deterministic retry test" }, []);

      const jobs: Array<HelperJob<unknown, unknown>> = [];
      let reply: HelperPlanOutput = {
        goal: "ignored: the agent wrote the goal",
        steps: [
          {
            id: null,
            text: "Switch the test to the fake clock",
            status: "done",
            evidence: "20 of 20 pass",
          },
          { id: null, text: "Open a PR", status: "todo" },
        ],
      };
      const scheduler = {
        schedule: (job: HelperJob<unknown, unknown>) =>
          Effect.sync(() => {
            jobs.push(job);
            return { _tag: "Done" as const, value: reply as never, cached: false };
          }),
      } as unknown as HelperSchedulerShape;
      let gitReads = 0;
      const deps = {
        store,
        plans,
        scheduler,
        gitOf: () => Effect.sync(() => void gitReads++),
        prContext: () => Effect.succeed([]),
      };

      const first = yield* refreshPlan(deps, thread.id, {
        lane: "background",
        rebuild: false,
        userSpoke: false,
      });
      expect(first).toMatchObject({
        goal: "Deterministic retry test",
        goalBy: "agent",
        updatedBy: "helper",
        steps: [
          { status: "done", source: "helper" },
          { text: "Open a PR", status: "todo" },
        ],
      });
      expect(parseBasis(first?.basis)?.n).toBe(0);
      // Read once for the prompt and again when the answer lands, which may be much later.
      expect(gitReads).toBe(2);
      const prompt = yield* jobs[0]!.prompt;
      expect(prompt).toContain("User: fix the retry flake, then open a PR");
      expect(prompt).toContain("Assistant: switched it to the fake clock");
      expect(jobs[0]).toMatchObject({ kind: "plan", lane: "background", system: PLAN_SYSTEM });

      // The same answer again from the cache was applied already; the plan stays as it is.
      const cachedScheduler = {
        schedule: () =>
          Effect.succeed({ _tag: "Done" as const, value: reply as never, cached: true }),
      } as unknown as HelperSchedulerShape;
      const again = yield* refreshPlan({ ...deps, scheduler: cachedScheduler }, thread.id, {
        lane: "background",
        rebuild: false,
        userSpoke: false,
      });
      expect(again).toEqual(first);

      // The user edits a step while the next call is out; the answer can't undo it.
      const [done, open] = first!.steps;
      reply = {
        goal: "",
        steps: [
          { id: done!.id, text: done!.text, status: "done", evidence: "20 of 20 pass" },
          { id: open!.id, text: "Open a PR", status: "doing" },
        ],
      };
      yield* plans.edit(thread.id, {
        goal: first!.goal,
        steps: [
          { id: done!.id, text: done!.text, status: "done" },
          { id: open!.id, text: "Open a draft PR", status: "todo" },
        ],
      });
      const second = yield* refreshPlan(deps, thread.id, {
        lane: "interactive",
        rebuild: false,
        userSpoke: false,
      });
      expect(second?.steps[1]).toMatchObject({ text: "Open a draft PR", source: "user" });
      expect(parseBasis(second?.basis)?.n).toBe(1);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
