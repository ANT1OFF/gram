// A failed provider launch holds briefs in the ordinary outbox. One held worker is the recovery
// probe; no extra model requests, worktrees, queue or credentials are created to test a provider.
import type {
  AppToolError,
  ModelRef,
  OrchestratorCharter,
  Thread,
  ThreadId,
  WorkerModel,
  WorkspaceId,
  WorkspaceState,
  AgentFailureKind,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { randomUUID } from "node:crypto";
import type { ThreadStore } from "../persistence/thread-store.ts";
import type { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { HELD_RETRY_MS, heldWords } from "./limit-pause.ts";
import type { OutboxState, StoredHeldBrief, StoredSpawnBreaker } from "./outbox.ts";
import { admittedForRole, featureSlug, workerModelLabel, type RosterUnavailable } from "./rules.ts";
import type { Authority, HeldSpawn, SpawnWorkerInput } from "./service/shape.ts";

/** Long enough to absorb a burst and allow a login/network repair, without hourly lockouts. */
export const SPAWN_BREAKER_WINDOW_MS = 10 * 60_000;
export type SpawnFailure = {
  readonly model: ModelRef;
  readonly kind: AgentFailureKind;
  readonly at: number;
};
const keyOf = (model: ModelRef) =>
  JSON.stringify([model.agent, model.model, model.profileId ?? null]);
export const tripsSpawnBreaker = (kind: AgentFailureKind): boolean =>
  kind === "auth" || kind === "modelUnavailable" || kind === "network";

/** Effort/speed share a provider model; distinct gateway profiles never share a breaker. */
export const makeBreakerState = () => {
  const failures = new Map<string, SpawnFailure>();
  const probes = new Map<string, { until: number }>();
  return {
    failure: (model: ModelRef) => failures.get(keyOf(model)),
    fail: (failure: SpawnFailure) => {
      if (!tripsSpawnBreaker(failure.kind)) return;
      const key = keyOf(failure.model);
      if ((failures.get(key)?.at ?? -Infinity) <= failure.at) {
        failures.set(key, failure);
        probes.delete(key);
      }
    },
    clear: (model: ModelRef) => {
      probes.delete(keyOf(model));
      return failures.delete(keyOf(model));
    },
    probeAt: (model: ModelRef, now: number) =>
      Math.max(
        (failures.get(keyOf(model))?.at ?? 0) + SPAWN_BREAKER_WINDOW_MS,
        probes.get(keyOf(model))?.until ?? now,
      ),
    claim: (model: ModelRef, now: number) =>
      probes.set(keyOf(model), { until: now + SPAWN_BREAKER_WINDOW_MS }),
    abandon: (model: ModelRef) => probes.delete(keyOf(model)),
  };
};

type Here = {
  readonly roster: ReadonlyArray<WorkerModel>;
  readonly unavailable: RosterUnavailable;
};
interface Dependencies {
  readonly store: ThreadStore["Service"];
  readonly runtimes: ThreadRuntimes["Service"];
  readonly authorityOf: (id: ThreadId) => Effect.Effect<Authority | undefined>;
  readonly projectName: (
    input: SpawnWorkerInput,
    state: WorkspaceState,
  ) => Effect.Effect<string | undefined>;
  readonly workerModel: (
    tool: string,
    caller: Thread,
    charter: OrchestratorCharter,
    named: string | undefined,
    here?: Here,
  ) => Effect.Effect<{ model: ModelRef }, AppToolError>;
  readonly rosterHere: (
    roster: ReadonlyArray<WorkerModel>,
    charter: OrchestratorCharter,
  ) => Effect.Effect<Here>;
  readonly readOutbox: (id: WorkspaceId) => Effect.Effect<OutboxState>;
  readonly updateOutbox: <A>(
    id: WorkspaceId,
    f: (outbox: OutboxState) => readonly [OutboxState, A],
  ) => Effect.Effect<A>;
  readonly changed: (id: WorkspaceId) => Effect.Effect<void>;
  readonly arm: (id: WorkspaceId) => Effect.Effect<void>;
}

export const makeSpawnBreaker = (deps: Dependencies) =>
  Effect.gen(function* () {
    const state = makeBreakerState();
    const { store, runtimes, readOutbox, updateOutbox, arm, changed } = deps;
    const seen = new Map<ThreadId, number>();
    type Observation =
      | { type: "failure"; workspaceId: WorkspaceId; failure: SpawnFailure }
      | { type: "output"; model: ModelRef };
    const recovered = yield* Queue.unbounded<Observation>();
    const recorded = new Map<string, StoredSpawnBreaker>();
    // Both failures and recovery receipts are durable. Held briefs also retain their cause.
    for (const workspace of yield* store.listWorkspaces) {
      const outbox = yield* readOutbox(workspace.workspace.id);
      for (const record of [
        ...(outbox.spawnBreakers ?? []),
        ...(outbox.heldBriefs ?? []).flatMap((held) =>
          held.breaker === undefined ? [] : [held.breaker],
        ),
      ]) {
        const key = keyOf(record.model);
        const old = recorded.get(key);
        if (
          old === undefined ||
          old.at < record.at ||
          (old.at === record.at && record.cleared === true)
        )
          recorded.set(key, record);
      }
    }
    for (const record of recorded.values()) if (record.cleared !== true) state.fail(record);
    // Also catch a failure just before shutdown that had not held any brief yet. Only examine the
    // failed turn, not previous productive turns. Synthetic error/data parts are not model output.
    const refreshFailures = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      for (const thread of yield* store.listThreads) {
        const error = thread.lastError;
        if (error === undefined || seen.get(thread.id) === error.at) continue;
        seen.set(thread.id, error.at);
        if (
          thread.spawnedBy === undefined ||
          error === undefined ||
          now - error.at >= SPAWN_BREAKER_WINDOW_MS ||
          !tripsSpawnBreaker(error.kind) ||
          (recorded.get(keyOf(thread.model))?.at ?? -Infinity) >= error.at
        )
          continue;
        const output =
          error.turnId === undefined
            ? false
            : (yield* store.listMessages(thread.id)).some(
                (message) =>
                  message.role === "assistant" &&
                  message.metadata?.turnId === error.turnId &&
                  message.metadata?.parentToolUseId === undefined &&
                  message.parts.some(
                    (part) =>
                      ((part.type === "text" || part.type === "reasoning") &&
                        part.text.length > 0) ||
                      part.type.startsWith("tool-"),
                  ),
              );
        if (!output) {
          const failure = { model: thread.model, kind: error.kind, at: error.at };
          state.fail(failure);
          if (thread.workspaceId !== undefined)
            yield* Queue.offer(recovered, {
              type: "failure",
              workspaceId: thread.workspaceId,
              failure,
            });
        }
      }
    });
    yield* refreshFailures;
    const releaseOnOutput = (model: ModelRef) =>
      Effect.gen(function* () {
        if (state.failure(model) !== undefined) return;
        const at = yield* Clock.currentTimeMillis;
        for (const workspace of yield* store.listWorkspaces) {
          const id = workspace.workspace.id;
          const released = yield* updateOutbox(id, (outbox) => {
            let touched = false;
            const spawnBreakers = (outbox.spawnBreakers ?? []).map((record) =>
              keyOf(record.model) === keyOf(model) ? { ...record, cleared: true as const } : record,
            );
            const heldBriefs = (outbox.heldBriefs ?? []).map((held) => {
              if (held.breaker === undefined || keyOf(held.breaker.model) !== keyOf(model))
                return held;
              touched = true;
              const { retryAt: _retry, ...rest } = held;
              return { ...rest, until: at, breaker: { ...held.breaker, cleared: true as const } };
            });
            return [{ ...outbox, spawnBreakers, ...(touched ? { heldBriefs } : {}) }, touched];
          });
          if (released) {
            yield* arm(id);
            yield* changed(id);
          }
        }
      });
    yield* Stream.fromQueue(recovered).pipe(
      Stream.runForEach((observation) => {
        if (observation.type === "output") return releaseOnOutput(observation.model);
        const failure = observation.failure;
        return updateOutbox(observation.workspaceId, (outbox) => [
          {
            ...outbox,
            spawnBreakers: [
              ...(outbox.spawnBreakers ?? []).filter(
                (record) => keyOf(record.model) !== keyOf(failure.model),
              ),
              failure,
            ],
          },
          undefined,
        ]);
      }),
      Effect.forkScoped,
    );
    yield* runtimes.observe({
      onTurnProgress: (_threadId, model) =>
        Effect.suspend(() =>
          state.clear(model)
            ? Queue.offer(recovered, { type: "output", model }).pipe(Effect.asVoid)
            : Effect.void,
        ),
      onTurnEnd: (thread, end) =>
        Effect.gen(function* () {
          const error = thread.lastError;
          if (error !== undefined) seen.set(thread.id, error.at);
          if (
            thread.spawnedBy !== undefined &&
            end.reason === "error" &&
            end.producedOutput === false &&
            error !== undefined &&
            tripsSpawnBreaker(error.kind)
          ) {
            const failure = { model: thread.model, kind: error.kind, at: error.at };
            state.fail(failure);
            if (thread.workspaceId !== undefined)
              yield* Queue.offer(recovered, {
                type: "failure",
                workspaceId: thread.workspaceId,
                failure,
              });
          }
        }),
    });
    const target = (caller: Thread, workspace: WorkspaceState, input: SpawnWorkerInput) =>
      Effect.gen(function* () {
        const here = yield* deps.rosterHere(
          workspace.charter.workerModels ?? [caller.model],
          workspace.charter,
        );
        const picked = yield* deps
          .workerModel("spawn_worker", caller, workspace.charter, input.model, here)
          .pipe(Effect.option);
        return Option.isNone(picked) ? undefined : { model: picked.value.model, here };
      });
    return {
      gate: (callerId: ThreadId, input: SpawnWorkerInput): Effect.Effect<HeldSpawn | undefined> =>
        Effect.gen(function* () {
          const slug = featureSlug(input.feature);
          const authority = yield* deps.authorityOf(callerId);
          if (
            slug === undefined ||
            authority === undefined ||
            authority.state.paused !== undefined ||
            authority.state.pausedFeatures?.includes(slug)
          )
            return;
          const { thread: caller, state: workspace } = authority;
          const id = workspace.workspace.id;
          const outbox = yield* readOutbox(id);
          if (
            input.clientRequestId !== undefined &&
            outbox.requests[input.clientRequestId] !== undefined
          )
            return;
          const existing =
            input.clientRequestId === undefined
              ? undefined
              : outbox.heldBriefs?.find(
                  (held) => held.input.clientRequestId === input.clientRequestId,
                );
          if (existing !== undefined && existing.breaker === undefined) return;
          yield* refreshFailures;
          const picked = yield* target(caller, workspace, input);
          if (picked === undefined) return;
          const failure = state.failure(picked.model);
          if (failure === undefined && existing === undefined) return;
          const projectName = yield* deps.projectName(input, workspace);
          if (projectName === undefined) return;
          const at = yield* Clock.currentTimeMillis;
          const { priority: _priority, atLimit: _atLimit, ...rest } = input;
          const stored: StoredHeldBrief = existing ?? {
            id: `held-${randomUUID().slice(0, 8)}`,
            callerId,
            projectName,
            input: Object.fromEntries(
              Object.entries({ ...rest, model: workerModelLabel(picked.model) }).filter(
                ([, value]) => value !== undefined,
              ),
            ) as StoredHeldBrief["input"],
            agent: picked.model.agent,
            window: "spawn_breaker",
            usedPct: 0,
            until: state.probeAt(picked.model, at),
            heldAt: at,
            breaker: failure!,
          };
          const first = yield* updateOutbox(id, (current) => {
            const raced =
              input.clientRequestId === undefined
                ? undefined
                : current.heldBriefs?.find(
                    (held) => held.input.clientRequestId === input.clientRequestId,
                  );
            return raced !== undefined
              ? [current, raced]
              : [{ ...current, heldBriefs: [...(current.heldBriefs ?? []), stored] }, stored];
          });
          const alternatives = picked.here.roster.flatMap((model, index) =>
            picked.here.unavailable.has(index) ||
            !admittedForRole(model.agent, "worker") ||
            state.failure(model) !== undefined ||
            keyOf(model) === keyOf(picked.model)
              ? []
              : [
                  {
                    model: workerModelLabel(model),
                    ...(model.useFor ? { useFor: model.useFor } : {}),
                    ...(model.profileId === undefined ? {} : { gateway: true as const }),
                  },
                ],
          );
          yield* changed(id);
          yield* arm(id);
          return {
            held: true,
            id: first.id,
            feature: first.input.feature,
            title: first.input.title,
            project: first.projectName,
            until: first.until,
            note: `${heldWords(first)} Clear of this breaker: ${alternatives.map((each) => each.model).join(", ") || "none"}.`,
            alternatives,
          };
        }),
      /** Called under the existing held lock, after admission/limits/slots, before claiming a brief. */
      defer: (id: WorkspaceId, held: StoredHeldBrief) =>
        Effect.gen(function* () {
          const workspace = yield* store.getWorkspace(id).pipe(Effect.option);
          if (Option.isNone(workspace)) return false;
          const authority = yield* deps.authorityOf(
            workspace.value.workspace.orchestratorThreadId ?? held.callerId,
          );
          if (authority === undefined) return false;
          const picked = yield* target(authority.thread, authority.state, held.input);
          if (picked === undefined || state.failure(picked.model) === undefined) return false;
          const at = yield* Clock.currentTimeMillis;
          const probeAt = state.probeAt(picked.model, at);
          if (probeAt <= at) {
            state.claim(picked.model, at);
            return false;
          }
          yield* updateOutbox(id, (outbox) => [
            {
              ...outbox,
              heldBriefs: (outbox.heldBriefs ?? []).map((brief) =>
                brief.id === held.id
                  ? {
                      ...brief,
                      until: probeAt,
                      retryAt: Math.max(probeAt, at + HELD_RETRY_MS),
                      breaker: state.failure(picked.model)!,
                    }
                  : brief,
              ),
            },
            undefined,
          ]);
          return true;
        }),
      abandoned: (held: StoredHeldBrief) =>
        Effect.sync(() => {
          if (held.breaker !== undefined) state.abandon(held.breaker.model);
        }),
    };
  });
