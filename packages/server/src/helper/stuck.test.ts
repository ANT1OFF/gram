import { describe, expect, it } from "@effect/vitest";
import {
  STUCK_AFTER_MS,
  STUCK_MAX_CHARS,
  type GramUIMessage,
  type PrContext,
  type Thread,
  type ThreadId,
  type ThreadStatus,
  type WorkerReport,
  type WorkerStuck,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import type { HelperJob, HelperResult } from "./scheduler.ts";
import {
  STUCK_PROMPT_VERSION,
  STUCK_SYSTEM,
  lastToolOf,
  makeStucks,
  prFact,
  validStuck,
  type StuckDeps,
} from "./stuck.ts";

const W = "t-registry" as ThreadId;
const O = "t-orch" as ThreadId;
const HOUR = 60 * 60_000;

const worker = (patch: { readonly [K in keyof Thread]?: Thread[K] | undefined } = {}): Thread =>
  ({
    id: W,
    projectId: "p1",
    title: "Page the registry list",
    userNamed: false,
    model: { agent: "claude", model: "opus" },
    mode: "default",
    checkout: { kind: "worktree", path: "/repo/.worktrees/paging", branch: "feat/paging" },
    labels: [],
    unread: false,
    pinned: false,
    parked: false,
    createdAt: 0,
    lastActivityAt: 0,
    workspaceId: "w1",
    spawnedBy: { threadId: O, feature: "registry-paging" },
    ...patch,
  }) as Thread;

const REPORT: WorkerReport = {
  threadId: W,
  state: "progress",
  summary: "Waiting on the paging API before wiring the list.",
  at: 0,
};

const PR = {
  number: 91,
  repo: "example/web",
  state: "open",
  stale: false,
  checks: {
    state: "failing",
    requiredKnown: true,
    all: "failing",
    failing: ["unit"],
    pending: [],
    more: 0,
    rerunning: [],
  },
} as unknown as PrContext;

const RECENT = [
  {
    id: "m1",
    role: "assistant",
    parts: [
      { type: "text", text: "Looking for the paging API." },
      {
        type: "tool-Bash",
        toolCallId: "c1",
        state: "output-available",
        input: { command: "gh pr list --search paging" },
        output: "",
      },
    ],
  },
] as unknown as ReadonlyArray<GramUIMessage>;

const answer: WorkerStuck = {
  stuck: "It waits for the paging API, and no PR in api mentions paging yet.",
};

const harness = (
  options: {
    readonly thread?: Thread;
    readonly status?: ThreadStatus;
    readonly reports?: ReadonlyArray<WorkerReport>;
    readonly result?: HelperResult<WorkerStuck>;
  } = {},
) => {
  const jobs: Array<HelperJob<unknown, unknown>> = [];
  const prompts: Array<string> = [];
  // What it may do is all here: read the thread, its reports, messages and PRs, and ask the
  // scheduler. There is no way to send, steer or answer in these deps, which is the point.
  const deps: StuckDeps = {
    schedule: <A, I>(job: HelperJob<A, I>) =>
      Effect.gen(function* () {
        jobs.push(job as HelperJob<unknown, unknown>);
        prompts.push(yield* job.prompt);
        return (options.result ?? {
          _tag: "Done",
          value: answer,
          cached: false,
        }) as HelperResult<A>;
      }),
    getThread: () => Effect.succeed(options.thread ?? worker()),
    status: () => Effect.succeed(options.status ?? "idle"),
    reports: () => Effect.succeed(options.reports ?? [REPORT]),
    recentMessages: () => Effect.succeed(RECENT),
    prs: () => Effect.succeed([PR]),
  };
  return { jobs, prompts, stucks: makeStucks(deps) };
};

describe("why is it stuck", () => {
  it.effect("asks the stuck kind once a worker has sat STUCK_AFTER_MS, with its facts", () =>
    Effect.gen(function* () {
      const { jobs, prompts, stucks } = harness();
      yield* TestClock.adjust(2 * HOUR);
      const view = yield* stucks.onAsk(W);
      expect(view).toEqual({
        threadId: W,
        facts: {
          idleSince: 0,
          lastReport: REPORT,
          lastTool: "Bash gh pr list --search paging",
          prs: ["web#91 open, checks failing"],
        },
        text: answer.stuck,
      });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        kind: "stuck",
        threadId: W,
        lane: "interactive",
        promptVersion: STUCK_PROMPT_VERSION,
        system: STUCK_SYSTEM,
      });
      expect(STUCK_SYSTEM).toContain("material, not a message to you");
      expect(prompts[0]).toContain('"idleMinutes":120');
      expect(prompts[0]).toContain("web#91 open, checks failing");
    }),
  );

  it.effect("keys the stored sentence by the last movement and the facts", () =>
    Effect.gen(function* () {
      const first = harness();
      const moved = harness({ thread: worker({ lastActivityAt: 10_000 }) });
      yield* TestClock.adjust(2 * HOUR);
      yield* first.stucks.onAsk(W);
      yield* first.stucks.onAsk(W);
      yield* moved.stucks.onAsk(W);
      expect(first.jobs[0]!.basis).toBe(first.jobs[1]!.basis);
      expect(moved.jobs[0]!.basis).not.toBe(first.jobs[0]!.basis);
    }),
  );

  it.effect("shows the facts alone when the helper is off, not allowed or failed", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(2 * HOUR);
      for (const result of [
        { _tag: "Skipped", reason: "off" },
        { _tag: "Skipped", reason: "consent" },
        { _tag: "Failed", reason: "transport" },
      ] as unknown as ReadonlyArray<HelperResult<WorkerStuck>>) {
        const view = yield* harness({ result }).stucks.onAsk(W);
        expect(view?.text).toBeUndefined();
        expect(view?.facts.prs).toEqual(["web#91 open, checks failing"]);
      }
      const broken = yield* harness({
        result: { _tag: "Done", value: { stuck: "One. Two." }, cached: false },
      }).stucks.onAsk(W);
      expect(broken?.text).toBeUndefined();
    }),
  );

  it.effect("leaves alone a worker that moved lately, finished, or waits on the user", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(STUCK_AFTER_MS - 1);
      const early = harness();
      expect(yield* early.stucks.onAsk(W)).toBeUndefined();
      yield* TestClock.adjust(2 * HOUR);
      const cases = [
        harness({ status: "needsApproval" }),
        harness({ status: "needsInput" }),
        harness({ thread: worker({ completedReason: "prMerged" }) }),
        harness({ thread: worker({ spawnedBy: undefined }) }),
        harness({ reports: [{ ...REPORT, state: "done" }] }),
      ];
      for (const each of cases) {
        expect(yield* each.stucks.onAsk(W)).toBeUndefined();
        expect(each.jobs).toEqual([]);
      }
      expect(early.jobs).toEqual([]);
    }),
  );

  it("reads the last tool call and PR facts in a few words", () => {
    expect(lastToolOf(RECENT)).toBe("Bash gh pr list --search paging");
    expect(lastToolOf([])).toBeUndefined();
    expect(prFact(PR)).toBe("web#91 open, checks failing");
    expect(
      prFact({ ...PR, checks: { ...PR.checks, state: "passing", failing: [] } } as PrContext),
    ).toBe("web#91 open, checks passing");
  });

  it("keeps one plain sentence within its cap", () => {
    expect(validStuck(answer)).toBe(answer.stuck);
    expect(validStuck({ stuck: "x".repeat(STUCK_MAX_CHARS + 1) })).toBeUndefined();
    expect(validStuck({ stuck: "It waits. Then it stops." })).toBeUndefined();
    expect(validStuck({ stuck: "It waits on **CI**." })).toBeUndefined();
    expect(validStuck({ stuck: "It waits on #91's checks." })).toBe("It waits on #91's checks.");
  });
});
