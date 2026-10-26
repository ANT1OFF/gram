import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  USAGE_BREAKDOWN_THREADS,
  type ProjectId,
  type Thread,
  type ThreadId,
  type TurnId,
  type UsageBreakdown,
  type UsageOverview,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ThreadStore } from "../persistence/thread-store.ts";
import type { SqlClient } from "../platform/unstable.ts";
import { aggregateUsage, type UsageRecord } from "./aggregate.ts";
import { breakdownCollector, outsideProvider, type BreakdownThread } from "./breakdown.ts";
import { usageHandlers } from "./handler.ts";
import { mergeHistoryUsage } from "./history-merge.ts";
import type { HistoryRecord } from "./history-records.ts";

const NOW = Date.parse("2026-10-12T12:00:00Z");

const gram = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  id: "gram-turn",
  thread_id: "gram-thread",
  started_at: NOW - 1000,
  ended_at: NOW - 500,
  reason: "completed",
  agent: "claude",
  model: "invented-large",
  usage: JSON.stringify({
    tokens: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10 },
  }),
  ...overrides,
});
const cli = (overrides: Partial<HistoryRecord> = {}): HistoryRecord => ({
  provider: "codex",
  session: "terminal-session",
  id: "terminal-turn",
  nativeIds: ["terminal-turn"],
  model: "invented-codex",
  at: NOW - 2000,
  tokens: { inputTokens: 300, outputTokens: 30, cacheReadTokens: 200, cacheWriteTokens: 0 },
  complete: true,
  trusted: true,
  partial: false,
  parent: null,
  ...overrides,
});

/** Every counted token lands in exactly one workspace, Solo or Outside Gram. */
const conserves = (breakdown: UsageBreakdown, overview: UsageOverview) => {
  const sum =
    breakdown.workspaces.reduce((n, row) => n + row.totals.totalTokens, 0) +
    breakdown.solo.totals.totalTokens +
    breakdown.outside.reduce((n, row) => n + row.totals.totalTokens, 0);
  expect(sum).toBe(overview.totals.totalTokens);
};

describe("usage breakdown", () => {
  it("names a CLI-only session's provider and no Gram thread's", () => {
    expect(outsideProvider(JSON.stringify(["cli", "codex", "s"]))).toBe("codex");
    expect(outsideProvider(JSON.stringify(["cli", "claude", "s"]))).toBe("claude");
    expect(outsideProvider(JSON.stringify(["cli", "other", "s"]))).toBeUndefined();
    expect(outsideProvider('["cli",')).toBeUndefined();
    expect(outsideProvider("gram-thread")).toBeUndefined();
  });

  it("splits merged history into workspaces, Solo and Outside Gram, summing to the totals", () => {
    const merged = mergeHistoryUsage(
      [
        gram(),
        gram({ id: "solo-turn", thread_id: "solo-thread", model: "invented-small" }),
        gram({ id: "gone-turn", thread_id: "gone-thread" }),
      ],
      {
        records: [cli(), cli({ session: "second", id: "second", nativeIds: ["second"] })],
        sources: [],
        ambiguous: 0,
      },
    );
    const collector = breakdownCollector();
    const overview = aggregateUsage(merged.records, { days: 7 }, NOW, collector.onCounted);
    expect(collector.threadIds().toSorted()).toEqual(["gone-thread", "gram-thread", "solo-thread"]);
    const stored = new Map<string, BreakdownThread>([
      ["gram-thread", { title: "Invented worker", workspaceId: "ws-1", role: null }],
      ["solo-thread", { title: "Invented solo", workspaceId: null, role: null }],
    ]);
    const breakdown = collector.build(stored, new Map([["ws-1", "Invented workspace"]]));
    expect(breakdown.workspaces).toEqual([
      {
        workspaceId: "ws-1",
        name: "Invented workspace",
        threads: 1,
        totals: expect.objectContaining({ totalTokens: 180 }),
        models: [{ provider: "claude", model: "invented-large", totalTokens: 180 }],
      },
    ]);
    // A thread no longer stored keeps its id, untitled, in Solo.
    expect(breakdown.solo).toMatchObject({ threads: 2, totals: { totalTokens: 360 } });
    expect(breakdown.threads.find((row) => row.threadId === "gone-thread")).toMatchObject({
      title: null,
      workspaceId: null,
      role: "solo",
    });
    expect(breakdown.threads.find((row) => row.threadId === "gram-thread")).toMatchObject({
      title: "Invented worker",
      role: "worker",
    });
    // Codex input already includes its cache: 300 in + 30 out per session.
    expect(breakdown.outside).toEqual([
      {
        provider: "codex",
        sessions: 2,
        totals: expect.objectContaining({ totalTokens: 660, cacheReadTokens: 400 }),
        models: [{ provider: "codex", model: "invented-codex", totalTokens: 660 }],
      },
    ]);
    conserves(breakdown, overview);
  });

  it("follows the provider filter, and a Gram turn matched to history stays in its thread", () => {
    const merged = mergeHistoryUsage(
      [
        gram({
          agent: "codex",
          model: null,
          source_session: "terminal-session",
          native_ids: '["terminal-turn"]',
          usage: JSON.stringify({ tokens: { inputTokens: 300, outputTokens: 30 } }),
        }),
      ],
      { records: [cli()], sources: [], ambiguous: 0 },
    );
    for (const provider of ["codex", "claude"] as const) {
      const collector = breakdownCollector();
      const overview = aggregateUsage(
        merged.records,
        { days: 7, provider },
        NOW,
        collector.onCounted,
      );
      const breakdown = collector.build(new Map(), new Map());
      expect(breakdown.outside).toEqual([]);
      expect(breakdown.solo.threads).toBe(provider === "codex" ? 1 : 0);
      conserves(breakdown, overview);
    }
  });
});

const withStore = <A, E>(effect: Effect.Effect<A, E, ThreadStore | SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie)));

const storedThread =
  (projectId: ProjectId) =>
  (id: string, extra: Partial<Thread> = {}): Thread => ({
    id: id as ThreadId,
    projectId,
    title: `Invented ${id}`,
    model: { agent: "claude", model: "current-selection-is-not-history" },
    userNamed: false,
    mode: "default",
    checkout: { kind: "main", path: "/invented/repo" },
    labels: [],
    pinned: false,
    parked: false,
    unread: false,
    createdAt: 1,
    lastActivityAt: 1,
    ...extra,
  });

/** A workspace as the store writes it: the name lives under `workspace`, not at the top. */
const storedWorkspace = (id: string, name: string, projectId: ProjectId): WorkspaceState => ({
  workspace: {
    id: id as WorkspaceId,
    name,
    projectIds: [projectId],
    homeProjectId: projectId,
    createdAt: 1,
  },
  charter: DEFAULT_CHARTER,
});

/** Records one completed turn through the store, as a running thread would. */
const turnRecorder = () => {
  let seq = 0;
  return (
    threadId: string,
    input: number,
    { agent = "claude", ago = 0 }: { agent?: "claude" | "codex"; ago?: number } = {},
  ) =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const tid = `turn-${++seq}` as TurnId;
      yield* store.startTurn(threadId as ThreadId, tid, NOW - ago - 1000 - seq);
      yield* store.upsertMessage(
        threadId as ThreadId,
        {
          id: `reply-${seq}`,
          role: "assistant",
          parts: [{ type: "text", text: "Invented content never in the aggregate" }],
          metadata: { agent, model: agent === "codex" ? "invented-codex" : "invented-large" },
        },
        tid,
      );
      yield* store.endTurn(tid, {
        endedAt: NOW - ago - 500,
        reason: "completed",
        usage: { tokens: { inputTokens: input, outputTokens: 0 } },
      });
    });
};

const DAY = 24 * 60 * 60 * 1000;
const inWs = (id: string) => ({ workspaceId: id as WorkspaceId });

describe("usage breakdown through the stored threads", () => {
  it.effect(
    "names threads and workspaces as stored, open or closed, and keeps the top threads",
    () =>
      withStore(
        Effect.gen(function* () {
          yield* TestClock.setTime(NOW);
          const store = yield* ThreadStore;
          const project = yield* store.ensureProject({ root: "/invented/repo", name: "Invented" });
          const thread = storedThread(project.id);
          yield* store.putWorkspace(storedWorkspace("ws-1", "Invented workspace", project.id));
          const workspaceId = "ws-1" as WorkspaceId;
          yield* store.insertThread(thread("orch", { role: "orchestrator", workspaceId }));
          yield* store.insertThread(thread("worker", { workspaceId }));
          for (let i = 0; i < USAGE_BREAKDOWN_THREADS + 2; i++)
            yield* store.insertThread(thread(`solo-${i}`));
          const turn = turnRecorder();
          yield* turn("orch", 5_000);
          yield* turn("worker", 3_000);
          for (let i = 0; i < USAGE_BREAKDOWN_THREADS + 2; i++) yield* turn(`solo-${i}`, 10 + i);
          const handler = yield* usageHandlers;
          const data = yield* handler["app.usageOverview"]({ days: 1 });
          const breakdown = data.breakdown!;
          expect(breakdown.workspaces).toEqual([
            expect.objectContaining({
              workspaceId: "ws-1",
              name: "Invented workspace",
              threads: 2,
              totals: expect.objectContaining({ totalTokens: 8_000 }),
            }),
          ]);
          expect(breakdown.solo.threads).toBe(USAGE_BREAKDOWN_THREADS + 2);
          expect(breakdown.threads).toHaveLength(USAGE_BREAKDOWN_THREADS);
          expect(breakdown.threads.slice(0, 3)).toEqual([
            expect.objectContaining({
              threadId: "orch",
              title: "Invented orch",
              role: "orchestrator",
            }),
            expect.objectContaining({ threadId: "worker", role: "worker", workspaceId: "ws-1" }),
            expect.objectContaining({
              threadId: `solo-${USAGE_BREAKDOWN_THREADS + 1}`,
              role: "solo",
            }),
          ]);
          conserves(breakdown, data);
          expect(JSON.stringify(data)).not.toMatch(/Invented content/);
          // A closed thread is still named from the closed list.
          yield* store.closeThread("worker" as ThreadId, NOW);
          expect((yield* handler["app.usageOverview"]({ days: 1 })).breakdown).toEqual(breakdown);
        }),
      ),
  );

  it.effect(
    "names each live workspace and keeps each removed one apart, in every period and provider",
    () =>
      withStore(
        Effect.gen(function* () {
          yield* TestClock.setTime(NOW);
          const store = yield* ThreadStore;
          const project = yield* store.ensureProject({ root: "/invented/repo", name: "Invented" });
          const thread = storedThread(project.id);
          for (const [id, name] of [
            ["ws-alpha", "Invented alpha"],
            ["ws-beta", "Invented beta"],
            ["ws-gone-1", "Invented gone one"],
            ["ws-gone-2", "Invented gone two"],
          ] as const)
            yield* store.putWorkspace(storedWorkspace(id, name, project.id));
          yield* store.insertThread(
            thread("alpha-orch", { role: "orchestrator", ...inWs("ws-alpha") }),
          );
          yield* store.insertThread(thread("alpha-worker", inWs("ws-alpha")));
          yield* store.insertThread(
            thread("beta-orch", { role: "orchestrator", ...inWs("ws-beta") }),
          );
          yield* store.insertThread(thread("gone-1-worker", inWs("ws-gone-1")));
          yield* store.insertThread(thread("gone-2-worker", inWs("ws-gone-2")));
          yield* store.insertThread(thread("solo"));
          const turn = turnRecorder();
          yield* turn("alpha-orch", 6_000);
          yield* turn("alpha-worker", 4_000, { agent: "codex" });
          yield* turn("beta-orch", 3_000, { ago: 3 * DAY });
          yield* turn("gone-1-worker", 2_000, { agent: "codex", ago: 20 * DAY });
          yield* turn("gone-2-worker", 1_000, { ago: 60 * DAY });
          yield* turn("solo", 500);
          // Truly removed: the rows are gone, the threads that ran in them stay.
          yield* store.removeWorkspace("ws-gone-1" as WorkspaceId);
          yield* store.removeWorkspace("ws-gone-2" as WorkspaceId);

          const handler = yield* usageHandlers;
          const grouped = (days: 1 | 7 | 30 | 90, provider?: "claude" | "codex") =>
            handler["app.usageOverview"](
              provider === undefined ? { days } : { days, provider },
            ).pipe(
              Effect.map((data) => {
                conserves(data.breakdown!, data);
                return {
                  workspaces: data.breakdown!.workspaces.map((w) => ({
                    id: w.workspaceId,
                    name: w.name,
                    threads: w.threads,
                    tokens: w.totals.totalTokens,
                  })),
                  solo: data.breakdown!.solo.totals.totalTokens,
                };
              }),
            );
          const alpha = { id: "ws-alpha", name: "Invented alpha", threads: 2, tokens: 10_000 };
          const beta = { id: "ws-beta", name: "Invented beta", threads: 1, tokens: 3_000 };
          const gone1 = { id: "ws-gone-1", name: null, threads: 1, tokens: 2_000 };
          const gone2 = { id: "ws-gone-2", name: null, threads: 1, tokens: 1_000 };

          expect(yield* grouped(1)).toEqual({ workspaces: [alpha], solo: 500 });
          expect(yield* grouped(7)).toEqual({ workspaces: [alpha, beta], solo: 500 });
          expect(yield* grouped(30)).toEqual({ workspaces: [alpha, beta, gone1], solo: 500 });
          expect(yield* grouped(90)).toEqual({
            workspaces: [alpha, beta, gone1, gone2],
            solo: 500,
          });
          expect(yield* grouped(90, "claude")).toEqual({
            workspaces: [
              { ...alpha, threads: 1, tokens: 6_000 },
              beta,
              { ...gone2, tokens: 1_000 },
            ],
            solo: 500,
          });
          expect(yield* grouped(90, "codex")).toEqual({
            workspaces: [{ ...alpha, threads: 1, tokens: 4_000 }, gone1],
            solo: 0,
          });
          expect(yield* grouped(1, "codex")).toEqual({
            workspaces: [{ ...alpha, threads: 1, tokens: 4_000 }],
            solo: 0,
          });
        }),
      ),
  );
});
