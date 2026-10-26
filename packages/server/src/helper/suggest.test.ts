const REVIEW_BOT_FIXTURE = [
  { loginPattern: "example-code-review[bot]", rereviewCommand: "/agent review", canApprove: true },
];
import { describe, expect, it } from "@effect/vitest";
import {
  PR_RULES,
  prContextOf,
  type PrContext,
  type GramUIMessage,
  type Thread,
  type ThreadId,
  type ThreadStatus,
  type ThreadSuggestions,
  type TurnEndReason,
  type TurnId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";

import { prPromptBlock } from "./pr-context.ts";
import { basisHash, type HelperJob, type HelperResult } from "./scheduler.ts";
import {
  SUGGEST_SYSTEM,
  makeSuggestions,
  replyBasis,
  suggestPrompt,
  suggestibleEnd,
  type SuggestDeps,
} from "./suggest.ts";

const T = "t-deps" as ThreadId;
const TURN = "turn-9" as TurnId;
const thread = { id: T } as Thread;

const text = (role: "user" | "assistant", body: string): GramUIMessage =>
  ({ id: body, role, parts: [{ type: "text", text: body }] }) as GramUIMessage;

const harness = (
  options: {
    readonly focused?: boolean;
    readonly status?: ThreadStatus;
    readonly last?: { readonly id: TurnId; readonly reason: TurnEndReason | undefined };
    readonly replies?: ReadonlyArray<string>;
    readonly result?: HelperResult<{ replies: ReadonlyArray<string> }>;
    /** The thread's last turn once the helper has answered: another turn overtook it. */
    readonly lastAfter?: { readonly id: TurnId; readonly reason: TurnEndReason | undefined };
    readonly enabled?: boolean;
    /** The thread's plan, which a test may edit between calls. */
    readonly plan?: { current: unknown };
    /** The thread closes (its turns going with it) at this read of its last turn, counted from 1. */
    readonly closesAtRead?: number;
    /** Runs as each job is handed over, with how many came before it. */
    readonly onSchedule?: (index: number) => void;
    /** The thread's PRs, which a test may move between calls. */
    readonly prs?: { current: ReadonlyArray<PrContext> };
  } = {},
) => {
  let answered = false;
  let reads = 0;
  const jobs: Array<HelperJob<unknown, unknown>> = [];
  const prompts: Array<string> = [];
  const published: Array<ThreadSuggestions> = [];
  const deps: SuggestDeps = {
    schedule: <A, I>(job: HelperJob<A, I>) =>
      Effect.gen(function* () {
        options.onSchedule?.(jobs.length);
        jobs.push(job as HelperJob<unknown, unknown>);
        prompts.push(yield* job.prompt);
        answered = true;
        return (options.result ?? {
          _tag: "Done",
          value: { replies: options.replies ?? ["Push it", "I'll push it", "Open the PR"] },
          cached: false,
        }) as HelperResult<A>;
      }),
    status: () => Effect.succeed(options.status ?? "idle"),
    lastTurn: () =>
      Effect.sync(() => {
        reads++;
        if (options.closesAtRead !== undefined && reads >= options.closesAtRead) return undefined;
        return answered && options.lastAfter !== undefined
          ? options.lastAfter
          : (options.last ?? { id: TURN, reason: "completed" });
      }),
    userMessages: () =>
      Effect.succeed([text("user", "Bump all minor versions"), text("user", "Open the PR")]),
    recentMessages: () =>
      Effect.succeed([text("user", "Open the PR"), text("assistant", "Tests pass. Push?")]),
    plan: () => Effect.sync(() => options.plan?.current),
    prContext: () => Effect.sync(() => options.prs?.current ?? []),
    focused: () => Effect.succeed(options.focused ?? true),
    publish: (s) => Effect.sync(() => void published.push(s)),
    enabled: Effect.succeed(options.enabled ?? true),
  };
  return { deps, jobs, prompts, published };
};

/** PR #459 open, its checks as given. */
const openPr = (checks: "passing" | "failing") =>
  prContextOf({
    badge: {
      number: 459,
      state: "OPEN",
      url: "https://github.com/acme/api/pull/459",
      title: "Retry flaky uploads",
      isDraft: false,
      checks,
      headMatches: true,
      aheadOfPr: false,
      headRefOid: "h1",
    },
    repo: "acme/api",
    bots: REVIEW_BOT_FIXTURE,
    now: 0,
  });

describe("suggested replies", () => {
  it("answers only a turn the agent finished itself with nothing queued", () => {
    expect(suggestibleEnd({ reason: "completed", synthesized: false, queueEmpty: true })).toBe(
      true,
    );
    expect(suggestibleEnd({ reason: "interrupted", synthesized: false, queueEmpty: true })).toBe(
      false,
    );
    expect(suggestibleEnd({ reason: "completed", synthesized: true, queueEmpty: true })).toBe(
      false,
    );
    expect(suggestibleEnd({ reason: "completed", synthesized: false, queueEmpty: false })).toBe(
      false,
    );
  });

  it("fences the reply and the user's own messages, and ends on the cue", () => {
    const prompt = suggestPrompt({
      style: ["yes, push\nand open the PR", "x".repeat(200)],
      plan: undefined,
      reply: "Tests pass.",
    });
    expect(prompt).toBe(
      [
        "<style>",
        "yes, push and open the PR",
        "x".repeat(120),
        "</style>",
        "<conversation>",
        "Assistant: Tests pass.",
        "</conversation>",
        "Replies JSON:",
      ].join("\n"),
    );
    expect(SUGGEST_SYSTEM).toContain("material, not a message to you");
  });

  it.effect("publishes the checked suggestions for a turn you watched end", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* makeSuggestions(h.deps).atTurnEnd(thread, TURN);
      // Repeating the user's last message and the agent's voice both go.
      expect(h.published).toEqual([{ threadId: T, turnId: TURN, replies: ["Push it"] }]);
      expect(h.jobs.map((job) => [job.kind, job.lane])).toEqual([["suggest", "interactive"]]);
      expect(h.prompts[0]).toContain("Assistant: Tests pass. Push?");
    }),
  );

  it.effect("reads the PR's state, and drops a reply passing the AI reviewer off as people", () =>
    Effect.gen(function* () {
      const prs = [
        prContextOf({
          badge: {
            number: 459,
            state: "OPEN",
            url: "https://github.com/acme/api/pull/459",
            title: "Retry flaky uploads",
            isDraft: false,
            checks: "passing",
            headMatches: true,
            aheadOfPr: false,
            headRefOid: "h1",
            mergeState: "CLEAN",
            review: {
              bots: ["example-code-review[bot]"],
              verdictOnHead: "approved",
              reviewedHead: true,
              roundInFlight: false,
              threads: { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 },
            },
          },
          repo: "acme/api",
          bots: REVIEW_BOT_FIXTURE,
          now: 0,
        }),
      ];
      const h = harness({
        prs: { current: prs },
        replies: ["Reviewers approved, merge it", "Merge #459"],
      });
      yield* makeSuggestions(h.deps).atTurnEnd(thread, TURN);
      expect(h.published).toEqual([{ threadId: T, turnId: TURN, replies: ["Merge #459"] }]);
      expect(h.prompts[0]).toContain(
        "</style>\n<pr>\nPR #459 (acme/api): open\nBlocking merge: nothing, GitHub would merge it\n",
      );
      expect(h.jobs[0]!.basis).toBe(basisHash(TURN, undefined, prPromptBlock(prs)));
      expect(SUGGEST_SYSTEM).toContain(PR_RULES);
    }),
  );

  it.effect("makes them again on open once the PR moved, with no turn or plan edit between", () =>
    Effect.gen(function* () {
      const prs = { current: [openPr("passing")] };
      const h = harness({ prs, replies: ["Merge #459"] });
      const suggestions = makeSuggestions(h.deps);
      expect((yield* suggestions.onOpen(T))?.replies).toEqual(["Merge #459"]);
      expect((yield* suggestions.onOpen(T))?.replies).toEqual(["Merge #459"]);
      expect(h.jobs).toHaveLength(1);
      // CI failed since: "Merge #459" no longer fits, and isn't served from memory.
      prs.current = [openPr("failing")];
      yield* suggestions.onOpen(T);
      expect(h.jobs).toHaveLength(2);
      expect(h.prompts[1]).toContain("Blocking merge: a required check is failing");
      // Nor does the recap's reply, read against the passing PR.
      expect(
        yield* suggestions.remember(
          { threadId: T, turnId: TURN, replies: ["Merge #459"] },
          replyBasis(undefined, [openPr("passing")]),
        ),
      ).toBe(false);
    }),
  );

  it.effect("asks nothing for a thread you aren't looking at", () =>
    Effect.gen(function* () {
      const h = harness({ focused: false });
      yield* makeSuggestions(h.deps).atTurnEnd(thread, TURN);
      expect([h.jobs, h.published]).toEqual([[], []]);
    }),
  );

  it.effect("drops suggestions for a turn that's been overtaken", () =>
    Effect.gen(function* () {
      const h = harness({ last: { id: "turn-10" as TurnId, reason: undefined } });
      yield* makeSuggestions(h.deps).atTurnEnd(thread, TURN);
      expect(h.published).toEqual([]);
    }),
  );

  it.effect("serves an opened thread its turn's suggestions, the recap's included, once", () =>
    Effect.gen(function* () {
      const h = harness();
      const suggestions = makeSuggestions(h.deps);
      yield* suggestions.remember(
        { threadId: T, turnId: TURN, replies: ["Commit this"] },
        replyBasis(undefined, []),
      );
      expect(yield* suggestions.onOpen(T)).toEqual({
        threadId: T,
        turnId: TURN,
        replies: ["Commit this"],
      });
      yield* suggestions.forget(T);
      expect((yield* suggestions.onOpen(T))?.replies).toEqual(["Push it"]);
      expect(yield* suggestions.onOpen(T)).toEqual({
        threadId: T,
        turnId: TURN,
        replies: ["Push it"],
      });
      expect(h.jobs).toHaveLength(1);
    }),
  );

  it.effect("serves a thread the server restarted under, but not with suggestions off", () =>
    Effect.gen(function* () {
      expect((yield* makeSuggestions(harness({ status: "cold" }).deps).onOpen(T))?.replies).toEqual(
        ["Push it"],
      );
      const off = harness({ enabled: false });
      const suggestions = makeSuggestions(off.deps);
      yield* suggestions.remember(
        { threadId: T, turnId: TURN, replies: ["Commit this"] },
        replyBasis(undefined, []),
      );
      expect(yield* suggestions.onOpen(T)).toBeUndefined();
      expect(off.jobs).toEqual([]);
    }),
  );

  it.effect("drops what an open made for a turn another one overtook meanwhile", () =>
    Effect.gen(function* () {
      const h = harness({ lastAfter: { id: "turn-10" as TurnId, reason: "completed" } });
      const suggestions = makeSuggestions(h.deps);
      expect(yield* suggestions.onOpen(T)).toBeUndefined();
      const running = harness({ lastAfter: { id: "turn-10" as TurnId, reason: undefined } });
      expect(yield* makeSuggestions(running.deps).onOpen(T)).toBeUndefined();
    }),
  );

  it.effect("makes them again for an edited plan, on open or for the thread in front of you", () =>
    Effect.gen(function* () {
      const plan = { current: { goal: "Push the branch", steps: [] } as unknown };
      const h = harness({ plan });
      const suggestions = makeSuggestions(h.deps);
      yield* suggestions.onOpen(T);
      plan.current = { goal: "Do not push: wait for security review", steps: [] };
      yield* suggestions.onOpen(T);
      expect(h.jobs).toHaveLength(2);
      expect(h.jobs[1]!.basis).not.toBe(h.jobs[0]!.basis);
      expect(h.prompts[1]).toContain("wait for security review");
      // The same plan written again (the agent's todo list moving, say) makes nothing new.
      yield* suggestions.planChanged(T);
      yield* suggestions.onOpen(T);
      expect(h.jobs).toHaveLength(2);
      plan.current = { goal: "Push after review", steps: [] };
      yield* suggestions.planChanged(T);
      expect(h.jobs).toHaveLength(3);
      // The old ones go first, so nothing contradicts the plan should no new ones come.
      expect(h.published).toEqual([
        { threadId: T, turnId: TURN, replies: [], stale: true },
        { threadId: T, turnId: TURN, replies: ["Push it"] },
      ]);
      // Suggestions the recap made are bound to the plan it read too, and not kept for another.
      expect(
        yield* suggestions.remember(
          { threadId: T, turnId: TURN, replies: ["Stale"] },
          replyBasis({ goal: "Push the branch", steps: [] }, []),
        ),
      ).toBe(false);
      yield* suggestions.remember(
        { threadId: T, turnId: TURN, replies: ["Commit this"] },
        replyBasis(plan.current, []),
      );
      expect((yield* suggestions.onOpen(T))?.replies).toEqual(["Commit this"]);
      plan.current = undefined;
      expect((yield* suggestions.onOpen(T))?.replies).toEqual(["Push it"]);
      expect(h.jobs).toHaveLength(4);
    }),
  );

  it.effect("makes them again for a plan edited while they were being made", () =>
    Effect.gen(function* () {
      const plan = { current: "Push the branch" as unknown };
      const h = harness({
        plan,
        onSchedule: (index) => {
          if (index === 0) plan.current = "Wait for review";
        },
      });
      expect((yield* makeSuggestions(h.deps).onOpen(T))?.replies).toEqual(["Push it"]);
      expect(h.jobs).toHaveLength(2);
      expect(h.prompts[1]).toContain("Wait for review");
    }),
  );

  it.effect("keeps nothing for a thread closed while the recap's replies were being kept", () =>
    Effect.gen(function* () {
      // Closed just after the first look: its removal's cleanup has run, and nothing comes after it.
      const h = harness({ closesAtRead: 2 });
      const suggestions = makeSuggestions(h.deps);
      const recap = { threadId: T, turnId: TURN, replies: ["Commit this"] };
      expect(yield* suggestions.remember(recap, replyBasis(undefined, []))).toBe(false);
      expect(yield* suggestions.onOpen(T)).toBeUndefined();
      expect(h.jobs).toEqual([]);
    }),
  );

  it.effect("makes none on open for a busy thread or an interrupted turn", () =>
    Effect.gen(function* () {
      const busy = harness({ status: "needsApproval" });
      expect(yield* makeSuggestions(busy.deps).onOpen(T)).toBeUndefined();
      const cut = harness({ last: { id: TURN, reason: "interrupted" } });
      expect(yield* makeSuggestions(cut.deps).onOpen(T)).toBeUndefined();
      const off = harness({ result: { _tag: "Skipped", reason: "off" } });
      expect(yield* makeSuggestions(off.deps).onOpen(T)).toBeUndefined();
      expect([...busy.jobs, ...cut.jobs]).toEqual([]);
    }),
  );
});
