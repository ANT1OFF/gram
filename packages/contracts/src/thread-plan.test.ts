import { describe, expect, it } from "vitest";
import type { PrStatus } from "./git.ts";
import type { PlanStepId, RequestId } from "./ids.ts";
import { headlineGroup, planHeadline, type HeadlineFacts } from "./plan-headline.ts";
import {
  applyAgentGoal,
  applyAgentPlan,
  applyUserEdit,
  seedOrchestratorPlan,
  type PlanContext,
} from "./plan-merge.ts";
import { nextStep, planProgress, planText, type ThreadPlan } from "./thread-plan.ts";

const context = (): PlanContext => {
  let n = 0;
  return { now: 100, newId: () => `n${++n}` as PlanStepId };
};

const id = (s: string) => s as PlanStepId;

const plan: ThreadPlan = {
  goal: "Status lanes in the sidebar",
  goalBy: "helper",
  steps: [
    {
      id: id("s1"),
      text: "Lanes by status",
      status: "done",
      source: "helper",
      pr: { number: 204 },
    },
    { id: id("s2"), text: "Fix Parked lane focus", status: "doing", source: "helper" },
    { id: id("s3"), text: "Update FEATURES.md", status: "todo", source: "user", locked: true },
  ],
  next: id("s2"),
  basis: "b1",
  updatedAt: 1,
  updatedBy: "helper",
};

const userStep = (n: number) => ({
  id: id(`u${n}`),
  text: `Mine ${n}`,
  status: "todo" as const,
  source: "user" as const,
  locked: true,
});

const agentStep = (n: number) => ({ text: `Agent ${n}`, status: "todo" as const });

describe("applyAgentPlan", () => {
  it("replaces the steps, keeping ids by text and the user's steps where they stood", () => {
    const next = applyAgentPlan(
      plan,
      {
        goal: "Lanes, focus and docs",
        steps: [
          { text: "lanes by status", status: "done" },
          { text: "Hysteresis for lane moves", status: "done", pr: 233 },
        ],
      },
      [{ repo: "acme/web", number: 233, monitor: false }],
      context(),
    );
    expect(next).toEqual({
      goal: "Lanes, focus and docs",
      goalBy: "agent",
      steps: [
        { id: "s1", text: "lanes by status", status: "done", source: "agent", locked: true },
        {
          id: "n1",
          text: "Hysteresis for lane moves",
          status: "done",
          source: "agent",
          locked: true,
          pr: { number: 233, repo: "acme/web" },
        },
        plan.steps[2],
      ],
      basis: "b1",
      updatedAt: 100,
      updatedBy: "agent",
    });
  });

  it("drops the agent's last steps rather than a user's to stay within the cap", () => {
    const current = { ...plan, steps: [userStep(0), ...plan.steps.slice(0, 2), userStep(7)] };
    const next = applyAgentPlan(
      current,
      { steps: [...[1, 2, 3, 4, 5, 6, 7].map(agentStep), { text: "Mine 7", status: "done" }] },
      [],
      context(),
    );
    expect(next?.steps.map((s) => s.text)).toEqual([
      "Mine 0",
      "Agent 1",
      "Agent 2",
      "Agent 3",
      "Agent 4",
      "Agent 5",
      "Agent 6",
      "Mine 7",
    ]);
  });

  it("leaves a user's goal alone, and the steps when it names none", () => {
    const mine = { ...plan, goalBy: "user" as const };
    expect(applyAgentPlan(mine, { goal: "Something else" }, [], context())).toMatchObject({
      goal: plan.goal,
      goalBy: "user",
      steps: plan.steps,
    });
  });

  it("is no plan at all when it has neither goal nor steps", () => {
    expect(applyAgentPlan(undefined, { goal: "  ", steps: [] }, [], context())).toBeUndefined();
  });
});

describe("applyUserEdit", () => {
  it("makes a changed or new step the user's, and keeps an untouched one as it was", () => {
    const next = applyUserEdit(
      plan,
      {
        goal: plan.goal,
        steps: [
          { id: id("s1"), text: "Lanes by status", status: "done", pr: { number: 204 } },
          { id: id("s2"), text: "Fix Parked lane focus", status: "done" },
          { text: "Ask jordan to review", status: "todo" },
        ],
      },
      context(),
    );
    expect(next?.steps).toEqual([
      plan.steps[0],
      { id: "s2", text: "Fix Parked lane focus", status: "done", source: "user", locked: true },
      { id: "n1", text: "Ask jordan to review", status: "todo", source: "user", locked: true },
    ]);
    expect(next).toMatchObject({ goalBy: "helper", updatedBy: "user" });
    expect(next?.next).toBe("s2");
  });

  it("makes a step the user's when the edit locks it, as a move does", () => {
    const next = applyUserEdit(
      plan,
      {
        goal: plan.goal,
        steps: [
          { id: id("s2"), text: "Fix Parked lane focus", status: "doing", locked: true },
          { id: id("s1"), text: "Lanes by status", status: "done", pr: { number: 204 } },
        ],
      },
      context(),
    );
    expect(next?.steps[0]).toMatchObject({ id: "s2", source: "user", locked: true });
    expect(next?.steps[1]).toEqual(plan.steps[0]);
  });

  it("hands a step back to the helper, and drops `next` with its step", () => {
    const next = applyUserEdit(
      plan,
      {
        goal: "Status lanes",
        steps: [{ id: id("s3"), text: "Update FEATURES.md", status: "todo", locked: false }],
      },
      context(),
    );
    expect(next?.steps).toEqual([
      { id: "s3", text: "Update FEATURES.md", status: "todo", source: "user" },
    ]);
    expect(next?.goalBy).toBe("user");
    expect(next?.next).toBeUndefined();
  });

  it("removes the plan when it is emptied", () => {
    expect(applyUserEdit(plan, { goal: "", steps: [] }, context())).toBeUndefined();
  });
});

describe("seedOrchestratorPlan", () => {
  it("never drops the user's steps to fit a full brief, and leaves their wording the user's", () => {
    const mine = {
      ...plan,
      steps: [userStep(1), userStep(2)],
    };
    const brief = Array.from({ length: 8 }, (_, i) => (i === 0 ? "mine 1" : `Brief ${i}`));
    const seeded = seedOrchestratorPlan(mine, brief, context());
    expect(seeded?.steps).toHaveLength(8);
    expect(seeded?.steps.filter((s) => s.source === "user").map((s) => s.text)).toEqual([
      "Mine 1",
      "Mine 2",
    ]);
  });

  it("seeds a worker's plan from its brief, locked against the agent, whenever it lands", () => {
    const seeded = seedOrchestratorPlan(undefined, ["Fix the flake", "Open a PR"], context());
    expect(seeded).toMatchObject({
      updatedBy: "orchestrator",
      steps: [
        { id: "n1", text: "Fix the flake", status: "todo", source: "orchestrator", locked: true },
        { id: "n2", text: "Open a PR" },
      ],
    });
    // Seeded after the worker's own set_plan, the brief goes first and takes over a step it shares.
    const raced = seedOrchestratorPlan(plan, ["Fix Parked lane focus", "Other"], context());
    expect(raced?.steps.map((s) => [s.text, s.source, s.status])).toEqual([
      ["Fix Parked lane focus", "orchestrator", "doing"],
      ["Other", "orchestrator", "todo"],
      ["Lanes by status", "helper", "done"],
      ["Update FEATURES.md", "user", "todo"],
    ]);
    const agent = applyAgentPlan(
      seeded,
      { steps: [{ text: "Something else", status: "doing" }] },
      [],
      context(),
    );
    // The worker ticks the brief's steps off, with the PR one is about, in the brief's words.
    const ticked = applyAgentPlan(
      seeded,
      {
        steps: [
          { text: "fix the flake", status: "done" },
          { text: "Open a PR", status: "doing", pr: 412 },
        ],
      },
      [{ repo: "acme/api", number: 412, monitor: false }],
      context(),
    );
    expect(ticked?.steps).toMatchObject([
      { text: "Fix the flake", status: "done", source: "orchestrator", locked: true },
      { text: "Open a PR", status: "doing", pr: { number: 412, repo: "acme/api" } },
    ]);
    expect(agent?.steps.map((s) => s.text)).toEqual([
      "Fix the flake",
      "Open a PR",
      "Something else",
    ]);
  });
});

describe("applyAgentGoal", () => {
  it("sets the agent's goal unless the user wrote one, and clears only its own", () => {
    const set = applyAgentGoal(plan, "Sidebar lanes, done properly", 5);
    expect(set).toMatchObject({ goal: "Sidebar lanes, done properly", goalBy: "agent" });
    expect(applyAgentGoal(set, "Sidebar lanes, done properly", 6)).toBe(set);
    expect(applyAgentGoal(set, undefined, 7)).toMatchObject({ goal: "", steps: plan.steps });
    expect(applyAgentGoal(plan, undefined, 7)).toBe(plan);
    const mine = { ...plan, goalBy: "user" as const };
    expect(applyAgentGoal(mine, "Other", 8)).toBe(mine);
    expect(applyAgentGoal(undefined, "Ship 0.8", 9)).toMatchObject({
      goal: "Ship 0.8",
      steps: [],
      updatedBy: "agent",
    });
  });
});

describe("reading a plan", () => {
  it("counts done steps, leaving dropped ones out", () => {
    expect(planProgress(plan)).toEqual({ done: 1, total: 3 });
    const dropped = { steps: [...plan.steps, { ...plan.steps[2]!, status: "dropped" as const }] };
    expect(planProgress(dropped)).toEqual({ done: 1, total: 3 });
  });

  it("picks the named next step while it is open, else the one in progress, else the first open", () => {
    expect(nextStep(plan)?.id).toBe("s2");
    expect(nextStep({ steps: plan.steps, next: plan.steps[0]!.id })?.id).toBe("s2");
    const { next: _next, ...unnamed } = plan;
    const idle = unnamed.steps.map((s) =>
      s.status === "doing" ? { ...s, status: "todo" as const } : s,
    );
    expect(nextStep({ steps: idle })?.id).toBe("s2");
    expect(nextStep({ steps: [plan.steps[0]!] })).toBeUndefined();
  });

  it("keeps a plan's text on one line within the cap", () => {
    expect(planText("  Fix   the\nretry ")).toBe("Fix the retry");
    const cut = planText("word ".repeat(30));
    expect(cut.length).toBeLessThanOrEqual(80);
    expect(cut.endsWith("…")).toBe(true);
  });
});

const badge = (number: number, overrides: Partial<PrStatus> = {}): PrStatus => ({
  number,
  state: "OPEN",
  url: `https://github.com/acme/api/pull/${number}`,
  title: "t",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  ...overrides,
});

const NOW = 10 * 24 * 60 * 60 * 1000;

const facts = (overrides: Partial<HeadlineFacts> = {}): HeadlineFacts => ({
  thread: { lastActivityAt: NOW - 60_000 },
  status: "idle",
  pendingRequests: [],
  plan,
  now: NOW,
  ...overrides,
});

const text = (overrides: Partial<HeadlineFacts> = {}) => planHeadline(facts(overrides))?.text;

describe("planHeadline", () => {
  it("puts what needs the user first: approval, question, plan, error", () => {
    const approval = {
      kind: "approval" as const,
      id: "r1" as RequestId,
      toolName: "Bash",
      displayName: "Bash",
      input: { command: "git push origin fix/flaky-retry\ngit status" },
      suggestions: [],
    };
    expect(planHeadline(facts({ pendingRequests: [approval], status: "needsApproval" }))).toEqual({
      phase: "needsYou",
      text: "Approve: git push origin fix/flaky-retry",
      done: 1,
      total: 3,
    });
    const appTool = {
      ...approval,
      toolName: "mcp__gram__spawn_worker",
      displayName: "spawn_worker",
    };
    expect(text({ pendingRequests: [appTool] })).toBe("Approve: spawn_worker");
    const question = {
      kind: "question" as const,
      id: "r2" as RequestId,
      questions: [
        {
          question: "date-fns or the Temporal polyfill?",
          header: "",
          options: [],
          multiSelect: false,
        },
      ],
    };
    expect(text({ pendingRequests: [question] })).toBe(
      "Question: date-fns or the Temporal polyfill?",
    );
    const review = {
      kind: "plan" as const,
      id: "r3" as RequestId,
      plan: "# Plan\n1. Extract the store\n   - detail\n2. Move refresh\n3. Tests\n",
    };
    expect(text({ pendingRequests: [review] })).toBe("Review the plan: 3 steps");
    expect(text({ status: "error", error: "gateway 429 (no deployments)" })).toBe(
      "Stopped: gateway 429 (no deployments)",
    );
  });

  it("raises CI failing and changes requested on any PR, the extras too", () => {
    const thread = {
      lastActivityAt: NOW,
      extraPrs: [{ repo: "acme/api", number: 412, monitor: false }],
    };
    const git = { pr: badge(235), extraPrs: [badge(412, { checks: "failing" })] };
    expect(planHeadline(facts({ thread, git }))).toMatchObject({
      phase: "needsYou",
      text: "CI failing on #412",
      pr: 412,
    });
    const human = {
      id: "h1",
      author: "jordan",
      verdict: "changesRequested" as const,
      commitOid: "abc",
      submittedAt: "",
      body: "",
    };
    const review = {
      bots: [],
      reviewedHead: false,
      roundInFlight: false,
      threads: { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 },
      humanReviews: [human],
    };
    expect(text({ git: { pr: badge(412, { review }) } })).toBe(
      "Changes requested on #412 · jordan",
    );
  });

  it("counts the step in progress while running", () => {
    expect(planHeadline(facts({ status: "running" }))).toMatchObject({
      phase: "working",
      text: "Step 2 of 3 · Fix Parked lane focus",
    });
    expect(text({ status: "running", activity: "Running pnpm test…" })).toBe(
      "Step 2 of 3 · Running pnpm test…",
    );
    expect(text({ status: "running", plan: undefined })).toBe("Working");
  });

  it("says what an open PR waits on", () => {
    const approved = { reviewDecision: "APPROVED", mergeState: "CLEAN" };
    expect(text({ git: { pr: badge(235, approved) } })).toBe("Ready to merge · #235");
    expect(text({ git: { pr: badge(235, { checks: "pending" }) } })).toBe("Waiting on CI · #235");
    expect(planHeadline(facts({ git: { pr: badge(235) } }))).toMatchObject({
      phase: "waitingReview",
      text: "Waiting on review · #235",
      pr: 235,
      prUrl: "https://github.com/acme/api/pull/235",
    });
    expect(text({ git: { pr: badge(233, { isDraft: true }) } })).toBe("Draft · #233");
    const reviewing = {
      bots: ["example-code-review[bot]"],
      reviewedHead: false,
      roundInFlight: true,
      threads: { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 },
    };
    expect(planHeadline(facts({ git: { pr: badge(235, { review: reviewing }) } }))).toMatchObject({
      phase: "waitingReview",
      text: "AI review running · #235",
    });
  });

  it("follows up after a merge while steps remain, and is done once none do", () => {
    const git = { pr: badge(204, { state: "MERGED" }) };
    expect(planHeadline(facts({ git }))).toMatchObject({
      phase: "followUp",
      text: "Follow-up after #204 · Fix Parked lane focus",
    });
    const finished = { ...plan, steps: plan.steps.map((s) => ({ ...s, status: "done" as const })) };
    expect(planHeadline(facts({ git, plan: finished }))).toMatchObject({
      phase: "done",
      text: "Done · #204 merged",
      done: 3,
      total: 3,
    });
    // Without a plan, a merge with nothing open is done, and a plain idle thread says nothing.
    expect(text({ git, plan: undefined })).toBe("Done · #204 merged");
    expect(planHeadline(facts({ plan: undefined }))).toBeUndefined();
    // Reopened after the merge, the badge it still carries is old news.
    const reopened = {
      lastActivityAt: NOW,
      settledMerge: { merged: [{ number: 204, url: git.pr.url }] },
    };
    expect(text({ git, plan: undefined, thread: reopened })).toBe("Follow-up after #204");
    expect(
      text({ plan: undefined, thread: { lastActivityAt: NOW, completedReason: "agent" } }),
    ).toBe("Done");
  });

  it("names the next step, or how long the thread has rested", () => {
    expect(text()).toBe("Next: Fix Parked lane focus");
    const rested = { lastActivityAt: NOW - 4 * 24 * 60 * 60 * 1000 };
    expect(planHeadline(facts({ thread: rested }))).toMatchObject({
      phase: "stale",
      text: "Idle 4 days · 1 of 3",
    });
  });

  it("reads the agent's todo list while the plan has no steps", () => {
    const turnPlan = [
      { content: "Outline", status: "completed" as const },
      { content: "Write install", status: "inProgress" as const, activeForm: "Writing install" },
      { content: "Open a PR", status: "pending" as const },
    ];
    expect(planHeadline(facts({ plan: undefined, turnPlan, status: "running" }))).toMatchObject({
      text: "Step 2 of 3 · Writing install",
      done: 1,
      total: 3,
    });
  });

  it("has nothing for an orchestrator", () => {
    expect(planHeadline(facts({ thread: { lastActivityAt: NOW, role: "orchestrator" } }))).toBe(
      undefined,
    );
  });
});

describe("headlineGroup", () => {
  it("settles on done or a completion somebody marked, and keeps follow-up work idle", () => {
    expect(headlineGroup("settled", { phase: "followUp" }, "prMerged")).toBe("idle");
    expect(headlineGroup("idle", { phase: "done" }, undefined)).toBe("settled");
    expect(headlineGroup("settled", { phase: "next" }, "user")).toBe("settled");
    expect(headlineGroup("working", { phase: "done" }, undefined)).toBe("working");
    expect(headlineGroup("settled", undefined, "prMerged")).toBe("settled");
  });
});
