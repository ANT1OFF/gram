// @vitest-environment happy-dom
import type {
  GitState,
  ProjectId,
  PrStatus,
  ThreadId,
  ThreadStatus,
  ThreadSummary,
  OrchestratorLedger,
  WorkerLedgerEntry,
  WorkspaceId,
} from "@gram/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { prFactsOfBadge } from "@/components/pr-facts";
import { prGlyphOf } from "@/components/pr-glyph-model";
import { needsYouCount } from "@/desktop/use-desktop-bridge";

import {
  ACK_LIMIT,
  attentionOf,
  ownsCiFailure,
  savedAcknowledgements,
  unseenAttention,
  useAttentionStore,
} from "./attention";
import { useThreadsStore } from "@/stores/threads";
import { nextNeedsYou, sectionOf, rollupOf } from "./grouping";

const pr = (overrides: Partial<PrStatus> = {}): PrStatus => ({
  number: 12,
  state: "OPEN",
  url: "https://github.com/o/r/pull/12",
  title: "Fix",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  headRefOid: "a1",
  ...overrides,
});

const summary = (
  id: string,
  status: ThreadStatus,
  prStatus: PrStatus | undefined,
  parked = false,
): ThreadSummary => ({
  status,
  pendingRequests: [],
  queue: [],
  thread: {
    id: id as ThreadId,
    projectId: "p" as ProjectId,
    title: id,
    userNamed: false,
    model: { agent: "claude", model: "opus" },
    mode: "default",
    checkout: { kind: "main", path: "/" },
    labels: [],
    pinned: false,
    parked,
    unread: false,
    createdAt: 0,
    lastActivityAt: 0,
  },
  ...(prStatus ? { git: { repo: true, pr: prStatus } as GitState } : {}),
});

const REVIEW = {
  bots: ["bot"],
  reviewedHead: true,
  roundInFlight: false,
  latestReviewId: "PRR_1",
  threads: { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 },
} as const;

beforeEach(() => {
  useAttentionStore.setState({ loaded: true, acknowledged: {}, ledgers: {} });
});

describe("attentionOf", () => {
  it("raises a red build or changes requested on an idle thread's open PR", () => {
    expect(attentionOf(summary("a", "idle", pr({ checks: "failing" })))).toMatchObject({
      reason: "ciFailed",
      key: "ci:12:a1",
    });
    const changes = pr({ review: { ...REVIEW, verdictOnHead: "changesRequested" } });
    expect(attentionOf(summary("a", "cold", changes))).toMatchObject({
      reason: "changesRequested",
      key: "review:12:PRR_1",
    });
  });

  it("asks for changes when the row's glyph does: open bot blockers too, not a round under way", () => {
    const blockers = pr({
      review: { ...REVIEW, threads: { ...REVIEW.threads, unresolved: 2, blockers: 2 } },
    });
    expect(prGlyphOf(prFactsOfBadge("o/r", 12, blockers)).kind).toBe("changes");
    expect(attentionOf(summary("a", "idle", blockers))?.reason).toBe("changesRequested");
    const reviewing = pr({
      review: { ...REVIEW, verdictOnHead: "changesRequested", roundInFlight: true },
    });
    expect(prGlyphOf(prFactsOfBadge("o/r", 12, reviewing)).kind).not.toBe("changes");
    expect(attentionOf(summary("a", "idle", reviewing))).toBeUndefined();
  });

  it("stays quiet while the agent works, when parked, and for green, merged or no PRs", () => {
    const red = pr({ checks: "failing" });
    expect(attentionOf(summary("a", "running", red))).toBeUndefined();
    expect(attentionOf(summary("a", "idle", red, true))).toBeUndefined();
    expect(attentionOf(summary("a", "idle", pr()))).toBeUndefined();
    expect(attentionOf(summary("a", "idle", pr({ checks: "pending" })))).toBeUndefined();
    const unrequired = pr({ checks: "failing", requiredChecks: "passing" });
    expect(attentionOf(summary("a", "idle", unrequired))).toBeUndefined();
    expect(attentionOf(summary("a", "idle", { ...red, state: "MERGED" }))).toBeUndefined();
    expect(attentionOf(summary("a", "idle", undefined))).toBeUndefined();
  });

  it("says nothing for an orchestrator, whose checkout's PR isn't one it drives", () => {
    const own = summary("o", "idle", pr({ checks: "failing" }));
    const orchestrator = { ...own, thread: { ...own.thread, role: "orchestrator" as const } };
    expect(attentionOf(orchestrator)).toBeUndefined();
    expect(sectionOf(orchestrator)).toBe("idle");
    expect(nextNeedsYou([orchestrator], undefined)).toBeUndefined();
    expect(needsYouCount([orchestrator])).toBe(0);
  });
});

describe("worker-owned CI across badges and notifications", () => {
  const W = "workspace" as WorkspaceId;
  const live = () => {
    const red = summary("worker", "idle", pr({ checks: "failing" }));
    return {
      ...red,
      thread: {
        ...red.thread,
        workspaceId: W,
        spawnedBy: { threadId: "orch" as ThreadId, feature: "fix" },
      },
    };
  };
  const setWorker = (over: Partial<WorkerLedgerEntry> = {}) =>
    useAttentionStore.getState().setLedger({
      workspaceId: W,
      features: [
        {
          feature: "fix",
          state: "inReview",
          workers: [
            {
              feature: "fix",
              threadId: "worker" as ThreadId,
              projectId: "p" as ProjectId,
              project: "r",
              title: "worker",
              state: "inReview",
              status: "idle",
              pendingRequests: [],
              changedFiles: 0,
              overlapsWith: [],
              userIntervened: false,
              messagesFromOrchestrator: 0,
              pr: { repo: "o/r", number: 12, checks: "failing", monitored: true },
              ...over,
            },
          ],
        },
      ],
      budget: { liveWorkers: 1, maxConcurrentWorkers: 4, costUsdToday: 0 },
      orchestratorEdits: 0,
      builtAt: 1,
    } satisfies OrchestratorLedger);

  it("removes monitored CI from the section, rollup navigation, count and away notice decision", () => {
    const red = live();
    expect(needsYouCount([red])).toBe(1);
    setWorker();
    expect(attentionOf(red)).toBeUndefined();
    expect(sectionOf(red)).toBe("idle");
    expect(nextNeedsYou([red], undefined)).toBeUndefined();
    expect(needsYouCount([red])).toBe(0);
    expect(ownsCiFailure(red, red.git!.pr!.url)).toBe(true);
    expect(ownsCiFailure(red, "https://github.com/other/repo/pull/12")).toBe(false);
    setWorker({ reportStands: true });
    expect(needsYouCount([red])).toBe(1);
    expect(ownsCiFailure(red, red.git!.pr!.url)).toBe(false);
  });

  it("keeps archived workers' unresolved CI in every count while parked solo threads stay parked", () => {
    setWorker({ state: "archived" });
    const red = live();
    const archived = { ...red, thread: { ...red.thread, parked: true } };
    expect(attentionOf(archived)?.reason).toBe("ciFailed");
    expect(sectionOf(archived)).toBe("needsYou");
    expect(rollupOf([archived])).toBe("needsYou");
    expect(needsYouCount([archived])).toBe(1);
    expect(nextNeedsYou([archived], undefined)).toBe(archived.thread.id);
    expect(ownsCiFailure(archived, archived.git!.pr!.url)).toBe(false);
    expect(needsYouCount([summary("solo", "idle", pr({ checks: "failing" }), true)])).toBe(0);
  });

  it("uses any live owner of a shared PR for the badge and away notice", () => {
    setWorker();
    const red = live();
    useThreadsStore.setState({ byId: { [red.thread.id]: red } });
    const twin = { ...red, thread: { ...red.thread, id: "twin" as ThreadId } };
    expect(ownsCiFailure(twin, red.git!.pr!.url)).toBe(true);
    expect(needsYouCount([twin, red])).toBe(0);
    useThreadsStore.setState({ byId: {} });
    expect(ownsCiFailure(twin, red.git!.pr!.url)).toBe(false);
  });

  it("keeps approval requests and questions actionable beside owned CI", () => {
    setWorker();
    const red = live();
    expect(needsYouCount([{ ...red, status: "needsApproval" }])).toBe(1);
    expect(needsYouCount([{ ...red, status: "needsInput" }])).toBe(1);
  });
});

describe("unseen attention", () => {
  it("lifts the thread into Needs you and the badge until it's seen", () => {
    const red = summary("red", "idle", pr({ checks: "failing" }));
    const quiet = summary("quiet", "idle", pr());
    expect(sectionOf(red)).toBe("needsYou");
    expect(sectionOf(quiet)).toBe("idle");
    expect(needsYouCount([red, quiet])).toBe(1);
    expect(nextNeedsYou([red, quiet], undefined)).toBe("red");

    useAttentionStore.getState().acknowledge(red.thread.id, "ci:12:a1");
    expect(unseenAttention(red)).toBeUndefined();
    expect(sectionOf(red)).toBe("idle");
    expect(needsYouCount([red, quiet])).toBe(0);
  });

  it("raises nothing until the saved acknowledgements load, then honours them", () => {
    const red = summary("red", "idle", pr({ checks: "failing" }));
    useAttentionStore.setState({ loaded: false, acknowledged: {} });
    expect(sectionOf(red)).toBe("idle");
    expect(needsYouCount([red])).toBe(0);

    useAttentionStore.getState().hydrate(["red ci:12:a1", "other review:3:PRR_9", "malformed"]);
    expect(useAttentionStore.getState().acknowledged).toEqual({
      red: "ci:12:a1",
      other: "review:3:PRR_9",
    });
    expect(unseenAttention(red)).toBeUndefined();
    expect(savedAcknowledgements(useAttentionStore.getState().acknowledged)).toEqual([
      "red ci:12:a1",
      "other review:3:PRR_9",
    ]);
  });

  it("keeps the most recent acknowledgements, one per thread", () => {
    for (let i = 0; i < ACK_LIMIT + 5; i++) {
      useAttentionStore.getState().acknowledge(`t${i}` as ThreadId, "ci:1:a");
    }
    expect(
      useAttentionStore.getState().acknowledge(`t${ACK_LIMIT + 4}` as ThreadId, "ci:1:a"),
    ).toBe(false);
    const saved = savedAcknowledgements(useAttentionStore.getState().acknowledged);
    expect(saved).toHaveLength(ACK_LIMIT);
    expect(saved.at(-1)).toBe(`t${ACK_LIMIT + 4} ci:1:a`);
  });

  it("raises again for a new head commit that fails", () => {
    useAttentionStore.getState().acknowledge("red" as ThreadId, "ci:12:a1");
    const rerun = summary("red", "idle", pr({ checks: "failing", headRefOid: "b2" }));
    expect(unseenAttention(rerun)?.key).toBe("ci:12:b2");
    expect(sectionOf(rerun)).toBe("needsYou");
  });
});
