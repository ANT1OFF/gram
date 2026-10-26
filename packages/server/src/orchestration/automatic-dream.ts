import { randomUUID } from "node:crypto";
import {
  InvalidState,
  type AutomaticDreamStatus,
  type ModelRef,
  type NotFound,
  type Settings,
  type Thread,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  completionBaseline,
  eligibleCompletion,
  type AutomaticDreamState,
} from "../persistence/automatic-dream-state.ts";
import type { ThreadStore } from "../persistence/thread-store.ts";
import type { AgentHosts } from "../runtime/agent-hosts.ts";
import type { ThreadArchive } from "./archive.ts";
import { readOutbox } from "./outbox.ts";
import { admittedForRole } from "./rules.ts";

/** A proven refusal before any Dream row or provider launch; never an uncertain failure. */
export class AutomaticDreamDeferred extends InvalidState {}

/**
 * Shared with manual start: the saved default model, never substituted for another provider. With
 * none saved, the first local agent that lists models, Claude Code first, as a new thread discovers
 * it, so a Codex-only user's dream doesn't wait on a Claude Code they don't have.
 */
export const defaultDreamModel = (
  settings: Settings,
  hosts: AgentHosts["Service"],
): Effect.Effect<ModelRef> =>
  Effect.gen(function* () {
    const preferred = settings.agents.defaultModel;
    if (preferred !== undefined)
      return admittedForRole(preferred.agent, "dream")
        ? preferred
        : { agent: "claude", model: "default" };
    for (const agent of ["claude", "codex"] as const) {
      const models = yield* hosts.get(agent).pipe(
        Effect.flatMap((host) => host.listModels()),
        Effect.orElseSucceed(() => []),
      );
      if (models.length > 0) return { agent, model: "default" };
    }
    return { agent: "claude", model: "default" };
  });

/** Runs only under Dreams' startLock; SQLite stores the claim before any provider launch.
 * A claim is deliberately not replayed after restart. This is one service-layer lock,
 * not a promise of exclusive scheduling across independent server processes.
 */
export const makeAutomaticDream = (deps: {
  store: ThreadStore["Service"];
  hosts: AgentHosts["Service"];
  archive: ThreadArchive["Service"];
  start: (
    workspaceId: WorkspaceId,
    model: ModelRef,
    threshold: number,
    claim: string,
  ) => Effect.Effect<unknown, unknown>;
  changed: (workspaceId: WorkspaceId) => Effect.Effect<void>;
}) => {
  const { store, hosts, archive } = deps;
  const history = (workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      const threads = yield* store.listThreads;
      const closed = yield* store.listClosed;
      const archived = yield* archive.list(workspaceId).pipe(Effect.orElseSucceed(() => []));
      return {
        threads: [...threads, ...closed.map((c) => c.thread)],
        ids: new Set([
          ...threads.map((t) => t.id),
          ...closed.map((c) => c.thread.id),
          ...archived.map((a) => a.threadId),
        ]),
      };
    });
  const consume = (
    workspace: WorkspaceState,
    failure?: string,
    dreamId?: string,
    expected?: { epoch: string; claim: string } | { epoch: string; failedDreamId: string },
  ) =>
    Effect.gen(function* () {
      if ((yield* store.getAutomaticDreamState(workspace.workspace.id)) === undefined) return false;
      const at = yield* Clock.currentTimeMillis;
      const kept = yield* history(workspace.workspace.id);
      let consumed = false;
      yield* store.updateAutomaticDreamState(workspace.workspace.id, (previous) => {
        if (
          expected !== undefined &&
          (previous.epoch !== expected.epoch ||
            ("claim" in expected
              ? previous.lastAttemptId !== expected.claim
              : (previous.lastDreamId ?? previous.observedDreamId) !== expected.failedDreamId ||
                previous.lastFailureDreamId === expected.failedDreamId))
        )
          return previous;
        consumed = true;
        return {
          ...completionBaseline(previous.threshold, kept.threads, workspace, at, {
            ...previous,
            seen: previous.seen.filter((id) => kept.ids.has(id)),
          }),
          ...(dreamId === undefined && previous.lastDreamId === undefined
            ? {}
            : { lastDreamId: dreamId ?? previous.lastDreamId }),
          ...(previous.lastSuccessDreamId === undefined
            ? {}
            : { lastSuccessDreamId: previous.lastSuccessDreamId }),
          ...(expected !== undefined && "failedDreamId" in expected
            ? { lastFailureDreamId: expected.failedDreamId }
            : previous.lastFailureDreamId === undefined
              ? {}
              : { lastFailureDreamId: previous.lastFailureDreamId }),
          ...(previous.lastAttemptId === undefined
            ? {}
            : { lastAttemptId: previous.lastAttemptId }),
          ...(previous.lastAttemptAt === undefined
            ? {}
            : { lastAttemptAt: previous.lastAttemptAt }),
          ...(failure === undefined ? {} : { lastFailure: failure }),
        };
      });
      return consumed;
    });
  const gate = (workspace: WorkspaceState) =>
    Effect.gen(function* () {
      if (workspace.paused !== undefined) return "Waiting until you resume this workspace.";
      const holder = workspace.workspace.orchestratorThreadId;
      const threads = yield* store.listThreads;
      if (threads.some((t) => t.id === holder && t.parked))
        return "Waiting until you unpark the orchestrator.";
      const outbox = readOutbox(yield* store.getOutbox(workspace.workspace.id));
      if (outbox._tag === "unreadable" || (outbox._tag === "read" && outbox.setAside !== undefined))
        return "Waiting for this workspace's recovery.";
      if (Object.values(outbox.state.workers).some((worker) => worker.userIntervened))
        return "Waiting while a worker is held by you.";
      if ((yield* store.listDreams(workspace.workspace.id)).some((d) => d.status === "running"))
        return "Waiting for the running Dream to end.";
      return undefined;
    });
  const status = (workspaceId: WorkspaceId): Effect.Effect<AutomaticDreamStatus, NotFound> =>
    Effect.gen(function* () {
      const workspace = yield* store.getWorkspace(workspaceId);
      const state = yield* store.getAutomaticDreamState(workspaceId);
      if (workspace.charter.automaticDreamThreshold === undefined || state === undefined)
        return { completed: 0, detail: "Automatic Dream is off." };
      const deferred = yield* gate(workspace);
      return {
        threshold: state.threshold,
        completed: state.completed,
        detail:
          deferred ??
          state.lastFailure ??
          "Automatic runs await review. Counting distinct completed threads since the last start or setting edit.",
      };
    });
  const modelAvailable = (model: ModelRef) =>
    hosts.get(model.agent).pipe(
      Effect.flatMap((host) =>
        host.listModels(model.profileId === undefined ? undefined : { profileId: model.profileId }),
      ),
      Effect.option,
      Effect.map(
        (available) =>
          Option.isSome(available) &&
          available.value.length > 0 &&
          (model.model === "default" || available.value.some((m) => m.id === model.model)),
      ),
    );
  const attempt = (workspace: WorkspaceState, expectedEpoch?: string) =>
    Effect.gen(function* () {
      const id = workspace.workspace.id;
      const state = yield* store.getAutomaticDreamState(id);
      if (
        state === undefined ||
        (expectedEpoch !== undefined && state.epoch !== expectedEpoch) ||
        state.completed < state.threshold ||
        (yield* gate(workspace)) !== undefined
      )
        return;
      const model = yield* defaultDreamModel(yield* store.getSettings, hosts);
      if (!(yield* modelAvailable(model))) {
        let refused = false;
        yield* store.updateAutomaticDreamState(id, (s) => {
          // Model discovery is asynchronous; a settings save may have reset the count.
          if (s.epoch !== state.epoch) return s;
          refused = true;
          return {
            ...s,
            lastFailure:
              "Waiting for the selected Dream model to become available. Check Settings → Agents.",
          };
        });
        if (refused) yield* deps.changed(id);
        return;
      }
      // Persist before the side effect. Unknown failures/interruption spend this batch;
      // only a proven prelaunch deferral may restore it under the same epoch and claim.
      const standing = yield* store.getWorkspace(id);
      if (
        (yield* gate(standing)) !== undefined ||
        JSON.stringify(yield* defaultDreamModel(yield* store.getSettings, hosts)) !==
          JSON.stringify(model)
      )
        return;
      const kept = yield* history(id);
      const at = yield* Clock.currentTimeMillis;
      const claim = randomUUID();
      let claimedState: AutomaticDreamState | undefined;
      let claimSeen = new Set<string>();
      yield* store.updateAutomaticDreamState(id, (s) => {
        if (s.epoch !== state.epoch || s.completed < s.threshold) return s;
        claimedState = s;
        const baseline = completionBaseline(s.threshold, kept.threads, workspace, at, {
          ...s,
          seen: s.seen.filter((threadId) => kept.ids.has(threadId)),
        });
        claimSeen = new Set(baseline.seen);
        return {
          ...baseline,
          ...(s.lastDreamId === undefined ? {} : { lastDreamId: s.lastDreamId }),
          ...(s.lastSuccessDreamId === undefined
            ? {}
            : { lastSuccessDreamId: s.lastSuccessDreamId }),
          ...(s.lastFailureDreamId === undefined
            ? {}
            : { lastFailureDreamId: s.lastFailureDreamId }),
          lastAttemptAt: at,
          lastAttemptId: claim,
        };
      });
      if (claimedState === undefined) return;
      const earned = claimedState;
      yield* deps.start(id, model, state.threshold, claim).pipe(
        Effect.catch((error) =>
          error instanceof AutomaticDreamDeferred
            ? store.updateAutomaticDreamState(id, (s) =>
                s.epoch !== earned.epoch || s.lastAttemptId !== claim
                  ? s
                  : {
                      ...earned,
                      completed: earned.completed + s.completed,
                      seen: [
                        ...new Set([
                          ...earned.seen,
                          ...s.seen.filter((threadId) => !claimSeen.has(threadId)),
                        ]),
                      ],
                      lastFailure: error.message,
                    },
              )
            : Effect.fail(error),
        ),
        Effect.catchCause(() =>
          consume(
            workspace,
            "The last automatic launch failed. A fresh batch of completed threads is needed.",
            undefined,
            { epoch: earned.epoch, claim },
          ),
        ),
      );
      yield* deps.changed(id);
    });
  const onCompletion = (thread: Thread) =>
    Effect.gen(function* () {
      if (thread.role !== undefined || thread.completedAt === undefined) return;
      for (const workspace of yield* store.listWorkspaces) {
        if (
          workspace.charter.automaticDreamThreshold === undefined ||
          !eligibleCompletion(thread, workspace)
        )
          continue;
        const kept = yield* history(workspace.workspace.id);
        let counted = false;
        yield* store.updateAutomaticDreamState(workspace.workspace.id, (s) => {
          if (thread.completedAt! < s.baselineAt || s.seen.includes(thread.id)) return s;
          counted = true;
          return {
            ...s,
            seen: [...s.seen.filter((id) => kept.ids.has(id)), thread.id],
            completed: s.completed + 1,
          };
        });
        if (counted) {
          yield* attempt(workspace);
          yield* deps.changed(workspace.workspace.id);
        }
      }
    });
  const onDreamChanged = (id: WorkspaceId, retryCompleted = false) =>
    Effect.gen(function* () {
      const state = yield* store.getAutomaticDreamState(id);
      if (state === undefined) return;
      const dreams = yield* store.listDreams(id);
      const observedId = state.lastDreamId ?? state.observedDreamId;
      const failed = dreams.find(
        (d) =>
          d.id === observedId &&
          (d.status === "failed" || d.status === "canceled") &&
          state.lastFailureDreamId !== d.id,
      );
      if (failed !== undefined) {
        // Consumption and failure bookkeeping share one conditional SQLite update.
        // Settings saves use a different lock and may have established a fresh epoch.
        const consumed = yield* consume(
          yield* store.getWorkspace(id),
          "The last Dream failed or was cancelled. Counting a fresh batch of completed threads.",
          undefined,
          { epoch: state.epoch, failedDreamId: failed.id },
        );
        if (consumed) yield* deps.changed(id);
      }
      const completed = dreams.find(
        (d) => d.id === observedId && d.status === "completed" && state.lastSuccessDreamId !== d.id,
      );
      if (completed !== undefined) {
        // Record before attempting: our own status events cannot retry a provider refusal.
        let observed = false;
        yield* store.updateAutomaticDreamState(id, (s) => {
          if (
            s.epoch !== state.epoch ||
            (s.lastDreamId ?? s.observedDreamId) !== completed.id ||
            s.lastSuccessDreamId === completed.id
          )
            return s;
          observed = true;
          return { ...s, lastSuccessDreamId: completed.id };
        });
        if (observed && retryCompleted) yield* attempt(yield* store.getWorkspace(id), state.epoch);
      }
    });
  const recover = Effect.gen(function* () {
    for (const workspace of yield* store.listWorkspaces) {
      if (workspace.charter.automaticDreamThreshold === undefined) continue;
      const kept = yield* history(workspace.workspace.id);
      // Keep progress, baseline completions missed while stopped, and never launch at boot.
      yield* store.updateAutomaticDreamState(workspace.workspace.id, (s) => ({
        ...s,
        seen: [
          ...new Set([
            ...s.seen.filter((id) => kept.ids.has(id)),
            ...kept.threads.filter((t) => eligibleCompletion(t, workspace)).map((t) => t.id),
          ]),
        ],
      }));
      yield* onDreamChanged(workspace.workspace.id);
    }
  });
  const onConfiguration = Effect.gen(function* () {
    for (const workspace of yield* store.listWorkspaces) {
      if (workspace.charter.automaticDreamThreshold === undefined) continue;
      const kept = yield* history(workspace.workspace.id);
      yield* store.updateAutomaticDreamState(workspace.workspace.id, (s) => ({
        ...s,
        seen: s.seen.filter((id) => kept.ids.has(id)),
      }));
      yield* onDreamChanged(workspace.workspace.id);
      yield* attempt(yield* store.getWorkspace(workspace.workspace.id));
    }
  }).pipe(Effect.catchTag("NotFound", () => Effect.void));
  return {
    consume,
    status,
    gate,
    modelAvailable,
    onCompletion,
    onDreamChanged,
    recover,
    onConfiguration,
  };
};
