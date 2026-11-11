// A switch of a thread's agent or model, the orchestrator's or any thread's (`agent-switch.ts`),
// which claims the session, reopens it on the new model and releases it, or is cancelled.

import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import type { ThreadRuntimesShape } from "./thread-runtimes-shape.ts";
import { locked, type GetRuntime, type Runtime } from "./runtime-state.ts";
import { InvalidState, AgentUnavailable, type Thread, type ThreadId } from "@gram/contracts";
import type { AgentSession } from "@gram/agents";
import type { AgentHosts } from "./agent-hosts.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { TurnLifecycle } from "./turn-lifecycle.ts";
import type * as Semaphore from "effect/Semaphore";
import type { MessageQueue } from "./message-queue.ts";

/** The session a thread has, as a switch's `source` keeps it. */
export const sessionIdentity = (
  t: Thread,
): NonNullable<NonNullable<Thread["sessionSwitch"]>["source"]> => ({
  ...(t.agentSessionId === undefined ? {} : { agentSessionId: t.agentSessionId }),
  ...(t.agentSessionUnused === undefined ? {} : { agentSessionUnused: t.agentSessionUnused }),
  ...(t.codexHome === undefined ? {} : { codexHome: t.codexHome }),
  ...(t.forkedFrom === undefined ? {} : { forkedFrom: t.forkedFrom }),
});

/** The thread put back on the session a switch's `source` kept, the switch gone. */
const backToSource = (t: Thread, change: NonNullable<Thread["sessionSwitch"]>): Thread => {
  const {
    sessionSwitch: _switch,
    agentSessionId: _id,
    agentSessionUnused: _unused,
    codexHome: _home,
    forkedFrom: _fork,
    ...rest
  } = t;
  const source = change.source ?? {};
  return {
    ...rest,
    model: change.previous,
    mode: change.mode,
    ...(source.agentSessionId === undefined ? {} : { agentSessionId: source.agentSessionId }),
    ...(source.agentSessionUnused === undefined
      ? {}
      : { agentSessionUnused: source.agentSessionUnused }),
    ...(source.codexHome === undefined ? {} : { codexHome: source.codexHome }),
    ...(source.forkedFrom === undefined ? {} : { forkedFrom: source.forkedFrom }),
  };
};

/** What a session switch reads and changes beside a thread's `Runtime`. */
export interface SessionSwitchDeps {
  readonly store: ThreadStoreShape;
  readonly hosts: AgentHosts["Service"];
  readonly getRuntime: GetRuntime;
  readonly setStatus: TurnLifecycle["setStatus"];
  readonly stopSession: TurnLifecycle["stopSession"];
  readonly cancelIdleTimer: TurnLifecycle["cancelIdleTimer"];
  readonly publishUpsert: TurnLifecycle["publishUpsert"];
  readonly isShuttingDown: () => boolean;
  /** Whether a session fiber runs for the thread, starting or open. */
  readonly hasSessionFiber: (threadId: ThreadId) => boolean;
  /** Sends what the switch held, once a rolled-back thread is back on its source. Holds the lock. */
  readonly drainQueue: (rt: Runtime) => Effect.Effect<void>;
  readonly openSession: (
    rt: Runtime,
    thread: Thread,
    resumeAt?: string,
    switchAttempt?: string,
  ) => Effect.Effect<void, AgentUnavailable>;
}

/** `switchSession`, which reopens a claimed thread's session on the model its claim names. */
export const makeSessionSwitch = ({
  store,
  hosts,
  getRuntime,
  setStatus,
  stopSession,
  cancelIdleTimer,
  publishUpsert,
  isShuttingDown,
  hasSessionFiber,
  drainQueue,
  openSession,
}: SessionSwitchDeps) => {
  const switchSession: ThreadRuntimesShape["switchSession"] = (threadId, attemptId) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      const before = yield* locked(
        rt,
        Effect.gen(function* () {
          const thread = yield* store.getThread(threadId);
          const change = thread.sessionSwitch;
          if (
            change?.id !== attemptId ||
            (change.phase !== "checkpoint" && change.phase !== "retry")
          )
            return yield* new InvalidState({
              threadId,
              message: "This switch attempt is no longer waiting for its checkpoint.",
            });
          // A cold thread has no process to stop: no session, none starting, none left from a
          // switch. Its next session is the target's.
          const cold =
            change.phase === "checkpoint" &&
            !change.oldExited &&
            rt.status === "cold" &&
            rt.session === undefined &&
            rt.switchSource === undefined &&
            !hasSessionFiber(threadId);
          if (
            isShuttingDown() ||
            rt.closing ||
            rt.reserved ||
            rt.reopening ||
            rt.turn !== undefined ||
            (rt.status !== "idle" &&
              !cold &&
              !(change.phase === "retry" && (rt.status === "cold" || rt.status === "error"))) ||
            rt.background.length > 0 ||
            rt.activity.subagentsRunning ||
            (yield* store.listRequests(threadId)).length > 0
          )
            return yield* new InvalidState({
              threadId,
              message:
                thread.role === "orchestrator"
                  ? "The orchestrator must finish its current work and questions before switching."
                  : "Wait for this turn to finish, or stop it, then switch.",
            });
          const session = change.oldExited ? undefined : (rt.session ?? rt.switchSource);
          if (change.oldExited && change.retryFrom === undefined)
            return yield* new AgentUnavailable({
              agent: thread.model.agent,
              message:
                "The previous switch target has not proved its release. No retry was started.",
            });
          if (
            !change.oldExited &&
            !cold &&
            (session?.stopForSwitch === undefined || session.prepareForSwitch === undefined)
          )
            return yield* new AgentUnavailable({
              agent: thread.model.agent,
              message:
                "This session cannot safely prove a graceful exit. Start a fresh session with the existing recovery action, then try again.",
            });
          // Arm no-force protection under the runtime lock, before shutdown intent can be
          // persisted or a disposal/close can reach ordinary scope cleanup.
          if (!change.oldExited && !cold) yield* session!.prepareForSwitch!;
          // A switch that can roll back keeps the session as it is now, at the last moment the
          // thread is still on it. A retry's thread was already stripped, so it keeps its own.
          const kept =
            change.source === undefined || change.phase === "retry"
              ? change
              : { ...change, source: sessionIdentity(thread) };
          const marked = yield* store.updateThread(threadId, (t) => ({
            ...t,
            sessionSwitch: { ...kept, phase: "stopping" },
          }));
          yield* publishUpsert(marked);
          if (session !== undefined) rt.switchSource = session;
          // The stop runs outside the lock: what the old session sends meanwhile is fenced.
          rt.switchFence = { id: attemptId };
          rt.reopening = true;
          rt.stopping = "rewind";
          yield* cancelIdleTimer(rt);
          return {
            thread,
            session,
            stop: change.oldExited || cold ? Effect.void : session!.stopForSwitch!,
            change: kept,
          };
        }),
      );
      // Whether a target session was asked for: until then none can exist, whatever its host says.
      let targetOpened = false;
      return yield* Effect.gen(function* () {
        // Scope closure alone is not owner release. The adapter must observe actual owning-child EXIT.
        yield* before.stop;
        yield* stopSession(rt, "rewind");
        const ack = yield* Deferred.make<AgentSession, AgentUnavailable>();
        yield* locked(
          rt,
          Effect.gen(function* () {
            const current = yield* store.getThread(threadId);
            if (current.sessionSwitch?.id === attemptId)
              yield* store.updateThread(threadId, (t) => ({
                ...t,
                sessionSwitch: { ...current.sessionSwitch!, oldExited: true },
              }));

            if (
              isShuttingDown() ||
              rt.closing ||
              current.parked ||
              current.sessionSwitch?.id !== attemptId ||
              current.sessionSwitch.phase !== "stopping"
            )
              return yield* new InvalidState({
                threadId,
                message: "The switch owner changed while the old session stopped.",
              });
            // An approval, a question or background work came from the old session while it
            // stopped: it can't move to the target, so the switch goes no further.
            const arrived = rt.switchFence?.id === attemptId ? rt.switchFence.arrived : undefined;
            rt.switchFence = undefined;
            if (arrived !== undefined)
              return yield* new InvalidState({
                threadId,
                message: `The previous session sent ${arrived} while it stopped, so the switch didn't go ahead.`,
              });
            const next = yield* store.updateThread(threadId, (t) => {
              const {
                agentSessionId: _id,
                agentSessionUnused: _unused,
                codexHome: _home,
                forkedFrom,
                ...rest
              } = t;
              // A fork keeps naming its source thread, but no longer its session: with no session
              // of its own, `resumeOptions` would fork the old agent's.
              return {
                ...rest,
                ...(forkedFrom?.threadId === undefined
                  ? {}
                  : { forkedFrom: { threadId: forkedFrom.threadId } }),
                model: before.change.target,
                mode: before.change.mode,
                sessionSwitch: {
                  ...before.change,
                  phase: "starting",
                  oldExited: true,
                },
              };
            });
            yield* publishUpsert(next);
            rt.usage = undefined;
            rt.identity = undefined;
            rt.switchOpening = { id: attemptId, ack };
            targetOpened = true;
            yield* openSession(rt, next, undefined, attemptId);
          }),
        );
        const target = yield* Deferred.await(ack).pipe(
          Effect.timeoutOrElse({
            duration: "45 seconds",
            orElse: () =>
              Effect.fail(
                new AgentUnavailable({
                  agent: before.change.target.agent,
                  message:
                    "The selected agent did not confirm startup. No fallback or automatic retry was started. Your queued messages remain held.",
                }),
              ),
          }),
        );
        yield* locked(
          rt,
          Effect.gen(function* () {
            const current = yield* store.getThread(threadId);
            if (
              isShuttingDown() ||
              rt.closing ||
              current.sessionSwitch?.id !== attemptId ||
              current.sessionSwitch.phase !== "starting" ||
              rt.session !== target ||
              rt.switchOpening?.id !== attemptId
            )
              return yield* new InvalidState({
                threadId,
                message: "A stale startup cannot complete this switch.",
              });
            const ready = yield* store.updateThread(threadId, (t) => ({
              ...t,
              sessionSwitch: { ...current.sessionSwitch!, phase: "ready" },
            }));
            yield* publishUpsert(ready);
            if (target.acceptSwitchStartup === undefined)
              return yield* new AgentUnavailable({
                agent: before.change.target.agent,
                message: "The selected harness cannot acknowledge this switch startup.",
              });
            // The exact attempt and installed owner are checked under the same runtime lock as disposal.
            yield* target.acceptSwitchStartup(attemptId);
            rt.switchOpening = undefined;
            rt.reopening = false;
            yield* setStatus(rt, "idle");
          }),
        );
        return before.thread.agentSessionId;
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : locked(
                rt,
                Effect.gen(function* () {
                  rt.switchOpening = undefined;
                  rt.reopening = false;
                  if (rt.switchFence?.id === attemptId) rt.switchFence = undefined;
                  const current = yield* store.getThread(threadId).pipe(Effect.option);
                  if (Option.isNone(current) || current.value.sessionSwitch?.id !== attemptId)
                    return;
                  const change = current.value.sessionSwitch;
                  const failure = Cause.findErrorOption(exit.cause);
                  const detail = Option.isSome(failure)
                    ? failure.value.message
                    : "The switch was interrupted. No replacement will be started automatically; ownership must be resolved before recovery.";
                  const targetHost = targetOpened
                    ? yield* hosts.get(change.target.agent).pipe(Effect.option)
                    : Option.none();
                  const targetRelease = !targetOpened
                    ? ("notStarted" as const)
                    : Option.isSome(targetHost) &&
                        targetHost.value.switchAttemptReceipt !== undefined
                      ? yield* targetHost.value.switchAttemptReceipt(attemptId)
                      : undefined;
                  // Roll back when nothing can own either session: the old one's exit proved, no
                  // target process (none asked for, or its exit proved), none in the runtime. The
                  // thread is then its source again, cold, and resumes that session on its next
                  // send. Any doubt about ownership stays `failed`, holding input.
                  if (
                    change.source !== undefined &&
                    change.oldExited &&
                    targetRelease !== undefined &&
                    rt.session === undefined &&
                    !hasSessionFiber(threadId) &&
                    !rt.closing
                  ) {
                    rt.switchSource = undefined;
                    rt.usage = undefined;
                    rt.identity = undefined;
                    const restored = yield* store.updateThread(threadId, (t) =>
                      t.sessionSwitch?.id === attemptId ? backToSource(t, change) : t,
                    );
                    yield* publishUpsert(restored);
                    yield* setStatus(rt, "cold");
                    yield* drainQueue(rt);
                    return;
                  }
                  const failed = yield* store.updateThread(threadId, (t) => ({
                    ...t,
                    sessionSwitch: {
                      ...current.value.sessionSwitch!,
                      phase: "failed",
                      ...(targetRelease === undefined ? {} : { targetRelease }),
                      detail,
                    },
                  }));
                  yield* publishUpsert(failed);
                }),
              ),
        ),
      );
    });

  return { switchSession };
};

/** What claiming, cancelling and releasing a switch read and change. */
export interface SwitchMethodsDeps {
  readonly store: ThreadStoreShape;
  readonly getRuntime: GetRuntime;
  readonly switchGenerations: Map<ThreadId, string>;
  readonly switchConfigLock: Semaphore.Semaphore;
  readonly publishUpsert: TurnLifecycle["publishUpsert"];
  readonly drainQueue: MessageQueue["drainQueue"];
  readonly becomeIdle: (rt: Runtime) => Effect.Effect<void>;
}

/** The `ThreadRuntimes` methods that claim a thread for a switch, cancel it or release it. */
export const makeSwitchMethods = ({
  store,
  getRuntime,
  switchGenerations,
  switchConfigLock,
  publishUpsert,
  drainQueue,
  becomeIdle,
}: SwitchMethodsDeps): Pick<
  ThreadRuntimesShape,
  "claimSessionSwitch" | "cancelSessionSwitch" | "releaseSwitch"
> => ({
  claimSessionSwitch: (threadId, change) =>
    switchConfigLock.withPermits(1)(
      Effect.gen(function* () {
        const rt = yield* getRuntime(threadId);
        return yield* locked(
          rt,
          Effect.gen(function* () {
            const current = yield* store.getThread(threadId);
            if (
              rt.closing ||
              current.sessionSwitch !== undefined ||
              JSON.stringify(current.model) !== JSON.stringify(change.previous) ||
              current.mode !== change.mode
            )
              return yield* new InvalidState({
                threadId,
                message:
                  "The current session changed during switch preflight. Review it and try again.",
              });
            const next = yield* store.updateThread(threadId, (t) => ({
              ...t,
              sessionSwitch: change,
            }));
            switchGenerations.set(threadId, change.id);
            yield* publishUpsert(next);
            return next;
          }),
        );
      }),
    ),
  cancelSessionSwitch: (threadId, attemptId) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      yield* locked(
        rt,
        Effect.gen(function* () {
          const current = yield* store.getThread(threadId);
          if (
            current.sessionSwitch?.id !== attemptId ||
            current.sessionSwitch.phase !== "checkpoint"
          )
            return yield* new InvalidState({
              threadId,
              message: "The previous session has begun stopping; this switch cannot be cancelled.",
            });
          const next = yield* store.updateThread(
            threadId,
            ({ sessionSwitch: _switch, ...rest }) => rest,
          );
          yield* publishUpsert(next);
          if (rt.turn === undefined) {
            yield* becomeIdle(rt);
            yield* drainQueue(rt);
          }
        }),
      );
    }),
  releaseSwitch: (threadId, attemptId) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      yield* locked(
        rt,
        Effect.gen(function* () {
          const thread = yield* store.getThread(threadId);
          if (
            thread.sessionSwitch?.id !== attemptId ||
            thread.sessionSwitch.phase !== "ready" ||
            rt.session === undefined
          )
            return yield* new InvalidState({
              threadId,
              message: "This switch is not ready to release its queued input.",
            });
          const released = yield* store.updateThread(
            threadId,
            ({ sessionSwitch: _switch, ...rest }) => rest,
          );
          yield* publishUpsert(released);
        }),
      );
    }),
});
