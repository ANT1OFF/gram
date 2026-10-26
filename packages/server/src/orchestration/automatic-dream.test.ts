import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  DEFAULT_SETTINGS,
  type DreamId,
  type ModelRef,
  type NotFound,
  type Thread,
  type ThreadId,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import type { AgentHost } from "@gram/agents";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import {
  AutomaticDreamDeferred,
  defaultDreamModel,
  makeAutomaticDream,
} from "./automatic-dream.ts";
import { emptyOutbox, encodeOutbox, emptyWorkerMemo } from "./outbox.ts";

const withStore = <A, E>(effect: Effect.Effect<A, E, ThreadStore>) =>
  effect.pipe(Effect.provide(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie)));
const fixture = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const project = yield* store.ensureProject({ root: "/synthetic/repo", name: "synthetic" });
  yield* store.putSettings({
    ...DEFAULT_SETTINGS,
    agents: { ...DEFAULT_SETTINGS.agents, defaultModel: { agent: "claude", model: "default" } },
  });
  const workspace: WorkspaceState = {
    workspace: {
      id: "workspace" as WorkspaceId,
      name: "synthetic",
      projectIds: [project.id],
      homeProjectId: project.id,
      createdAt: 0,
    },
    charter: { ...DEFAULT_CHARTER },
  };
  yield* store.putWorkspace(workspace);
  const launches: ModelRef[] = [];
  let unavailable = false;
  let fail = false;
  let beforeStart: Effect.Effect<void, unknown> = Effect.void;
  let modelChecks = 0;
  let beforeModels: Effect.Effect<void, NotFound> = Effect.void;
  const host = {
    kind: "claude",
    listModels: () =>
      Effect.sync(() => modelChecks++).pipe(
        Effect.andThen(beforeModels),
        Effect.andThen(
          unavailable
            ? Effect.fail(new Error("synthetic unavailable"))
            : Effect.succeed([{ id: "default" }]),
        ),
      ),
  } as unknown as AgentHost;
  const make = () =>
    makeAutomaticDream({
      store,
      hosts: AgentHosts.fromHosts([host]),
      archive: { list: () => Effect.succeed([]) } as never,
      changed: () => Effect.void,
      start: (_id, model) =>
        Effect.gen(function* () {
          expect((yield* store.getAutomaticDreamState(workspace.workspace.id))?.completed).toBe(0);
          yield* beforeStart;
          launches.push(model);
          if (fail) return yield* Effect.fail(new Error("synthetic failed launch"));
        }),
    });
  const controller = make();
  const lock = yield* Semaphore.make(1);
  const complete = (
    id: string,
    overrides: Partial<{ [K in keyof Thread]: Thread[K] | undefined }> = {},
  ) =>
    Effect.gen(function* () {
      const thread = {
        id: id as ThreadId,
        projectId: project.id,
        title: id,
        userNamed: false,
        model: { agent: "claude", model: "default" },
        mode: "default",
        checkout: { kind: "main", path: "/synthetic/repo" },
        labels: [],
        pinned: false,
        parked: false,
        unread: false,
        createdAt: 0,
        lastActivityAt: 1,
        completedAt: 1,
        completedReason: "user",
        ...overrides,
      } as Thread;
      for (const key of Object.keys(thread) as (keyof Thread)[]) {
        if (thread[key] === undefined) delete (thread as unknown as Record<string, unknown>)[key];
      }
      yield* store.insertThread(thread);
      yield* lock.withPermits(1)(controller.onCompletion(thread));
      return thread;
    });
  const enable = (threshold = 2) =>
    store.updateWorkspace(workspace.workspace.id, (w) => ({
      ...w,
      charter: { ...w.charter, automaticDreamThreshold: threshold },
    }));
  return {
    store,
    workspace,
    launches,
    controller,
    make,
    complete,
    enable,
    modelChecks: () => modelChecks,
    setBeforeStart: (effect: Effect.Effect<void, unknown>) => {
      beforeStart = effect;
    },
    setBeforeModels: (effect: Effect.Effect<void, NotFound>) => {
      beforeModels = effect;
    },
    setUnavailable: (value: boolean) => {
      unavailable = value;
    },
    setFail: (value: boolean) => {
      fail = value;
    },
  };
});

describe("automatic Dream scheduling", () => {
  it.effect(
    "marks completed runs once before unavailable-model retries and never retries at recovery",
    () =>
      withStore(
        Effect.gen(function* () {
          const f = yield* fixture;
          const id = f.workspace.workspace.id;
          yield* f.enable(1);
          yield* f.store.updateWorkspace(id, (state) => ({
            ...state,
            paused: { at: 0, reason: "user" },
          }));
          yield* f.complete("earned");
          const dreamId = "completed-dream" as DreamId;
          yield* f.store.putDream({
            id: dreamId,
            workspaceId: id,
            status: "completed",
            kind: "dream",
            mode: "review",
            inputs: { memoryVersion: "", threadIds: [], agentSessions: [] },
            model: { agent: "claude", model: "default" },
            outputDir: "/synthetic/dream",
            createdAt: 0,
            endedAt: 1,
          });
          yield* f.store.updateAutomaticDreamState(id, (state) => ({
            ...state,
            lastDreamId: dreamId,
          }));
          yield* f.store.updateWorkspace(id, ({ paused: _paused, ...state }) => state);
          f.setUnavailable(true);
          yield* f.controller.onDreamChanged(id, true);
          expect(f.modelChecks()).toBe(1);
          expect((yield* f.store.getAutomaticDreamState(id))?.lastSuccessDreamId).toBe(dreamId);
          for (let replay = 0; replay < 3; replay++) yield* f.controller.onDreamChanged(id, true);
          expect(f.modelChecks()).toBe(1);
          expect((yield* f.controller.status(id)).completed).toBe(1);
          yield* f.store.updateAutomaticDreamState(
            id,
            ({ lastSuccessDreamId: _seen, ...state }) => state,
          );
          f.setUnavailable(false);
          yield* f.make().recover;
          expect(f.modelChecks()).toBe(1);
          expect(f.launches).toHaveLength(0);
          yield* f.controller.onConfiguration;
          expect(f.launches).toHaveLength(1);
        }),
      ),
  );
  for (const changed of ["none", "epoch", "claim"] as const)
    it.effect(`restores a proven no-launch batch only with unchanged ownership (${changed})`, () =>
      withStore(
        Effect.gen(function* () {
          const f = yield* fixture;
          const id = f.workspace.workspace.id;
          yield* f.enable(1);
          f.setBeforeStart(
            Effect.gen(function* () {
              if (changed === "epoch") yield* f.enable(2);
              if (changed === "claim")
                yield* f.store.updateAutomaticDreamState(id, (state) => ({
                  ...state,
                  lastAttemptId: "newer-claim",
                }));
              return yield* new AutomaticDreamDeferred({ message: "Known no-launch deferral" });
            }),
          );
          const old = yield* f.complete("earned");
          expect(f.launches).toHaveLength(0);
          expect((yield* f.controller.status(id)).completed).toBe(changed === "none" ? 1 : 0);
          yield* f.controller.onCompletion(old);
          expect((yield* f.controller.status(id)).completed).toBe(changed === "none" ? 1 : 0);
          if (changed === "none") {
            f.setBeforeStart(Effect.void);
            yield* f.controller.onConfiguration;
            expect(f.launches).toHaveLength(1);
          }
        }),
      ),
    );
  it.effect(
    "defaults off, baselines historical completions on enable/edit, and validates distinct completions",
    () =>
      withStore(
        Effect.gen(function* () {
          const f = yield* fixture;
          const old = yield* f.complete("old");
          expect(f.launches).toHaveLength(0);
          yield* f.enable();
          yield* f.controller.onCompletion(old);
          yield* f.complete("a");
          expect((yield* f.controller.status(f.workspace.workspace.id)).completed).toBe(1);
          yield* f.enable(3);
          expect((yield* f.controller.status(f.workspace.workspace.id)).completed).toBe(0);
          yield* f.complete("b");
          yield* f.complete("c");
          expect(f.launches).toHaveLength(0);
          yield* f.complete("d");
          expect(f.launches).toEqual([{ agent: "claude", model: "default" }]);
        }),
      ),
  );
  it.effect("deduplicates repeated events, reopening, recovery and concurrent delivery", () =>
    withStore(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.enable(3);
        const thread = yield* f.complete("a");
        yield* f.controller.onCompletion(thread);
        yield* f.store.setCompletion(thread.id, undefined);
        const reopened = yield* f.store.setCompletion(thread.id, { at: 2, reason: "agent" });
        yield* f.controller.onCompletion(reopened);
        yield* f.make().recover;
        expect((yield* f.controller.status(f.workspace.workspace.id)).completed).toBe(1);
        yield* Effect.all([f.complete("b"), f.complete("c")], { concurrency: "unbounded" });
        expect(f.launches).toHaveLength(1);
        yield* f.controller.onCompletion(reopened);
        expect((yield* f.controller.status(f.workspace.workspace.id)).completed).toBe(0);
      }),
    ),
  );
  it.effect("excludes Dream/orchestrator, foreign workers and ordinary turn ends", () =>
    withStore(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.enable(1);
        yield* f.complete("dream", { role: "dream" });
        yield* f.complete("orchestrator", { role: "orchestrator" });
        yield* f.complete("reply", { completedAt: undefined, completedReason: undefined });
        yield* f.complete("foreign", {
          spawnedBy: { threadId: "parent" as ThreadId, feature: "foreign" },
          workspaceId: "other" as WorkspaceId,
        });
        expect(f.launches).toHaveLength(0);
        yield* f.complete("worker", {
          spawnedBy: { threadId: "parent" as ThreadId, feature: "own" },
          workspaceId: f.workspace.workspace.id,
          completedReason: "prMerged",
        });
        expect(f.launches).toHaveLength(1);
      }),
    ),
  );
  it.effect("retains paused and user-held counts and launches only on an external resume", () =>
    withStore(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.enable(1);
        yield* f.store.updateWorkspace(f.workspace.workspace.id, (w) => ({
          ...w,
          paused: { reason: "user", at: 0 },
        }));
        yield* f.complete("a");
        expect((yield* f.controller.status(f.workspace.workspace.id)).detail).toContain("resume");
        expect(f.launches).toHaveLength(0);
        yield* f.store.updateWorkspace(f.workspace.workspace.id, ({ paused: _pause, ...w }) => w);
        yield* f.store.putOutbox(
          f.workspace.workspace.id,
          encodeOutbox({
            ...emptyOutbox,
            workers: { a: { ...emptyWorkerMemo(0), userIntervened: true } },
          }),
        );
        yield* f.controller.onConfiguration;
        expect((yield* f.controller.status(f.workspace.workspace.id)).detail).toContain("held");
        yield* f.store.putOutbox(f.workspace.workspace.id, encodeOutbox(emptyOutbox));
        yield* f.controller.onConfiguration;
        expect(f.launches).toHaveLength(1);
      }),
    ),
  );
  it.effect("defers unavailable models without consuming progress or changing provider", () =>
    withStore(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.enable(1);
        f.setUnavailable(true);
        yield* f.complete("a");
        expect((yield* f.controller.status(f.workspace.workspace.id)).completed).toBe(1);
        expect(f.launches).toHaveLength(0);
        f.setUnavailable(false);
        yield* f.controller.onConfiguration;
        expect(f.launches).toEqual([{ agent: "claude", model: "default" }]);
      }),
    ),
  );
  it.effect("persists a spent failed claim, never retries it at boot, and requires fresh IDs", () =>
    withStore(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.enable(1);
        f.setFail(true);
        const a = yield* f.complete("a");
        expect(f.launches).toHaveLength(1);
        const restarted = f.make();
        yield* restarted.recover;
        yield* restarted.onConfiguration;
        yield* restarted.onCompletion(a);
        expect(f.launches).toHaveLength(1);
        expect((yield* restarted.status(f.workspace.workspace.id)).detail).toContain("failed");
        f.setFail(false);
        yield* f.complete("b");
        expect(f.launches).toHaveLength(2);
      }),
    ),
  );
  it.effect(
    "keeps recorded progress at recovery but does not count missed completions or launch at boot",
    () =>
      withStore(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.enable(2);
          f.setUnavailable(true);
          const first = yield* f.complete("a");
          const missed = { ...first, id: "missed" as ThreadId, completedAt: 2 };
          yield* f.store.insertThread(missed);
          const restarted = f.make();
          f.setUnavailable(false);
          yield* restarted.recover;
          expect((yield* restarted.status(f.workspace.workspace.id)).completed).toBe(1);
          expect(f.launches).toHaveLength(0);
          yield* restarted.onCompletion(missed);
          expect((yield* restarted.status(f.workspace.workspace.id)).completed).toBe(1);
          yield* f.complete("fresh");
          expect(f.launches).toHaveLength(1);
        }),
      ),
  );
  it.effect(
    "invalidates an old claim if disabled and reenabled at the same threshold during preflight",
    () =>
      withStore(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.enable(1);
          const oldEpoch = (yield* f.store.getAutomaticDreamState(f.workspace.workspace.id))?.epoch;
          f.setBeforeModels(
            Effect.gen(function* () {
              yield* f.store.updateWorkspace(f.workspace.workspace.id, (w) => {
                const { automaticDreamThreshold: _threshold, ...charter } = w.charter;
                return { ...w, charter };
              });
              yield* f.enable(1);
            }),
          );
          yield* f.complete("a");
          expect((yield* f.store.getAutomaticDreamState(f.workspace.workspace.id))?.epoch).not.toBe(
            oldEpoch,
          );
          expect(f.launches).toHaveLength(0);
          expect((yield* f.controller.status(f.workspace.workspace.id)).completed).toBe(0);
          f.setBeforeModels(Effect.void);
          yield* f.complete("fresh");
          expect(f.launches).toHaveLength(1);
        }),
      ),
  );
  it.effect("retains its batch when the workspace pauses during provider preflight", () =>
    withStore(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.enable(1);
        f.setBeforeModels(
          f.store
            .updateWorkspace(f.workspace.workspace.id, (w) => ({
              ...w,
              paused: { reason: "user", at: 1 },
            }))
            .pipe(Effect.asVoid),
        );
        yield* f.complete("a");
        expect(f.launches).toHaveLength(0);
        expect((yield* f.controller.status(f.workspace.workspace.id)).completed).toBe(1);
      }),
    ),
  );
  it.effect("prunes dedup IDs only after their live/closed/archive history is gone", () =>
    withStore(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.enable(10);
        yield* f.complete("kept");
        yield* f.store.updateAutomaticDreamState(f.workspace.workspace.id, (s) => ({
          ...s,
          seen: [...s.seen, "forgotten"],
        }));
        yield* f.make().recover;
        expect((yield* f.store.getAutomaticDreamState(f.workspace.workspace.id))?.seen).toEqual([
          "kept",
        ]);
      }),
    ),
  );
});

/** A host for `kind` that lists `models`, or fails as a CLI that isn't installed would. */
const listingHost = (kind: "claude" | "codex", models: ReadonlyArray<{ id: string }> | undefined) =>
  ({
    kind,
    listModels: () =>
      models === undefined
        ? Effect.fail(new Error(`synthetic: ${kind} not installed`))
        : Effect.succeed(models),
  }) as unknown as AgentHost;
const savedDefault = (model: ModelRef) => ({
  ...DEFAULT_SETTINGS,
  agents: { ...DEFAULT_SETTINGS.agents, defaultModel: model },
});

describe("defaultDreamModel", () => {
  const unsaved = DEFAULT_SETTINGS;

  it.effect("with nothing saved, dreams on the agent that is installed, Claude Code first", () =>
    Effect.gen(function* () {
      const codexOnly = AgentHosts.fromHosts([
        listingHost("claude", undefined),
        listingHost("codex", [{ id: "gpt" }]),
      ]);
      expect(yield* defaultDreamModel(unsaved, codexOnly)).toEqual({
        agent: "codex",
        model: "default",
      });
      const both = AgentHosts.fromHosts([
        listingHost("claude", [{ id: "opus" }]),
        listingHost("codex", []),
      ]);
      expect(yield* defaultDreamModel(unsaved, both)).toEqual({
        agent: "claude",
        model: "default",
      });
      const neither = AgentHosts.fromHosts([]);
      expect(yield* defaultDreamModel(unsaved, neither)).toEqual({
        agent: "claude",
        model: "default",
      });
    }),
  );

  it.effect("keeps a saved default even when its agent lists nothing now", () =>
    Effect.gen(function* () {
      const model: ModelRef = { agent: "claude", model: "opus" };
      const codexOnly = AgentHosts.fromHosts([listingHost("codex", [{ id: "gpt" }])]);
      expect(yield* defaultDreamModel(savedDefault(model), codexOnly)).toEqual(model);
    }),
  );
});
