import * as Effect from "effect/Effect";
import { randomUUID } from "node:crypto";
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
import type { SessionPolicies } from "./session-policy.ts";

/** The session a thread has, as a switch's `source` keeps it. */
export const sessionIdentity = (
  t: Thread,
): NonNullable<NonNullable<Thread["sessionSwitch"]>["source"]> => ({
  ...(t.agentSessionId === undefined ? {} : { agentSessionId: t.agentSessionId }),
  ...(t.agentSessionUnused === undefined ? {} : { agentSessionUnused: t.agentSessionUnused }),
  ...(t.codexHome === undefined ? {} : { codexHome: t.codexHome }),
  ...(t.forkedFrom === undefined ? {} : { forkedFrom: t.forkedFrom }),
});

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

const settleSwitchMode = (
  modeAfterSwitch: SessionPolicies["modeAfterSwitch"],
  session: AgentSession,
  thread: Thread,
) =>
  Effect.gen(function* () {
    const mode = yield* modeAfterSwitch(thread);
    if (mode === undefined || mode === thread.mode) return undefined;
    return yield* session.setMode(mode).pipe(
      Effect.as(mode),
      Effect.catch((refused) =>
        Effect.logWarning("the switched session kept its reported mode").pipe(
          Effect.annotateLogs({ threadId: thread.id, mode, error: refused.message }),
          Effect.as(undefined),
        ),
      ),
    );
  });

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
  readonly modeAfterSwitch: SessionPolicies["modeAfterSwitch"];
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
  modeAfterSwitch,
  openSession,
}: SessionSwitchDeps) => {
  const confirmStartup = (
    rt: Runtime,
    threadId: ThreadId,
    attemptId: string,
    agent: Thread["model"]["agent"],
    ack: Deferred.Deferred<AgentSession, AgentUnavailable>,
  ) =>
    Effect.gen(function* () {
      const target = yield* Deferred.await(ack).pipe(
        Effect.timeoutOrElse({
          duration: "45 seconds",
          orElse: () =>
            Effect.fail(
              new AgentUnavailable({
                agent,
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
          const mode = yield* settleSwitchMode(modeAfterSwitch, target, current);
          const ready = yield* store.updateThread(threadId, (t) => ({
            ...t,
            ...(mode === undefined ? {} : { mode }),
            sessionSwitch: { ...current.sessionSwitch!, phase: "ready" },
          }));
          yield* publishUpsert(ready);
          if (target.acceptSwitchStartup === undefined)
            return yield* new AgentUnavailable({
              agent,
              message: "The selected harness cannot acknowledge this switch startup.",
            });
          yield* target.acceptSwitchStartup(attemptId);
          rt.switchOpening = undefined;
          rt.reopening = false;
          yield* setStatus(rt, "idle");
        }),
      );
    });

  const reopenSwitchTarget = (threadId: ThreadId, attemptId: string) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      const ack = yield* Deferred.make<AgentSession, AgentUnavailable>();
      const fresh = randomUUID();
      let started = false;
      return yield* Effect.gen(function* () {
        const opening = yield* locked(
          rt,
          Effect.gen(function* () {
            const thread = yield* store.getThread(threadId);
            const change = thread.sessionSwitch;
            if (
              change?.id !== attemptId ||
              change.phase !== "ready" ||
              change.handoff === undefined
            )
              return yield* new InvalidState({
                threadId,
                message: "This switch is no longer waiting to give its handoff.",
              });
            if (thread.parked || rt.session !== undefined || hasSessionFiber(threadId))
              return undefined;
            const next = yield* store.updateThread(threadId, (t) => ({
              ...t,
              sessionSwitch: {
                ...change,
                id: fresh,
                phase: "starting",
                handoff: { ...change.handoff!, divider: change.handoff!.divider ?? change.id },
              },
            }));
            started = true;
            yield* publishUpsert(next);
            rt.switchOpening = { id: fresh, ack };
            rt.reopening = true;
            yield* openSession(rt, next, undefined, fresh);
            return change.target.agent;
          }),
        );
        if (opening === undefined) return attemptId;
        yield* confirmStartup(rt, threadId, fresh, opening, ack);
        return fresh;
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) || !started
            ? Effect.void
            : locked(
                rt,
                Effect.gen(function* () {
                  if (rt.switchOpening?.id === fresh) rt.switchOpening = undefined;
                  rt.reopening = false;
                  const failure = Cause.findErrorOption(exit.cause);
                  const failed = yield* store.updateThread(threadId, (t) =>
                    t.sessionSwitch?.id === fresh && t.sessionSwitch.phase === "starting"
                      ? {
                          ...t,
                          sessionSwitch: {
                            ...t.sessionSwitch,
                            phase: "failed",
                            detail: Option.isSome(failure)
                              ? failure.value.message
                              : "The switch's new session didn't reopen. Queued input is held.",
                          },
                        }
                      : t,
                  );
                  yield* publishUpsert(failed);
                }),
              ),
        ),
      );
    });

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
          const errored = rt.status === "error" && change.handoff !== undefined;
          const cold =
            change.phase === "checkpoint" &&
            !change.oldExited &&
            (rt.status === "cold" || errored) &&
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
              !errored &&
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
          if (!change.oldExited && !cold) yield* session!.prepareForSwitch!;
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
      let targetOpened = false;
      return yield* Effect.gen(function* () {
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
            const arrived = rt.switchFence?.id === attemptId ? rt.switchFence.arrived : undefined;
            rt.switchFence = undefined;
            if (arrived !== undefined)
              return yield* new InvalidState({
                threadId,
                message: `The previous session ${arrived} while it stopped, so the switch didn't go ahead.`,
              });
            const next = yield* store.updateThread(threadId, (t) => {
              const {
                agentSessionId: _id,
                agentSessionUnused: _unused,
                codexHome: _home,
                forkedFrom,
                ...rest
              } = t;
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
        yield* confirmStartup(rt, threadId, attemptId, before.change.target.agent, ack);
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

  return { switchSession, reopenSwitchTarget };
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
  readonly modeAfterSwitch: SessionPolicies["modeAfterSwitch"];
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
  modeAfterSwitch,
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
          const mode = yield* settleSwitchMode(modeAfterSwitch, rt.session, thread);
          const released = yield* store.updateThread(
            threadId,
            ({ sessionSwitch: _switch, ...rest }) =>
              mode === undefined ? rest : { ...rest, mode },
          );
          yield* publishUpsert(released);
        }),
      );
    }),
});
