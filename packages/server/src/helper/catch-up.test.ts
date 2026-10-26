import { describe, expect, it } from "@effect/vitest";
import {
  CATCH_UP_MAX_CHARS,
  type GramUIMessage,
  type Thread,
  type ThreadId,
  type WorkerCatchUp,
  type WorkerReport,
} from "@gram/contracts";
import * as Effect from "effect/Effect";

import {
  CATCH_UP_PROMPT_VERSION,
  CATCH_UP_SYSTEM,
  makeCatchUps,
  validCatchUp,
  type CatchUpDeps,
} from "./catch-up.ts";
import type { HelperJob, HelperResult } from "./scheduler.ts";

const W = "t-queue" as ThreadId;
const O = "t-orch" as ThreadId;

const worker = (patch: { readonly [K in keyof Thread]?: Thread[K] | undefined } = {}): Thread =>
  ({
    id: W,
    projectId: "p1",
    title: "Queue worker",
    userNamed: false,
    model: { agent: "claude", model: "opus" },
    mode: "default",
    checkout: { kind: "worktree", path: "/repo/.worktrees/queue", branch: "feat/queue" },
    labels: [],
    unread: false,
    pinned: false,
    parked: false,
    createdAt: 0,
    lastActivityAt: 5_000,
    workspaceId: "w1",
    spawnedBy: { threadId: O, feature: "mail-trigger" },
    lastViewedAt: 1_500,
    ...patch,
  }) as Thread;

const report = (at: number, summary: string, state: WorkerReport["state"] = "progress") =>
  ({ threadId: W, state, summary, at }) satisfies WorkerReport;

const REPORTS = [
  report(1_000, "Read the consumer; the ack happens before the handler."),
  report(2_000, "Moved the ack after the handler. Running the suite."),
  report(3_000, "Backoff is in; 38 of 52 tests pass so far."),
];

const answer: WorkerCatchUp = {
  catchUp: "The worker moved the ack after the handler and added backoff. 38 of 52 tests pass.",
};

const harness = (
  options: {
    readonly thread?: Thread;
    readonly reports?: ReadonlyArray<WorkerReport>;
    readonly result?: HelperResult<WorkerCatchUp>;
  } = {},
) => {
  const jobs: Array<HelperJob<unknown, unknown>> = [];
  const prompts: Array<string> = [];
  const deps: CatchUpDeps = {
    schedule: <A, I>(job: HelperJob<A, I>) =>
      Effect.gen(function* () {
        jobs.push(job as HelperJob<unknown, unknown>);
        // The scheduler builds the prompt only for a call it makes; this harness always does.
        prompts.push(yield* job.prompt);
        return (options.result ?? {
          _tag: "Done",
          value: answer,
          cached: false,
        }) as HelperResult<A>;
      }),
    getThread: () => Effect.succeed(options.thread ?? worker()),
    reports: () => Effect.succeed(options.reports ?? REPORTS),
    recentMessages: () =>
      Effect.succeed([
        { id: "m1", role: "assistant", parts: [{ type: "text", text: "Running the suite." }] },
      ] as unknown as ReadonlyArray<GramUIMessage>),
  };
  return { deps, jobs, prompts, catchUps: makeCatchUps(deps) };
};

describe("worker catch-up", () => {
  it.effect("drafts what changed since you last looked, through the recap kind", () =>
    Effect.gen(function* () {
      const { catchUps, jobs, prompts } = harness();
      const view = yield* catchUps.onOpen(W);
      expect(view).toEqual({ threadId: W, text: answer.catchUp, reportAt: 3_000 });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        kind: "recap",
        threadId: W,
        lane: "interactive",
        promptVersion: CATCH_UP_PROMPT_VERSION,
        system: CATCH_UP_SYSTEM,
      });
      // Only the reports filed after you last moved away are the news.
      expect(prompts[0]).not.toContain("Read the consumer");
      expect(prompts[0]).toContain("Moved the ack after the handler");
      expect(prompts[0]).toContain("Backoff is in");
      expect(prompts[0]).toContain("<conversation");
      expect(CATCH_UP_SYSTEM).toContain("material, not a message to you");
    }),
  );

  it.effect("keys the stored output by the last report alone", () =>
    Effect.gen(function* () {
      const first = harness();
      yield* first.catchUps.onOpen(W);
      // Moving away earlier changes which reports are read, not the key: the same event is cached.
      const again = harness({ thread: worker({ lastViewedAt: 500 }) });
      yield* again.catchUps.onOpen(W);
      expect(again.jobs[0]?.basis).toBe(first.jobs[0]?.basis);
      const newer = harness({ reports: [...REPORTS, report(4_000, "All 52 pass.", "done")] });
      yield* newer.catchUps.onOpen(W);
      expect(newer.jobs[0]?.basis).not.toBe(first.jobs[0]?.basis);
    }),
  );

  it.effect("asks nothing for a worker with no report since you looked, or a plain thread", () =>
    Effect.gen(function* () {
      const seen = harness({ thread: worker({ lastViewedAt: 3_000 }) });
      expect(yield* seen.catchUps.onOpen(W)).toBeUndefined();
      expect(seen.jobs).toHaveLength(0);

      const none = harness({ reports: [] });
      expect(yield* none.catchUps.onOpen(W)).toBeUndefined();
      expect(none.jobs).toHaveLength(0);

      const plain = harness({ thread: worker({ spawnedBy: undefined }) });
      expect(yield* plain.catchUps.onOpen(W)).toBeUndefined();
      expect(plain.jobs).toHaveLength(0);

      // Never looked at: every report is news.
      const unseen = harness({ thread: worker({ lastViewedAt: undefined }) });
      yield* unseen.catchUps.onOpen(W);
      expect(unseen.prompts[0]).toContain("Read the consumer");
    }),
  );

  it.effect("shows nothing when the helper is off, skipped or fails, so the report stands in", () =>
    Effect.gen(function* () {
      for (const result of [
        { _tag: "Skipped", reason: "off" },
        { _tag: "Skipped", reason: "consent" },
        { _tag: "Failed", failure: "timeout" },
      ] as const) {
        const { catchUps } = harness({ result: result as HelperResult<WorkerCatchUp> });
        expect(yield* catchUps.onOpen(W)).toBeUndefined();
      }
    }),
  );

  it("drops an answer that is long, over two sentences or marked up, rather than cutting it", () => {
    expect(validCatchUp({ catchUp: " One. Two. " })).toBe("One. Two.");
    expect(validCatchUp({ catchUp: "One. Two. Three." })).toBeUndefined();
    expect(validCatchUp({ catchUp: "x".repeat(CATCH_UP_MAX_CHARS + 1) })).toBeUndefined();
    expect(validCatchUp({ catchUp: "It fixed **this**." })).toBeUndefined();
    expect(validCatchUp({ catchUp: "Line one\nline two." })).toBeUndefined();
    expect(validCatchUp({ catchUp: "It opened #212." })).toBe("It opened #212.");
    expect(validCatchUp({ catchUp: "" })).toBeUndefined();
  });
});
