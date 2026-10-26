import { describe, expect, it } from "@effect/vitest";
import {
  applySettingsPatch,
  planSettingsChanges,
  CLOSED_THREADS_LIMIT,
  DEFAULT_CHARTER,
  DEFAULT_SETTINGS,
  Settings,
  settingsPatchPaths,
  ThreadNotFound,
  type Dream,
  type DreamId,
  type DreamWatermark,
  type LabelId,
  type ProjectId,
  type RequestId,
  type Thread,
  type ThreadId,
  type TurnId,
  type WorkerReport,
  type Workspace,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "../platform/unstable.ts";
import { decodeMended } from "./stored.ts";
import { ThreadStore } from "./thread-store.ts";

const TABLES = [
  "labels",
  "messages",
  "palettes",
  "profiles",
  "projects",
  "requests",
  "settings",
  "tasks",
  "threads",
  "turns",
];

const listTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
  return rows.map((r) => r.name);
});

const thread = (projectId: string, overrides: Partial<Thread> = {}): Thread =>
  ({
    id: "t1",
    projectId,
    title: "rewrite",
    userNamed: false,
    model: { agent: "claude", model: "opus" },
    mode: "default",
    checkout: { kind: "main", path: "/work/repo" },
    labels: [],
    pinned: false,
    parked: false,
    unread: false,
    createdAt: 1,
    lastActivityAt: 1,
    ...overrides,
  }) as Thread;

const withStore = <A, E>(effect: Effect.Effect<A, E, ThreadStore | SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie)));

/** The messages and turns kept for a closed thread. */
const keptCounts = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [messages] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM closed_messages
      WHERE thread_id = ${threadId}`;
    const [turns] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM closed_turns
      WHERE thread_id = ${threadId}`;
    return [Number(messages?.n), Number(turns?.n)];
  }).pipe(Effect.orDie);

describe("migrations", () => {
  it.effect("create every table on a temp database and are idempotent", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-db-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      const file = join(dir, "gram.db");

      const first = yield* listTables.pipe(Effect.provide(ThreadStore.layerSqlite(file)));
      expect(first).toEqual(expect.arrayContaining(TABLES));

      // A second boot against the same file must not re-run or fail.
      const second = yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        yield* store.putSettings(DEFAULT_SETTINGS);
        return yield* listTables;
      }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
      expect(second.toSorted()).toEqual(first.toSorted());

      // Commits don't sync the WAL: the event loop waits on no disk flush per write. The page
      // cache and the mapped reads are sized up from SQLite's defaults (-2000, 0).
      const pragmas = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [sync] = yield* sql<{ synchronous: number }>`PRAGMA synchronous`;
        const [journal] = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`;
        const [cache] = yield* sql<{ cache_size: number }>`PRAGMA cache_size`;
        const [mmap] = yield* sql<{ mmap_size: number }>`PRAGMA mmap_size`;
        return {
          synchronous: sync?.synchronous,
          journal: journal?.journal_mode,
          cacheSize: cache?.cache_size,
          mmapSize: mmap?.mmap_size,
        };
      }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
      expect(pragmas).toEqual({
        synchronous: 1,
        journal: "wal",
        cacheSize: -16_384,
        mmapSize: 64 * 1024 * 1024,
      });
    }),
  );
});

describe("ThreadStore", () => {
  it.effect("a corrupt local check disables only that project's gate, not project listing", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const sql = yield* SqlClient.SqlClient;
        const project = yield* store.ensureProject({ root: "/work/bad-check", name: "bad-check" });
        const other = yield* store.ensureProject({ root: "/work/healthy", name: "healthy" });
        for (const value of ["{broken", '{"command":42}', '{"command":"test","timeoutMs":-1}']) {
          yield* sql`UPDATE projects SET local_check = ${value} WHERE id = ${project.id}`;
          const projects = yield* store.listProjects;
          expect(projects).toHaveLength(2);
          expect(projects.find((p) => p.id === project.id)?.localCheck).toBeUndefined();
          expect(projects.find((p) => p.id === other.id)).toEqual(other);
        }
      }),
    ),
  );
  it.effect("reuses a project per root", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const a = yield* store.ensureProject({ root: "/work/repo", name: "repo" });
        const b = yield* store.ensureProject({ root: "/work/repo", name: "other" });
        expect(b).toEqual(a);
        expect(yield* store.listProjects).toHaveLength(1);
        // Only the call that inserted the row says it created it.
        expect(yield* store.registerProject({ root: "/work/repo", name: "repo" })).toEqual({
          project: a,
          created: false,
        });
        const next = yield* store.registerProject({ root: "/work/next", name: "next" });
        expect(next).toMatchObject({ project: { root: "/work/next" }, created: true });
        // A trailing separator or a `.` is the same folder, whichever spelling came first.
        expect(yield* store.ensureProject({ root: "/work/./next/", name: "next" })).toEqual(
          next.project,
        );
        expect(
          (yield* store.registerProject({ root: "/work/third/", name: "third" })).project,
        ).toMatchObject({ root: "/work/third" });
        expect(yield* store.listProjects).toHaveLength(3);
      }),
    ),
  );

  describe.skipIf(process.platform !== "win32")("on Windows", () => {
    it.effect("is one project however a root's separators, case and drive letter are spelled", () =>
      withStore(
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const first = yield* store.ensureProject({
            root: "c:/Git/aws_multi_account/",
            name: "a",
          });
          expect(first.root).toBe("C:\\Git\\aws_multi_account");
          for (const root of ["C:\\git\\aws_multi_account", "C:/GIT/AWS_MULTI_ACCOUNT"]) {
            expect(yield* store.ensureProject({ root, name: "a" }), root).toEqual(first);
          }
          yield* store.setProjectBookmarked(first.id, true);
          expect(yield* store.listProjects).toMatchObject([
            { id: first.id, root: "C:\\Git\\aws_multi_account", bookmarked: true },
          ]);
        }),
      ),
    );
  });

  it.effect("bookmarks a project and refuses an unknown one", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const project = yield* store.ensureProject({ root: "/work/repo", name: "repo" });
        expect(project.bookmarked).toBe(false);

        expect((yield* store.setProjectBookmarked(project.id, true)).bookmarked).toBe(true);
        expect((yield* store.listProjects)[0]?.bookmarked).toBe(true);
        expect((yield* store.setProjectBookmarked(project.id, false)).bookmarked).toBe(false);

        const error = yield* store
          .setProjectBookmarked("missing" as ProjectId, true)
          .pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "NotFound", entity: "project", id: "missing" });
      }),
    ),
  );

  it.effect("forgets a project only while no thread belongs to it", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const busy = yield* store.ensureProject({ root: "/work/busy", name: "busy" });
        const idle = yield* store.ensureProject({ root: "/work/idle", name: "idle" });
        yield* store.insertThread(thread(busy.id));

        const refused = yield* store.forgetProject(busy.id).pipe(Effect.flip);
        expect(refused).toMatchObject({
          _tag: "InvalidState",
          message: "Close the threads in busy before removing it from recents.",
        });
        yield* store.forgetProject(idle.id);
        expect((yield* store.listProjects).map((p) => p.name)).toEqual(["busy"]);

        const missing = yield* store.forgetProject(idle.id).pipe(Effect.flip);
        expect(missing).toMatchObject({ _tag: "NotFound", entity: "project", id: idle.id });
      }),
    ),
  );

  it.effect("round-trips threads, messages, turns and requests", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const project = yield* store.ensureProject({ root: "/work/repo", name: "repo" });
        const id = "t1" as ThreadId;
        yield* store.insertThread(thread(project.id));
        const renamed = yield* store.updateThread(id, (t) => ({ ...t, title: "renamed" }));
        expect((yield* store.getThread(id)).title).toBe("renamed");
        expect(renamed.title).toBe("renamed");

        // Whoever writes `boundPr`, a PR keeps one row: the matching extra goes with the write.
        const bound = yield* store.updateThread(id, (t) => ({
          ...t,
          boundPr: { repo: "o/r", number: 4, monitor: false },
          extraPrs: [
            { repo: "O/R", number: 4, monitor: true },
            { repo: "o/other", number: 7, monitor: false },
          ],
        }));
        expect(bound.extraPrs).toEqual([{ repo: "o/other", number: 7, monitor: false }]);
        expect((yield* store.getThread(id)).extraPrs).toEqual(bound.extraPrs);

        const error = yield* store.getThread("missing" as ThreadId).pipe(Effect.flip);
        expect(error).toBeInstanceOf(ThreadNotFound);

        const user = { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] };
        const reply = { id: "a1", role: "assistant", parts: [] };
        yield* store.upsertMessage(id, user as never);
        yield* store.upsertMessage(id, reply as never);
        yield* store.upsertMessage(id, {
          ...reply,
          parts: [{ type: "text", text: "yo" }],
        } as never);
        const messages = yield* store.listMessages(id);
        expect(messages.map((m) => m.id)).toEqual(["u1", "a1"]);
        expect(messages[1]?.parts).toEqual([{ type: "text", text: "yo" }]);
        yield* store.upsertMessage(id, { ...user, id: "u2" } as never);
        expect((yield* store.listUserMessages(id)).map((m) => m.id)).toEqual(["u1", "u2"]);

        // The text parts of the messages holding a needle, a backslash path matched as stored.
        yield* store.upsertMessage(id, {
          id: "a2",
          role: "assistant",
          parts: [
            { type: "text", text: "Wrote C:\\tmp\\r.md" },
            {
              type: "dynamic-tool",
              toolName: "Read",
              toolCallId: "c",
              state: "input-available",
              input: { path: "/etc/hosts" },
            },
          ],
        } as never);
        expect(yield* store.messageTextsWith(id, ["C:\\tmp\\r.md", "yo"])).toEqual([
          "yo",
          "Wrote C:\\tmp\\r.md",
        ]);
        // A tool's input matches the row but is no text part, so what comes back never holds it.
        expect(yield* store.messageTextsWith(id, ["/etc/hosts"])).toEqual(["Wrote C:\\tmp\\r.md"]);
        expect(yield* store.messageTextsWith(id, ["nowhere"])).toEqual([]);

        const turnId = "turn1" as TurnId;
        yield* store.startTurn(id, turnId, 10);
        yield* store.endTurn(turnId, { endedAt: 20, reason: "interrupted" });
        expect(yield* store.listTurns(id)).toEqual([
          { id: turnId, threadId: id, startedAt: 10, endedAt: 20, reason: "interrupted" },
        ]);

        // The latest ended turn that reported usage; a later turn without usage, or one still open,
        // doesn't hide it.
        expect(yield* store.lastTurnUsage(id)).toBeUndefined();
        const usage = { tokens: { inputTokens: 1200, outputTokens: 80 }, contextWindow: 200_000 };
        yield* store.startTurn(id, "turn2" as TurnId, 30);
        yield* store.endTurn("turn2" as TurnId, { endedAt: 40, reason: "completed", usage });
        yield* store.startTurn(id, "turn3" as TurnId, 50);
        yield* store.endTurn("turn3" as TurnId, { endedAt: 60, reason: "interrupted" });
        yield* store.startTurn(id, "turn4" as TurnId, 70);
        expect(yield* store.lastTurnUsage(id)).toEqual(usage);
        // The last turn to start is the open one, from the moment it is written.
        expect(yield* store.lastTurn(id)).toEqual({
          id: "turn4",
          threadId: id,
          startedAt: 70,
          endedAt: undefined,
          reason: undefined,
        });

        // Boot closes what a crash left open, and leaves ended turns as they were.
        expect(yield* store.closeOpenTurns(80)).toEqual([
          { id: "turn4", threadId: id, startedAt: 70, endedAt: 80, reason: "interrupted" },
        ]);
        expect(yield* store.closeOpenTurns(90)).toEqual([]);
        expect((yield* store.listTurns(id)).map((t) => [t.id, t.endedAt, t.reason])).toEqual([
          [turnId, 20, "interrupted"],
          ["turn2", 40, "completed"],
          ["turn3", 60, "interrupted"],
          ["turn4", 80, "interrupted"],
        ]);
        expect(yield* store.lastTurnUsage(id)).toEqual(usage);
        // Opened after the clock moved back: still the last turn, which `started_at` wouldn't say.
        yield* store.startTurn(id, "turn5" as TurnId, 5);
        yield* store.endTurn("turn5" as TurnId, { endedAt: 6, reason: "error" });
        expect((yield* store.lastTurn(id))?.id).toBe("turn5");

        const request = {
          kind: "question" as const,
          id: "r1" as RequestId,
          questions: [],
        };
        yield* store.putRequest(id, request, 30);
        expect(yield* store.listRequests(id)).toEqual([request]);
        expect(yield* store.removeRequest(id, request.id)).toBe(true);
        expect(yield* store.removeRequest(id, request.id)).toBe(false);
      }),
    ),
  );

  it.effect(
    "keeps a closed thread's conversation for a reopen until it leaves the closed list",
    () =>
      withStore(
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const project = yield* store.ensureProject({ root: "/work/repo", name: "repo" });
          const closeWithHistory = (id: string, closedAt: number) =>
            Effect.gen(function* () {
              const closing = thread(project.id, { id: id as ThreadId });
              yield* store.insertThread(closing);
              yield* store.upsertMessage(closing.id, {
                id: `${id}-m`,
                role: "user",
                parts: [{ type: "text", text: "hi" }],
              });
              yield* store.startTurn(closing.id, `${id}-turn` as TurnId, closedAt);
              yield* store.closeThread(closing.id, closedAt);
              return closing;
            });

          const first = yield* closeWithHistory("t-first", 0);
          expect(yield* store.getThread(first.id).pipe(Effect.flip)).toBeInstanceOf(ThreadNotFound);
          expect(yield* store.listMessages(first.id)).toEqual([]);
          expect(yield* keptCounts(first.id)).toEqual([1, 1]);
          expect((yield* store.listClosedMessages(first.id)).map((m) => m.id)).toEqual([
            "t-first-m",
          ]);
          // A second close of the same thread, from another window say, finds no live row.
          yield* store.closeThread(first.id, 5);
          expect(yield* keptCounts(first.id)).toEqual([1, 1]);
          expect((yield* store.listClosed).find((c) => c.thread.id === first.id)?.closedAt).toBe(0);

          // Reopened under its id, the conversation and turn are its own again.
          yield* store.insertThread(first);
          yield* store.restoreClosedHistory(first.id);
          expect((yield* store.listMessages(first.id)).map((m) => m.id)).toEqual(["t-first-m"]);
          expect((yield* store.listTurns(first.id)).map((t) => t.id)).toEqual(["t-first-turn"]);
          expect(yield* keptCounts(first.id)).toEqual([0, 0]);

          // Past the limit the oldest entry goes, and its kept conversation with it.
          yield* store.closeThread(first.id, 0);
          for (let i = 1; i <= CLOSED_THREADS_LIMIT; i++) yield* closeWithHistory(`t-${i}`, i);
          expect((yield* store.listClosed).map((c) => c.thread.id)).not.toContain("t-first");
          expect(yield* keptCounts(first.id)).toEqual([0, 0]);
          expect(yield* keptCounts(`t-${CLOSED_THREADS_LIMIT}`)).toEqual([1, 1]);
        }),
      ),
  );

  it.effect(
    "drops kept conversations that left the closed list without a reopen when it starts",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "gram-store-closed-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        );
        const layer = ThreadStore.layerSqlite(join(dir, "gram.db")).pipe(Layer.orDie);

        yield* Effect.gen(function* () {
          const store = yield* ThreadStore;
          const project = yield* store.ensureProject({ root: "/work/repo", name: "repo" });
          for (const id of ["t-listed", "t-taken"]) {
            const closing = thread(project.id, { id: id as ThreadId });
            yield* store.insertThread(closing);
            yield* store.upsertMessage(closing.id, { id: `${id}-m`, role: "user", parts: [] });
            yield* store.updatePlan(closing.id, () => ({
              plan: { goal: id, steps: [], basis: "", updatedAt: 1, updatedBy: "agent" },
              turnPlan: [{ content: "Push", status: "pending" }],
            }));
            yield* store.closeThread(closing.id, 1);
          }
          // Taken off the list by ⌘⇧T, but its folder was gone, so it never came back.
          yield* store.forgetClosed("t-taken" as ThreadId);
          expect(yield* keptCounts("t-taken")).toEqual([1, 0]);
        }).pipe(Effect.provide(layer));

        yield* Effect.gen(function* () {
          const store = yield* ThreadStore;
          expect(yield* keptCounts("t-listed")).toEqual([1, 0]);
          expect(yield* keptCounts("t-taken")).toEqual([0, 0]);
          // A closed thread keeps its plan for a reopen; one that can't come back doesn't.
          expect(yield* store.getPlan("t-listed" as ThreadId)).toMatchObject({
            plan: { goal: "t-listed" },
            turnPlan: [{ content: "Push" }],
          });
          expect(yield* store.getPlan("t-taken" as ThreadId)).toEqual({
            plan: undefined,
            turnPlan: undefined,
          });
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
  );

  it.effect("falls back to default settings and stores entities", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        expect(yield* store.getSettings).toEqual(DEFAULT_SETTINGS);
        expect((yield* store.getSettings).appearance).toMatchObject({
          look: "glass",
          paletteId: "neutral-dark",
          mode: "dark",
        });
        const next = { ...DEFAULT_SETTINGS, logLevel: "debug" as const };
        yield* store.putSettings(next);
        expect(yield* store.getSettings).toEqual(next);

        const label = { id: "l1" as LabelId, name: "Urgent", color: "#f00" };
        yield* store.upsertLabel(label);
        yield* store.upsertLabel({ ...label, name: "Later" });
        expect(yield* store.listLabels).toEqual([{ ...label, name: "Later" }]);
        yield* store.removeLabel(label.id);
        const missing = yield* store.removeLabel(label.id).pipe(Effect.flip);
        expect(missing).toMatchObject({ _tag: "NotFound", entity: "label" });
      }),
    ),
  );
});

const report = (threadId: string, at: number): WorkerReport => ({
  threadId: threadId as ThreadId,
  state: "progress",
  summary: `at ${at}`,
  at,
});

/** The slot column beside the slot in the JSON; they must never differ. */
const slot = (id: WorkspaceId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ThreadStore;
    const [row] = yield* sql<{
      orchestrator_thread_id: string | null;
    }>`SELECT orchestrator_thread_id FROM workspaces WHERE id = ${id}`.pipe(Effect.orDie);
    const stored = (yield* store.getWorkspace(id)).workspace.orchestratorThreadId;
    expect(row?.orchestrator_thread_id ?? undefined).toBe(stored);
    return stored;
  });

const watermark = (threadId: string, throughSeq: number): DreamWatermark => ({
  threadId: threadId as ThreadId,
  throughSeq,
  throughId: `m${throughSeq}`,
  readAt: throughSeq,
});

describe("ThreadStore orchestration", () => {
  const workspaceId = "w1" as WorkspaceId;
  const state = (projectId: ProjectId, overrides: Partial<Workspace> = {}): WorkspaceState => ({
    workspace: {
      id: workspaceId,
      name: "Shop",
      projectIds: [projectId],
      homeProjectId: projectId,
      createdAt: 1,
      ...overrides,
    },
    charter: DEFAULT_CHARTER,
  });
  it.effect("stores, updates, lists and removes workspaces", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const project = yield* store.ensureProject({ root: "/work/repo", name: "repo" });
        expect(yield* store.listWorkspaces).toEqual([]);
        expect((yield* store.getWorkspace(workspaceId).pipe(Effect.flip)).entity).toBe("workspace");

        yield* store.putWorkspace(state(project.id));
        yield* store.putWorkspace({
          ...state(project.id, { id: "w2" as WorkspaceId, name: "Later", createdAt: 2 }),
          paused: { reason: "user", at: 3 },
        });
        expect((yield* store.listWorkspaces).map((w) => w.workspace.name)).toEqual([
          "Shop",
          "Later",
        ]);
        expect(yield* store.getWorkspace(workspaceId)).toEqual(state(project.id));

        const renamed = yield* store.updateWorkspace(workspaceId, (w) => ({
          ...w,
          workspace: { ...w.workspace, name: "Storefront" },
          charter: { ...w.charter, maxConcurrentWorkers: 2 },
        }));
        expect(renamed.workspace.name).toBe("Storefront");
        expect(yield* store.getWorkspace(workspaceId)).toEqual(renamed);
        expect(
          (yield* store.updateWorkspace("nope" as WorkspaceId, (w) => w).pipe(Effect.flip))._tag,
        ).toBe("NotFound");

        yield* store.addWorkerReport(workspaceId, report("t9", 1));
        yield* store.putOutbox(workspaceId, "{}");
        yield* store.appendOrchestrationEvent(workspaceId, { at: 1, kind: "wake", data: {} });
        yield* store.removeWorkspace(workspaceId);
        expect((yield* store.listWorkspaces).map((w) => w.workspace.id)).toEqual(["w2"]);
        expect(yield* store.listWorkerReports(workspaceId)).toEqual([]);
        expect(yield* store.getOutbox(workspaceId)).toBeUndefined();
        expect(yield* store.listOrchestrationEvents(workspaceId, 0)).toEqual([]);
        expect((yield* store.removeWorkspace(workspaceId).pipe(Effect.flip))._tag).toBe("NotFound");
      }),
    ),
  );

  it.effect("gives the slot to one of two claims, and repairs a slot naming a missing thread", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const project = yield* store.ensureProject({ root: "/work/repo", name: "repo" });
        const [a, b, c] = ["a", "b", "c"].map((id) => id as ThreadId);
        yield* store.insertThread(thread(project.id, { id: a! }));
        yield* store.insertThread(thread(project.id, { id: b! }));
        yield* store.putWorkspace(state(project.id));

        expect(yield* store.claimOrchestratorSlot("nope" as WorkspaceId, a!)).toBe(false);
        expect(yield* store.claimOrchestratorSlot(workspaceId, c!)).toBe(false);
        expect(yield* slot(workspaceId)).toBeUndefined();

        const claims = yield* Effect.all(
          [
            store.claimOrchestratorSlot(workspaceId, a!),
            store.claimOrchestratorSlot(workspaceId, b!),
          ],
          { concurrency: "unbounded" },
        );
        expect(claims.filter(Boolean)).toHaveLength(1);
        const winner = claims[0] ? a! : b!;
        const loser = claims[0] ? b! : a!;
        expect(yield* slot(workspaceId)).toBe(winner);
        expect(yield* store.claimOrchestratorSlot(workspaceId, winner)).toBe(true);
        expect(yield* store.claimOrchestratorSlot(workspaceId, loser)).toBe(false);
        expect((yield* store.removeWorkspace(workspaceId).pipe(Effect.flip))._tag).toBe(
          "InvalidState",
        );

        yield* store.releaseOrchestratorSlot(loser);
        expect(yield* slot(workspaceId)).toBe(winner);
        yield* store.releaseOrchestratorSlot(winner);
        expect(yield* slot(workspaceId)).toBeUndefined();

        // A slot left naming a thread that is gone, as a crash between two writes could leave it.
        yield* store.putWorkspace(state(project.id, { orchestratorThreadId: "ghost" as ThreadId }));
        expect(yield* slot(workspaceId)).toBe("ghost");
        expect(yield* store.claimOrchestratorSlot(workspaceId, loser)).toBe(true);
        expect(yield* slot(workspaceId)).toBe(loser);
        expect((yield* store.getWorkspace(workspaceId)).charter).toEqual(DEFAULT_CHARTER);

        yield* store.putWorkspace(state(project.id, { orchestratorThreadId: "ghost" as ThreadId }));
        yield* store.removeWorkspace(workspaceId);
      }),
    ),
  );

  for (const how of ["removeThread", "closeThread"] as const) {
    it.effect(
      `${how} empties the slot, detaches the workers and settles the thread's reports`,
      () =>
        withStore(
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const project = yield* store.ensureProject({ root: "/work/repo", name: "repo" });
            const [boss, worker, other] = ["boss", "worker", "other"].map((id) => id as ThreadId);
            yield* store.insertThread(
              thread(project.id, { id: boss!, role: "orchestrator", workspaceId }),
            );
            yield* store.insertThread(
              thread(project.id, {
                id: worker!,
                workspaceId,
                spawnedBy: { threadId: boss!, feature: "cart" },
              }),
            );
            yield* store.insertThread(
              thread(project.id, {
                id: other!,
                workspaceId,
                spawnedBy: { threadId: "someone-else" as ThreadId, feature: "cart" },
              }),
            );
            let closedAt = 1;
            const end = (id: ThreadId) =>
              how === "closeThread" ? store.closeThread(id, closedAt) : store.removeThread(id);
            yield* store.putWorkspace(state(project.id));
            expect(yield* store.claimOrchestratorSlot(workspaceId, boss!)).toBe(true);
            yield* store.addWorkerReport(workspaceId, report(worker!, 1));
            yield* store.addWorkerReport(workspaceId, report(other!, 2));

            const reporters = () =>
              store
                .listWorkerReports(workspaceId)
                .pipe(Effect.map((records) => records.map((r) => r.report.threadId)));
            yield* end(worker!);
            // A closed worker's reports wait for its reopen, and go once it leaves the closed list.
            expect(yield* reporters()).toEqual(how === "closeThread" ? [worker, other] : [other]);
            if (how === "closeThread") {
              for (let i = 0; i < CLOSED_THREADS_LIMIT; i++) {
                yield* store.rememberClosed(
                  thread(project.id, { id: `filler-${i}` as ThreadId }),
                  2 + i,
                );
              }
              expect(yield* reporters()).toEqual([other]);
              closedAt = 100;
            }
            expect(yield* slot(workspaceId)).toBe(boss);

            yield* end(boss!);
            expect(yield* slot(workspaceId)).toBeUndefined();
            // What a reopen needs to link the orchestrator's workers again.
            expect(yield* store.closedWorkers(boss!)).toEqual([]);
            expect((yield* store.getWorkspace(workspaceId)).workspace.name).toBe("Shop");
            const left = yield* store.getThread(other!);
            expect(left.spawnedBy?.threadId).toBe("someone-else");

            yield* store.insertThread(
              thread(project.id, {
                id: worker!,
                workspaceId,
                spawnedBy: { threadId: other!, feature: "cart" },
              }),
            );
            yield* end(other!);
            const detached = yield* store.getThread(worker!);
            expect("spawnedBy" in detached).toBe(false);
            expect(detached.workspaceId).toBe(workspaceId);
            expect(yield* store.closedWorkers(other!)).toEqual(
              how === "closeThread" ? [{ threadId: worker, feature: "cart" }] : [],
            );
          }),
        ),
    );
  }

  it.effect("keeps dreams per workspace, and a closed dream thread leaves its dream behind", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const project = yield* store.ensureProject({ root: "/work/repo", name: "repo" });
        const dream = (id: string, createdAt: number, overrides: Partial<Dream> = {}): Dream => ({
          id: id as DreamId,
          workspaceId,
          kind: "dream",
          mode: "review",
          status: "running",
          inputs: { memoryVersion: "0001", threadIds: [], agentSessions: [] },
          model: { agent: "claude", model: "default" },
          outputDir: `/data/orchestration/w1/dreams/${id}`,
          createdAt,
          ...overrides,
        });
        const [ran, other] = ["dreamer", "bystander"].map((id) => id as ThreadId);
        yield* store.insertThread(thread(project.id, { id: ran!, role: "dream", workspaceId }));
        yield* store.insertThread(thread(project.id, { id: other! }));
        yield* store.putDream(dream("dream-0001", 1, { threadId: ran! }));
        yield* store.putDream(dream("dream-0002", 2, { status: "completed", threadId: other! }));
        yield* store.putDream(dream("dream-0003", 3, { workspaceId: "w2" as WorkspaceId }));
        // Not JSON at all: SQLite's JSON functions would fail every row's statement over it.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO dreams (id, workspace_id, thread_id, created_at, data)
          VALUES ('dream-bad', ${workspaceId}, ${other!}, 4, '{not json')`.pipe(Effect.orDie);

        expect((yield* store.listDreams(workspaceId)).map((d) => d.id)).toEqual([
          "dream-0002",
          "dream-0001",
        ]);
        expect((yield* store.listRunningDreams).map((d) => d.id)).toEqual([
          "dream-0001",
          "dream-0003",
        ]);
        expect((yield* store.getDream("dream-9999" as DreamId).pipe(Effect.flip)).entity).toBe(
          "dream",
        );

        yield* store.putDream(dream("dream-0001", 1, { status: "canceled", threadId: ran! }));
        expect((yield* store.getDream("dream-0001" as DreamId)).status).toBe("canceled");

        yield* store.closeThread(ran!, 1);
        const orphan = yield* store.getDream("dream-0001" as DreamId);
        expect("threadId" in orphan).toBe(false);
        expect(orphan.outputDir).toContain("dream-0001");
        yield* store.removeThread(other!);
        expect("threadId" in (yield* store.getDream("dream-0002" as DreamId))).toBe(false);

        yield* store.removeDream("dream-0002" as DreamId);
        yield* store.removeDream("dream-0002" as DreamId);
        expect((yield* store.listDreams(workspaceId)).map((d) => d.id)).toEqual(["dream-0001"]);

        yield* store.putWorkspace(state(project.id));
        // A dream running in an open thread holds the workspace: its row would go from under it.
        const late = "late-dreamer" as ThreadId;
        yield* store.insertThread(thread(project.id, { id: late, role: "dream", workspaceId }));
        yield* store.putDream(dream("dream-0004", 4, { threadId: late }));
        const held = yield* store.removeWorkspace(workspaceId).pipe(Effect.flip);
        expect(held).toMatchObject({ _tag: "InvalidState", threadId: late });
        yield* store.closeThread(late, 1);
        // Finished makes no difference: its thread would outlive the review it is for.
        const done = "done-dreamer" as ThreadId;
        yield* store.insertThread(thread(project.id, { id: done, role: "dream", workspaceId }));
        yield* store.putDream(dream("dream-0005", 5, { status: "completed", threadId: done }));
        const finished = yield* store.removeWorkspace(workspaceId).pipe(Effect.flip);
        expect(finished).toMatchObject({ _tag: "InvalidState", threadId: done });
        yield* store.closeThread(done, 1);
        yield* store.removeWorkspace(workspaceId);
        expect(yield* store.listDreams(workspaceId)).toEqual([]);
        expect((yield* store.listDreams("w2" as WorkspaceId)).map((d) => d.id)).toEqual([
          "dream-0003",
        ]);
      }),
    ),
  );

  it.effect("marks a thread's messages without their text, and keeps watermarks per version", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const project = yield* store.ensureProject({ root: "/work/repo", name: "repo" });
        const id = "marked" as ThreadId;
        yield* store.insertThread(thread(project.id, { id, workspaceId }));
        const [done, running] = ["turn-done", "turn-running"] as Array<TurnId>;
        yield* store.startTurn(id, done!, 10);
        const said = (messageId: string, role: string, turnId?: TurnId, at?: number) =>
          store.upsertMessage(
            id,
            {
              id: messageId,
              role,
              parts: [{ type: "text", text: `${messageId} said` }],
              ...(at === undefined ? {} : { metadata: { createdAt: at } }),
            } as never,
            turnId,
          );
        yield* said("u1", "user", done, 11);
        yield* said("a1", "assistant", done);
        yield* store.endTurn(done!, { endedAt: 20, reason: "completed" });
        yield* store.startTurn(id, running!, 30);
        yield* said("u2", "user", running, 31);
        yield* said("a2", "assistant", running);

        const marks = yield* store.messageMarks(id);
        expect(marks.map(({ seq, id: mid, at, open }) => [seq, mid, at, open])).toEqual([
          [1, "u1", 11, false],
          // A reply is dated by its turn: when it ended, or began while it runs.
          [2, "a1", 20, false],
          [3, "u2", 31, true],
          [4, "a2", 30, true],
        ]);
        expect(marks.map((mark) => mark.rev)).toEqual(
          marks.map((mark) => mark.rev).toSorted((a, b) => a - b),
        );
        const from = yield* store.listMessagesFrom(id, 3);
        expect(from.map((row) => [row.seq, row.message.id])).toEqual([
          [3, "u2"],
          [4, "a2"],
        ]);
        yield* store.endTurn(running!, { endedAt: 40, reason: "completed" });
        yield* store.closeThread(id, 50);
        const closed = yield* store.messageMarks(id, true);
        expect(closed.map(({ seq, rev, open }) => [seq, rev, open])).toEqual([
          [1, 0, false],
          [2, 0, false],
          [3, 0, false],
          [4, 0, false],
        ]);
        expect((yield* store.listMessagesFrom(id, 4, true)).map((row) => row.message.id)).toEqual([
          "a2",
        ]);

        yield* store.putDreamWatermarks(workspaceId, "0002", [
          watermark("a", 1),
          watermark("b", 2),
        ]);
        yield* store.putDreamWatermarks(workspaceId, "0003", [watermark("a", 3)]);
        yield* store.putDreamWatermarks("w2" as WorkspaceId, "0002", [watermark("c", 9)]);
        // Putting a version replaces its set whole.
        yield* store.putDreamWatermarks(workspaceId, "0002", [watermark("a", 1)]);
        expect(yield* store.listDreamWatermarks(workspaceId, "0002")).toEqual([watermark("a", 1)]);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO dream_watermarks (workspace_id, memory_version, thread_id, data)
          VALUES (${workspaceId}, '0003', 'bad', '{"threadId":"bad"}')`.pipe(Effect.orDie);
        expect(yield* store.listDreamWatermarks(workspaceId, "0003")).toEqual([watermark("a", 3)]);

        yield* store.pruneDreamWatermarks(workspaceId, ["0003"]);
        expect(yield* store.listDreamWatermarks(workspaceId, "0002")).toEqual([]);
        expect(yield* store.listDreamWatermarks(workspaceId, "0003")).toEqual([watermark("a", 3)]);
        yield* store.putWorkspace(state(project.id));
        yield* store.removeWorkspace(workspaceId);
        expect(yield* store.listDreamWatermarks(workspaceId, "0003")).toEqual([]);
        expect(yield* store.listDreamWatermarks("w2" as WorkspaceId, "0002")).toEqual([
          watermark("c", 9),
        ]);
      }),
    ),
  );

  it.effect("reads each worker's latest report, and the interface its reports last stated", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const t1 = "t1" as ThreadId;
        const t2 = "t2" as ThreadId;
        expect(yield* store.latestWorkerReports(workspaceId, [t1])).toEqual([]);
        expect(yield* store.latestWorkerReportSeq(workspaceId)).toBe(0);
        for (let at = 1; at <= 30; at++) {
          // t1 states an interface at 5 and again at 20, then reports without one.
          const stated = at === 5 ? "GET /cart" : at === 20 ? "GET /cart/v2" : undefined;
          yield* store.addWorkerReport(workspaceId, {
            ...report("t1", at),
            ...(stated === undefined ? {} : { interface: stated }),
          });
          yield* store.addWorkerReport(workspaceId, report("t2", at));
        }
        // The latest report states one: that is its own.
        yield* store.addWorkerReport(workspaceId, {
          ...report("t2", 31),
          interface: "POST /pay",
        });
        const elsewhere = yield* store.addWorkerReport("w2" as WorkspaceId, {
          ...report("t1", 99),
          interface: "elsewhere",
        });

        const latest = yield* store.latestWorkerReports(workspaceId, [t2, "t9" as ThreadId, t1]);
        expect(latest).toEqual([
          { report: { ...report("t2", 31), interface: "POST /pay" }, interface: "POST /pay" },
          { report: report("t1", 30), interface: "GET /cart/v2" },
        ]);
        // The same as reducing the whole history, worker by worker.
        const all = yield* store.listWorkerReports(workspaceId);
        for (const { report: last, interface: stated } of latest) {
          const own = all.filter((r) => r.report.threadId === last.threadId);
          expect(last).toEqual(own.at(-1)?.report);
          expect(stated).toBe(
            own.findLast((r) => r.report.interface !== undefined)?.report.interface,
          );
        }
        expect(yield* store.latestWorkerReportSeq(workspaceId)).toBe(all.at(-1)?.seq);
        expect(yield* store.latestWorkerReportSeq("w2" as WorkspaceId)).toBe(elsewhere);
      }),
    ),
  );

  it.effect("lists reports after a sequence number, and keeps the outbox and the audit", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const first = yield* store.addWorkerReport(workspaceId, report("t1", 10));
        const second = yield* store.addWorkerReport(workspaceId, {
          ...report("t2", 20),
          state: "done",
          prUrl: "https://github.com/o/r/pull/1",
          interface: "GET /cart",
        });
        yield* store.addWorkerReport("w2" as WorkspaceId, report("t3", 30));
        expect(second).toBeGreaterThan(first);
        const all = yield* store.listWorkerReports(workspaceId);
        expect(all.map((r) => r.seq)).toEqual([first, second]);
        expect(all[1]?.report.interface).toBe("GET /cart");
        expect((yield* store.listWorkerReports(workspaceId, first)).map((r) => r.seq)).toEqual([
          second,
        ]);
        expect(yield* store.listWorkerReports(workspaceId, second)).toEqual([]);

        expect(yield* store.getOutbox(workspaceId)).toBeUndefined();
        yield* store.putOutbox(workspaceId, '{"generation":1}');
        yield* store.putOutbox(workspaceId, '{"generation":2}');
        expect(yield* store.getOutbox(workspaceId)).toBe('{"generation":2}');
        expect(yield* store.getOutbox("w2" as WorkspaceId)).toBeUndefined();

        const spawn = yield* store.appendOrchestrationEvent(workspaceId, {
          at: 100,
          kind: "spawn",
          data: { threadId: "t1" },
        });
        const wake = yield* store.appendOrchestrationEvent(workspaceId, {
          at: 200,
          kind: "wake",
          data: null,
        });
        yield* store.appendOrchestrationEvent("w2" as WorkspaceId, {
          at: 300,
          kind: "wake",
          data: 1,
        });
        expect(yield* store.listOrchestrationEvents(workspaceId, 0)).toEqual([
          { seq: spawn, workspaceId, at: 100, kind: "spawn", data: { threadId: "t1" } },
          { seq: wake, workspaceId, at: 200, kind: "wake", data: null },
        ]);
        expect((yield* store.listOrchestrationEvents(workspaceId, 200)).map((e) => e.seq)).toEqual([
          wake,
        ]);
      }),
    ),
  );
});

/** The store with every log line kept, message and annotations, to check what a read logs. */
const withLoggedStore = <A, E>(
  effect: (
    logged: Array<Record<string, unknown>>,
  ) => Effect.Effect<A, E, ThreadStore | SqlClient.SqlClient>,
) => {
  const logged: Array<Record<string, unknown>> = [];
  const capture = Logger.make(({ message, fiber }) => {
    logged.push({ message, ...fiber.getRef(References.CurrentLogAnnotations) });
  });
  return withStore(effect(logged)).pipe(Effect.provide(Logger.layer([capture])));
};

const rawThread = (id: string, data: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT OR IGNORE INTO projects (id, root, name, bookmarked)
      VALUES ('p1', '/work/p1', 'p1', 0)`;
    yield* sql`INSERT INTO threads (id, project_id, created_at, last_activity_at, data)
      VALUES (${id}, 'p1', 1, 1, ${data})`;
  }).pipe(Effect.orDie);

const storedValue = (query: "thread" | "settings", key: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      query === "thread"
        ? yield* sql<{ value: string }>`SELECT data AS value FROM threads WHERE id = ${key}`
        : yield* sql<{ value: string }>`SELECT value FROM settings WHERE key = ${key}`;
    return rows[0]?.value;
  }).pipe(Effect.orDie);

const putRawSettings = (value: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT OR REPLACE INTO settings (key, value) VALUES ('app', ${value})`;
  }).pipe(Effect.orDie);

describe("ThreadStore stored rows", () => {
  it.effect(
    "pins unreadable local-check repair to the complete raw configuration inside its audited transaction",
    () =>
      withStore(
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const sql = yield* SqlClient.SqlClient;
          const project = yield* store.ensureProject({
            root: "/invented/unreadable-recipe",
            name: "unreadable",
          });
          const unreadableA = "{invented-private-A";
          const unreadableB = '{"profile":"unknown-version","private":"invented-private-B"}';
          yield* sql`UPDATE projects SET local_check = ${unreadableA} WHERE id = ${project.id}`.pipe(
            Effect.orDie,
          );
          const current = () =>
            store.listProjects.pipe(
              Effect.map((projects) => projects.find((p) => p.id === project.id)!),
            );
          const proposal = (p: typeof project) =>
            planSettingsChanges({ settings: DEFAULT_SETTINGS, project: p }, [
              { op: "set", key: "project.localCheck.command", value: "make test" },
            ]);
          const first = yield* current();
          expect(first.localCheckUnavailable).toContain("unreadable");
          const old = proposal(first);
          expect(old.ok).toBe(true);
          if (!old.ok) return;
          expect(old.plan.notes.join(" ")).toContain("will be replaced in full");
          expect(old.plan.notes.join(" ")).toContain("effective timeoutMs=5400000");
          expect(JSON.stringify(old.plan)).not.toContain(unreadableA);
          yield* sql`UPDATE projects SET local_check = ${unreadableB} WHERE id = ${project.id}`.pipe(
            Effect.orDie,
          );
          const audit = {
            at: 1,
            threadId: "synthetic-repair" as ThreadId,
            proposerRole: "plain" as const,
            scope: "project" as const,
            approvedBy: "user" as const,
            approvedAt: 1,
            changes: [],
            shown: old.plan.rows,
          };
          const count = (yield* store.listSettingsAudit(20)).length;
          expect(
            yield* store.updateProjectLocalCheckAudited(
              project.id,
              old.plan.writes,
              audit,
              old.plan.projectLocalCheckRevision!,
            ),
          ).toBeUndefined();
          expect((yield* store.listSettingsAudit(20)).length).toBe(count);
          expect(
            (yield* sql<{
              local_check: string;
            }>`SELECT local_check FROM projects WHERE id = ${project.id}`.pipe(Effect.orDie))[0]!
              .local_check,
          ).toBe(unreadableB);
          const changed = yield* current();
          expect(changed.localCheckRevision).not.toBe(first.localCheckRevision);
          const fresh = proposal(changed);
          expect(fresh.ok).toBe(true);
          if (!fresh.ok) return;
          expect(JSON.stringify(fresh.plan)).not.toContain("invented-private-B");
          expect(
            yield* store.updateProjectLocalCheckAudited(
              project.id,
              fresh.plan.writes,
              audit,
              fresh.plan.projectLocalCheckRevision!,
            ),
          ).toBeDefined();
          expect((yield* current()).localCheck).toEqual({ command: "make test" });
          expect((yield* current()).localCheckUnavailable).toBeUndefined();
          expect((yield* store.listSettingsAudit(20)).length).toBe(count + 1);
        }),
      ),
  );
  it.effect("fills unset appearance fields without rewriting stored settings", () =>
    withLoggedStore(() =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        for (const appearance of [undefined, {}, { motion: "off" }]) {
          const saved = JSON.stringify({
            ...Schema.encodeSync(Settings)(DEFAULT_SETTINGS),
            appearance,
          });
          yield* putRawSettings(saved);
          expect((yield* store.getSettings).appearance).toEqual({
            look: "glass",
            paletteId: "neutral-dark",
            mode: "dark",
            density: "comfortable",
            contrast: "standard",
            motion: appearance?.motion ?? "system",
          });
          expect(yield* storedValue("settings", "app")).toBe(saved);
        }
      }),
    ),
  );

  it.effect("keeps explicit palettes and every saved mode on reads and unrelated writes", () =>
    withLoggedStore((logged) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        for (const paletteId of ["tokyo-night", "forest", "custom:kept"]) {
          for (const mode of ["system", "light", "dark"] as const) {
            const appearance = {
              look: "glass",
              paletteId,
              mode,
              density: "comfortable",
              contrast: "more",
              motion: "off",
            };
            const saved = JSON.stringify({
              ...Schema.encodeSync(Settings)(DEFAULT_SETTINGS),
              appearance,
            });
            yield* putRawSettings(saved);
            expect((yield* store.getSettings).appearance).toEqual(appearance);
            expect(yield* storedValue("settings", "app")).toBe(saved);
            const patch = { logLevel: "debug" as const };
            yield* store.updateSettings(
              (s) => applySettingsPatch(s, patch),
              settingsPatchPaths(patch),
            );
            expect(JSON.parse((yield* storedValue("settings", "app"))!).appearance).toEqual(
              appearance,
            );
          }
        }
        expect(logged).toEqual([]);
      }),
    ),
  );

  it.effect("leaves out a thread row it can't read, logging where, and keeps it on disk", () =>
    withLoggedStore((logged) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        yield* rawThread("t1", JSON.stringify(thread("p1")));
        const bad = JSON.stringify({
          ...thread("p1", { id: "t2" as ThreadId, title: "the user's private words" }),
          mode: "aNewerMode",
        });
        yield* rawThread("t2", bad);

        expect((yield* store.listThreads).map((t) => t.id)).toEqual(["t1"]);
        expect(yield* store.listThreads).toHaveLength(1);
        expect(yield* Effect.flip(store.getThread("t2" as ThreadId))).toBeInstanceOf(
          ThreadNotFound,
        );
        expect(
          yield* Effect.flip(store.updateThread("t2" as ThreadId, (t) => ({ ...t, pinned: true }))),
        ).toBeInstanceOf(ThreadNotFound);
        expect(yield* storedValue("thread", "t2")).toBe(bad);

        // Once per row a run, with the field's path and never what the row holds.
        expect(logged).toEqual([
          { message: ["stored row unreadable"], table: "threads", key: "t2", fields: ["mode"] },
        ]);
        expect(JSON.stringify(logged)).not.toContain("private");
      }),
    ),
  );

  it.effect("preserves appearance and unknown fields on unrelated writes", () =>
    withLoggedStore((logged) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const appearance = {
          ...DEFAULT_SETTINGS.appearance,
          paletteId: "custom:kept",
          mode: "light",
          density: "comfortable",
          contrast: "more",
          motion: "off",
        };
        const stored = {
          ...Schema.encodeSync(Settings)(DEFAULT_SETTINGS),
          appearance,
          fromANewerBuild: { kept: true },
        };
        yield* putRawSettings(JSON.stringify(stored));
        const read = yield* store.getSettings;
        expect(read.appearance).toEqual(appearance);
        expect(yield* storedValue("settings", "app")).toBe(JSON.stringify(stored));
        const patch = { logLevel: "debug" as const };
        yield* store.updateSettings((s) => applySettingsPatch(s, patch), settingsPatchPaths(patch));
        const written = JSON.parse((yield* storedValue("settings", "app"))!);
        expect(written.appearance).toEqual(appearance);
        expect(written.fromANewerBuild).toEqual({ kept: true });
        expect(logged).toEqual([]);
      }),
    ),
  );

  it.effect("reads settings field by field, and a write keeps what it couldn't read", () =>
    withLoggedStore((logged) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const stored = {
          ...Schema.encodeSync(Settings)(DEFAULT_SETTINGS),
          logLevel: "debug",
          agents: { ...DEFAULT_SETTINGS.agents, defaultMode: "aNewerMode", idleEvictMinutes: 30 },
          fromANewerBuild: { kept: true },
        };
        yield* putRawSettings(JSON.stringify(stored));

        const read = yield* store.getSettings;
        expect(read.logLevel).toBe("debug");
        expect(read.agents).toEqual({ ...DEFAULT_SETTINGS.agents, idleEvictMinutes: 30 });
        expect(logged).toEqual([
          {
            message: ["stored row unreadable"],
            table: "settings",
            key: "app",
            fields: ["agents.defaultMode"],
          },
        ]);

        // Another field changed: the unreadable one and the unknown one stay as they were.
        yield* store.updateSettings((s) => ({ ...s, logLevel: "warn" }));
        const kept = JSON.parse((yield* storedValue("settings", "app"))!) as typeof stored;
        expect(kept.logLevel).toBe("warn");
        expect(kept.agents.defaultMode).toBe("aNewerMode");
        expect(kept.agents.idleEvictMinutes).toBe(30);
        expect(kept.fromANewerBuild).toEqual({ kept: true });

        // The field itself set: the user's choice replaces what couldn't be read.
        yield* store.updateSettings((s) => ({
          ...s,
          agents: { ...s.agents, defaultMode: "plan" },
        }));
        expect((yield* store.getSettings).agents.defaultMode).toBe("plan");

        // Set to the very default, as a patch can: still the caller's, since it says it set it.
        yield* putRawSettings(JSON.stringify(stored));
        yield* store.updateSettings(
          (s) => ({ ...s, agents: { ...s.agents, defaultMode: "auto" } }),
          [["agents", "defaultMode"]],
        );
        const reset = JSON.parse((yield* storedValue("settings", "app"))!) as typeof stored;
        expect(reset.agents.defaultMode).toBe("auto");
        expect(reset.fromANewerBuild).toEqual({ kept: true });

        // A section the defaults don't have is read whole as absent; a patch to one of its fields
        // keeps the readable fields beside it, and the unreadable one too.
        const helpers = { enabled: false, dailyBudgetUsd: "new-format", hourlyCalls: 10 };
        yield* putRawSettings(JSON.stringify({ ...stored, helpers }));
        expect((yield* store.getSettings).helpers).toBeUndefined();
        const patch = { helpers: { hourlyCalls: 20 } };
        const returned = yield* store.updateSettings(
          (s) => applySettingsPatch(s, patch),
          settingsPatchPaths(patch),
        );
        // What was kept is what the caller is told, not only what it set.
        expect(returned.helpers).toBeUndefined();
        expect(
          (JSON.parse((yield* storedValue("settings", "app"))!) as { helpers: unknown }).helpers,
        ).toEqual({ ...helpers, hourlyCalls: 20 });
        // Mending the bad field: the caller is told of the section as stored, siblings included.
        const fix = { helpers: { dailyBudgetUsd: 20 } };
        const mended = yield* store.updateSettings(
          (s) => applySettingsPatch(s, fix),
          settingsPatchPaths(fix),
        );
        expect(mended.helpers).toEqual({ enabled: false, dailyBudgetUsd: 20, hourlyCalls: 20 });

        // A list whose entries carry a newer build's key is kept whole while the caller leaves it
        // alone, and is the caller's once it changes it.
        const bots = [
          {
            loginPattern: "example-code-review[bot]",
            rereviewCommand: "/agent review",
            canApprove: true,
            fromANewerBuild: 1,
          },
        ];
        yield* putRawSettings(JSON.stringify({ ...stored, reviewBots: bots }));
        yield* store.updateSettings((s) => ({ ...s, logLevel: "error" }), [["logLevel"]]);
        const untouched = JSON.parse((yield* storedValue("settings", "app"))!) as {
          reviewBots: unknown;
        };
        expect(untouched.reviewBots).toEqual(bots);
        yield* store.updateSettings((s) => ({ ...s, reviewBots: [] }), [["reviewBots"]]);
        const replaced = JSON.parse((yield* storedValue("settings", "app"))!) as {
          reviewBots: unknown;
        };
        expect(replaced.reviewBots).toEqual([]);

        // Cleared by a patch, a list stays cleared, a newer build's keys in its entries or not.
        const roster = [{ agent: "claude", model: "opus", fromANewerBuild: 1 }];
        yield* putRawSettings(
          JSON.stringify({ ...stored, agents: { ...stored.agents, workerModels: roster } }),
        );
        const clear = { agents: { workerModels: null } };
        const cleared = yield* store.updateSettings(
          (s) => applySettingsPatch(s, clear),
          settingsPatchPaths(clear),
        );
        expect(cleared.agents.workerModels).toBeUndefined();
        expect(
          (JSON.parse((yield* storedValue("settings", "app"))!) as typeof stored).agents,
        ).not.toHaveProperty("workerModels");
      }),
    ),
  );

  it.effect("sets aside settings it can't read at all before writing over them", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        yield* putRawSettings("{not json");
        expect(yield* store.getSettings).toEqual(DEFAULT_SETTINGS);
        yield* store.updateSettings((s) => ({ ...s, logLevel: "warn" }));
        expect((yield* store.getSettings).logLevel).toBe("warn");
        const sql = yield* SqlClient.SqlClient;
        const aside = yield* sql<{ key: string; value: string }>`SELECT key, value FROM settings
          WHERE key LIKE 'app.unreadable.%'`.pipe(Effect.orDie);
        expect(aside.map((row) => row.value)).toEqual(["{not json"]);
      }),
    ),
  );

  it.effect(
    "keeps the claude.ai connectors seen beside the settings, and drops one it can't read",
    () =>
      withLoggedStore((logged) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          expect(yield* store.getSeenConnectors).toEqual([]);
          const a = { name: "claude.ai A", status: "connected" as const, seenAt: 1 };
          yield* store.updateSeenConnectors(() => [a]);
          expect(yield* store.getSeenConnectors).toEqual([a]);
          // `undefined` writes nothing.
          yield* store.updateSeenConnectors(() => undefined);
          expect(yield* store.getSeenConnectors).toEqual([a]);
          // It is a row of its own: the settings neither read nor overwrite it.
          yield* store.updateSettings((s) => ({ ...s, logLevel: "warn" }));
          expect(yield* store.getSeenConnectors).toEqual([a]);

          const sql = yield* SqlClient.SqlClient;
          const newer = { name: "claude.ai B", status: "aNewerState", seenAt: 2 };
          yield* sql`UPDATE settings SET value = ${JSON.stringify([a, newer])}
          WHERE key = 'claudeai.connectors'`.pipe(Effect.orDie);
          expect(yield* store.getSeenConnectors).toEqual([a]);
          expect(logged).toEqual([
            {
              message: ["stored row unreadable"],
              table: "settings",
              key: "claudeai.connectors[1]",
              fields: ["status"],
            },
          ]);
          yield* sql`UPDATE settings SET value = '{not json' WHERE key = 'claudeai.connectors'`.pipe(
            Effect.orDie,
          );
          expect(yield* store.getSeenConnectors).toEqual([]);
          yield* store.updateSeenConnectors((seen) => [...seen, a]);
          expect(yield* store.getSeenConnectors).toEqual([a]);
        }),
      ),
  );

  it("mends a bad part of a stored singleton as deep as the defaults reach", () => {
    const encoded = Schema.encodeSync(Settings)(DEFAULT_SETTINGS);
    const mend = (value: unknown) =>
      decodeMended(Settings, DEFAULT_SETTINGS, encoded, JSON.stringify(value));
    expect(mend({ ...encoded, logLevel: 3 })).toEqual({
      value: DEFAULT_SETTINGS,
      mended: [["logLevel"]],
    });
    // An array is mended whole: the defaults can't stand in for one of its entries.
    expect(
      mend({ ...encoded, reviewBots: [...(encoded.reviewBots ?? []), { loginPattern: 1 }] }).mended,
    ).toEqual([["reviewBots"]]);
    expect(mend([1, 2])).toEqual({ value: DEFAULT_SETTINGS, mended: [[]] });
    expect(mend(encoded)).toEqual({ value: DEFAULT_SETTINGS, mended: [] });
  });
});
