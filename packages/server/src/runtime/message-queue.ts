import { storedActor } from "../host/ownership.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Exit from "effect/Exit";
import {
  type Runtime,
  type Turn,
  type StopClaim,
  stopHeld,
  makeTurnId,
  makeQueueItemId,
  locked,
  type GetRuntime,
  queueIndex,
  NOTHING_RUNNING,
  RUNS_ON_SERVER,
} from "./runtime-state.ts";
import {
  type QueuedInput,
  QueueItemId,
  type UserInput,
  type TurnId,
  fenceWaitNote,
  type ThreadId,
  InvalidState,
  type ThreadNotFound,
  type AgentUnavailable,
  type Thread,
  type ThreadStatus,
  type HostId,
  effectiveCheckout,
  hostOf,
  sessionHostOf,
} from "@gram/contracts";
import {
  typedText,
  userMessage,
  userParts,
  authored,
  sendResultOf,
  typedInput,
  clientInput,
  serverSetOf,
  withSender,
  inputForAgent,
} from "./user-input.ts";
import type { AgentSession, SteerOptions } from "@gram/agents";
import { randomUUID } from "node:crypto";
import type { JoinQueued, JoinResult, ThreadRuntimesShape } from "./thread-runtimes-shape.ts";
import { missingThreadFolder } from "../fs/folders.ts";
import type { RuntimeObserver, NotifyObservers, Dispatch } from "./runtime-observer.ts";
import type { StoredQueuedInput, ThreadStoreShape } from "../persistence/thread-store.ts";
import type { EventHubShape } from "../events/event-hub.ts";
import type { CheckoutServiceShape } from "./hooks.ts";
import type { ThreadWaitsShape } from "../waits/service.ts";
import type { FeedWriter } from "./feed-writer.ts";
import type { TurnLifecycle } from "./turn-lifecycle.ts";
import type { LimitResume } from "./limit-resume.ts";
import { isUndelivered } from "./undelivered.ts";
import { SWITCH_HANDOFF_KEY, type SystemDelivery } from "./system-delivery.ts";
import { isWorktreeWake } from "./worktree-activations.ts";

/** What the queue and deliveries read and change beside a thread's `Runtime`. */
export interface MessageQueueDeps {
  readonly store: ThreadStoreShape;
  readonly hub: EventHubShape;
  readonly waits: ThreadWaitsShape;
  readonly checkouts: CheckoutServiceShape;
  readonly observers: ReadonlySet<RuntimeObserver>;
  readonly notifyObservers: NotifyObservers;
  readonly dispatch: Dispatch;
  readonly getRuntime: GetRuntime;
  readonly publishMessage: FeedWriter["publishMessage"];
  readonly withdrawMessage: FeedWriter["withdrawMessage"];
  readonly setStatus: TurnLifecycle["setStatus"];
  readonly openTurn: TurnLifecycle["openTurn"];
  readonly markRunning: TurnLifecycle["markRunning"];
  readonly markSessionUsed: TurnLifecycle["markSessionUsed"];
  readonly settleDelivery: TurnLifecycle["settleDelivery"];
  readonly finishTurn: TurnLifecycle["finishTurn"];
  readonly startIdleTimer: TurnLifecycle["startIdleTimer"];
  readonly failPendingDeliveries: TurnLifecycle["failPendingDeliveries"];
  readonly failUnavailable: TurnLifecycle["failUnavailable"];
  readonly waitWithAccount: LimitResume["waitWithAccount"];
  readonly endWaitForUser: LimitResume["endWaitForUser"];
  readonly queueHoldsFor: LimitResume["queueHoldsFor"];
  readonly queueHeld: LimitResume["queueHeld"];
  readonly isShuttingDown: () => boolean;
  readonly openSession: (
    rt: Runtime,
    thread: Thread,
    resumeAt?: string,
    switchAttempt?: string,
  ) => Effect.Effect<void, AgentUnavailable>;
  readonly forkStopInMissing: (rt: Runtime) => Effect.Effect<void>;
  readonly becomeIdle: (rt: Runtime) => Effect.Effect<void>;
  /**
   * Whether the thread's session can open on its machine as far as the machine's resume goes:
   * `wait` while its folders are being put back (the resume's end, or the thread's folders coming
   * back, sends what waits: `sendQueuedOn`), `blocked` when they couldn't be. Absent where no
   * machine can join.
   */
  readonly restoreGate?: ((thread: Thread) => "wait" | "blocked" | undefined) | undefined;
}

/** A thread's queued input and system deliveries, and `send`, which every input goes through. */
export const makeMessageQueue = ({
  store,
  hub,
  waits,
  checkouts,
  observers,
  notifyObservers,
  dispatch,
  getRuntime,
  publishMessage,
  withdrawMessage,
  setStatus,
  openTurn,
  markRunning,
  markSessionUsed,
  settleDelivery,
  finishTurn,
  startIdleTimer,
  failPendingDeliveries,
  failUnavailable,
  waitWithAccount,
  endWaitForUser,
  queueHoldsFor,
  queueHeld,
  isShuttingDown,
  openSession,
  forkStopInMissing,
  becomeIdle,
  restoreGate,
}: MessageQueueDeps) => {
  const awaitsMachine = (rt: Runtime) =>
    store.getThread(rt.threadId).pipe(
      Effect.map((thread) => thread.awaitingMachine !== undefined || thread.sentTo !== undefined),
      Effect.orElseSucceed(() => false),
    );

  const persistQueue = (rt: Runtime) =>
    Effect.suspend(() => {
      const withActor = <I extends QueuedInput>(item: I): StoredQueuedInput => {
        const actor = rt.actors.get(item.id);
        return actor === undefined ? item : { ...item, actor };
      };
      const queue = rt.queue.map((item): StoredQueuedInput => {
        const noticeKey = rt.noticeKeys.get(item.id);
        return withActor(noticeKey === undefined ? item : { ...item, noticeKey });
      });
      const head = [rt.launch, rt.inFlight].flatMap((item): ReadonlyArray<StoredQueuedInput> => {
        if (item === undefined) return [];
        const noticeKey = rt.noticeKeys.get(item.id);
        return [
          withActor({
            id: item.id,
            input: item.input,
            turnId: item.turnId,
            ...(noticeKey === undefined ? {} : { noticeKey }),
          }),
        ];
      });
      return store.putQueue(rt.threadId, [...head, ...queue]);
    });

  const syncQueue = (rt: Runtime) =>
    Effect.suspend(() =>
      persistQueue(rt).pipe(
        Effect.andThen(
          hub.publish({ type: "thread.queue", threadId: rt.threadId, queue: [...rt.queue] }),
        ),
      ),
    );

  const withWaitNote = (
    rt: Runtime,
    noted: UserInput,
    turnId: TurnId,
  ): Effect.Effect<UserInput> => {
    const input =
      noted.waitNote === undefined ? noted : { ...typedInput(noted), text: typedText(noted) };
    return Effect.gen(function* () {
      if (
        input.origin !== undefined ||
        input.notice !== undefined ||
        input.text.trimStart().startsWith("/")
      ) {
        return input;
      }
      const thread = yield* store.getThread(rt.threadId).pipe(Effect.option);
      if (Option.isNone(thread) || thread.value.role === "orchestrator") return input;
      const pending = rt.noteHeard?.turnId === turnId ? rt.noteHeard.items : [];
      const drafted = yield* waits.draftNote(rt.threadId, pending);
      if (drafted === undefined) return input;
      rt.noteHeard = { turnId, items: [...pending, ...drafted.news] };
      const waitNote = fenceWaitNote(drafted.note);
      return { ...input, text: `${input.text}\n\n${waitNote}`, waitNote };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("couldn't add the Waiting on you note").pipe(
          Effect.annotateLogs({ threadId: rt.threadId, cause: Cause.pretty(cause) }),
          Effect.as(input),
        ),
      ),
    );
  };

  const sendNow = (
    rt: Runtime,
    session: AgentSession,
    sent: UserInput,
    ids: {
      readonly turnId?: TurnId | undefined;
      readonly messageId?: string | undefined;
      /** The message is in the feed already, as a launch's is. */
      readonly published?: boolean | undefined;
    } = {},
  ) =>
    Effect.gen(function* () {
      const { turn, now } = yield* openTurn(rt, ids.turnId);
      if (sent.notice?.kind === "idleCompact") {
        turn.idleCompaction = { compacted: false, workspaceId: sent.notice.workspaceId };
      }
      const input = ids.published === true ? sent : yield* withWaitNote(rt, sent, turn.id);
      const messageId = ids.messageId ?? randomUUID();
      if (ids.published !== true) {
        yield* publishMessage(
          rt,
          yield* withSender(userMessage(input, messageId, turn.id, now)),
          turn.id,
        );
      }
      yield* markRunning(rt, turn);
      yield* markSessionUsed(rt);
      yield* Effect.logDebug("thread input dispatched").pipe(
        Effect.annotateLogs({
          threadId: rt.threadId,
          turnId: turn.id,
          at: yield* Clock.currentTimeMillis,
          queueLength: rt.queue.length,
        }),
      );
      const seed = rt.lostSession;
      const hookNote = rt.worktreeHookNote;
      const forAgentInput = yield* inputForAgent(store, rt.threadId, input);
      const prelude = [seed, hookNote].filter((value) => value !== undefined).join("\n");
      const read =
        prelude === "" || forAgentInput.text.trimStart().startsWith("/")
          ? forAgentInput
          : { ...forAgentInput, text: `${prelude}\n${forAgentInput.text}` };
      const lost = yield* session.send(read, { messageId }).pipe(
        Effect.as(undefined),
        Effect.catchDefect((defect) =>
          isUndelivered(defect) ? Effect.succeed(defect) : Effect.die(defect),
        ),
      );
      if (lost === undefined) {
        if (read !== forAgentInput && rt.lostSession === seed) rt.lostSession = undefined;
        if (read !== forAgentInput && rt.worktreeHookNote === hookNote)
          rt.worktreeHookNote = undefined;
        return turn.id;
      }
      if (rt.carrying?.turnId === turn.id) return yield* Effect.die(lost);
      yield* Effect.logWarning(
        "thread input didn't reach the agent; kept at the queue's head",
      ).pipe(Effect.annotateLogs({ threadId: rt.threadId, turnId: turn.id }));
      yield* withdrawMessage(rt, messageId);
      if (rt.inFlight?.id === messageId) rt.inFlight = undefined;
      const kept = QueueItemId.make(messageId);
      rt.queue.unshift({ id: kept, input: sent });
      if (!rt.actors.has(kept)) rt.actors.set(kept, yield* storedActor);
      yield* finishTurn(rt, "interrupted", "sendFailed");
      yield* syncQueue(rt);
      yield* setStatus(rt, "error", `${lost.message} Your message waits at the top of the queue.`);
      return yield* lost;
    });

  const steerNow = (
    rt: Runtime,
    session: AgentSession,
    turn: Turn,
    sent: UserInput,
    options?: SteerOptions,
  ) =>
    Effect.gen(function* () {
      if ((yield* switchHold(rt)) !== undefined)
        return yield* new InvalidState({
          threadId: rt.threadId,
          message:
            "Input is held for the orchestrator switch. Wait for it to finish or cancel it before steering.",
        });
      const before = rt.noteHeard;
      const input = yield* withWaitNote(rt, sent, turn.id);
      const messageId = randomUUID();
      const now = yield* Clock.currentTimeMillis;
      const message = yield* withSender({
        id: messageId,
        role: "user",
        parts: userParts(input, messageId),
        metadata: {
          turnId: turn.id,
          createdAt: now,
          ...(input.author === undefined ? {} : { author: input.author }),
          delivery: options?.interrupt === true ? "interrupt" : "steer",
        },
      });
      const read = yield* inputForAgent(store, rt.threadId, input);
      const taken = yield* (
        options?.interrupt === true ? session.steer(read, options) : session.steer(read)
      ).pipe(
        Effect.as(true),
        Effect.catchDefect((defect) =>
          Effect.logWarning("the agent refused a steer").pipe(
            Effect.annotateLogs({
              threadId: rt.threadId,
              kind: defect instanceof Error ? defect.name : typeof defect,
            }),
            Effect.as(false),
          ),
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            rt.noteHeard = before;
          }),
        ),
      );
      if (!taken) {
        rt.noteHeard = before;
        return false;
      }
      turn.lastInputAt = yield* Clock.currentTimeMillis;
      const open = turn.reply === undefined ? undefined : rt.open.get(turn.reply);
      const reply =
        open !== undefined &&
        !open.finished &&
        !open.nested &&
        open.accumulator.snapshot().parts.some((part) => part.type !== "step-start")
          ? open.messageId
          : undefined;
      yield* publishMessage(
        rt,
        message,
        turn.id,
        reply === undefined ? undefined : { after: reply },
      ).pipe(
        Effect.catchDefect(() =>
          Effect.logWarning("couldn't record a steer the agent took").pipe(
            Effect.annotateLogs({ threadId: rt.threadId }),
          ),
        ),
      );
      if (reply !== undefined) rt.steerSplit = { turnId: turn.id, reply };
      return true;
    });

  const deliverNext = (rt: Runtime, session: AgentSession, only?: string): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      for (;;) {
        const next: readonly [string, SystemDelivery] | undefined =
          only === undefined
            ? rt.deliveries.entries().next().value
            : rt.deliveries.has(only)
              ? [only, rt.deliveries.get(only)!]
              : undefined;
        if (next === undefined) return false;
        const [key, delivery] = next;
        rt.deliveries.delete(key);
        const turnId = makeTurnId();
        const built = yield* Effect.exit(
          delivery.build(turnId, {
            status: rt.status,
            background: rt.background.length,
            subagentsRunning: rt.activity.subagentsRunning,
            waiting: rt.deliveries.size,
          }),
        );
        if (Exit.isFailure(built)) {
          yield* Effect.logWarning("system delivery build failed").pipe(
            Effect.annotateLogs({ threadId: rt.threadId, key, cause: Cause.pretty(built.cause) }),
          );
          yield* dispatch(
            rt.threadId,
            "system delivery failed",
            delivery.failed(undefined, "buildFailed"),
          );
          continue;
        }
        if (built.value === undefined) continue;
        rt.carrying = { turnId, delivery };
        const sent = yield* Effect.exit(
          sendNow(rt, session, { ...built.value, author: "server" }, { turnId }),
        );
        if (Exit.isFailure(sent)) {
          yield* Effect.logWarning("system delivery send failed").pipe(
            Effect.annotateLogs({ threadId: rt.threadId, key, cause: Cause.pretty(sent.cause) }),
          );
          yield* finishTurn(rt, "error", "sendFailed");
          yield* settleDelivery(rt, "sendFailed");
          yield* setStatus(rt, "error", "The agent didn't take a message from Gram.");
          yield* startIdleTimer(rt);
        }
        return true;
      }
    });

  const steerDeliveries = (rt: Runtime): Effect.Effect<void> =>
    Effect.gen(function* () {
      const session = rt.session;
      const turn = rt.turn;
      if (
        session === undefined ||
        turn === undefined ||
        turn.idleCompaction !== undefined ||
        rt.capabilities?.steer !== true ||
        rt.carrying !== undefined ||
        rt.queue.length > 0 ||
        (yield* queueHeld(rt))
      )
        return;
      for (const [key, delivery] of rt.deliveries) {
        if (delivery.steer !== true) continue;
        rt.deliveries.delete(key);
        const built = yield* Effect.exit(
          delivery.build(turn.id, {
            status: rt.status,
            background: rt.background.length,
            subagentsRunning: rt.activity.subagentsRunning,
            waiting: rt.deliveries.size,
          }),
        );
        if (Exit.isFailure(built)) {
          yield* Effect.logWarning("system delivery build failed").pipe(
            Effect.annotateLogs({ threadId: rt.threadId, key, cause: Cause.pretty(built.cause) }),
          );
          yield* dispatch(
            rt.threadId,
            "system delivery failed",
            delivery.failed(undefined, "buildFailed"),
          );
          continue;
        }
        if (built.value === undefined) continue;
        const taken = yield* steerNow(rt, session, turn, { ...built.value, author: "server" }).pipe(
          Effect.catchDefect(() => Effect.succeed(false)),
          Effect.catch(() => Effect.succeed(false)),
        );
        if (!taken) {
          rt.deliveries.set(key, delivery);
          return;
        }
        rt.carrying = { turnId: turn.id, delivery, steered: { key } };
        return;
      }
    });

  const switchHold = (rt: Runtime) =>
    store.getThread(rt.threadId).pipe(
      Effect.map((thread) => {
        const change = thread.sessionSwitch;
        return change !== undefined &&
          (change.phase !== "checkpoint" || change.checkpointTurnId !== undefined)
          ? change
          : undefined;
      }),
      Effect.orDie,
    );

  const pumpDeliveries = (rt: Runtime): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (rt.deliveries.size === 0 || isShuttingDown()) return;
      if (rt.activeWorktreeHook === true) return;
      const change = yield* switchHold(rt);
      if (change !== undefined && change.phase !== "ready") return;
      const only = change?.handoff === undefined ? undefined : SWITCH_HANDOFF_KEY;
      if (only !== undefined && !rt.deliveries.has(only)) return;
      if (only !== undefined && rt.session === undefined) {
        const handoff = rt.deliveries.get(only)!;
        rt.deliveries.delete(only);
        return yield* dispatch(
          rt.threadId,
          "system delivery failed",
          handoff.failed(undefined, "ended"),
        );
      }
      if (rt.closing) return yield* failPendingDeliveries(rt, "ended");
      if (rt.reserved) return;
      if (stopHeld(rt)) return;
      if (yield* awaitsMachine(rt)) return;
      if (yield* waitWithAccount(rt)) return;
      switch (rt.status) {
        case "ended":
          return yield* failPendingDeliveries(rt, rt.status);
        case "running":
          return only === undefined ? yield* steerDeliveries(rt) : undefined;
        case "starting":
        case "needsApproval":
        case "needsInput":
          return;
        case "error":
        case "idle":
          if (rt.session !== undefined) {
            if (
              rt.turn === undefined &&
              (rt.queue.length === 0 || change?.phase === "ready") &&
              !rt.reopenOnIdle
            ) {
              yield* deliverNext(rt, rt.session, only);
            }
            return;
          }
          break;
        case "cold":
          break;
      }
      const thread = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
      yield* openSession(rt, thread).pipe(
        Effect.catchTag("AgentUnavailable", (e) => failUnavailable(rt, e)),
      );
    });

  const launch = (rt: Runtime, typed: UserInput) =>
    Effect.gen(function* () {
      const createdAt = yield* Clock.currentTimeMillis;
      const id = makeQueueItemId();
      const turnId = makeTurnId();
      const input = yield* withWaitNote(rt, typed, turnId);
      rt.launch = { id, input, turnId };
      rt.actors.set(id, yield* storedActor);
      yield* persistQueue(rt);
      yield* publishMessage(
        rt,
        yield* withSender(userMessage(input, id, turnId, createdAt)),
        turnId,
      );
      return turnId;
    });

  const refuseMissingFolder = (rt: Runtime) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(rt.threadId);
      if (thread.transferredTo !== undefined) {
        return yield* new InvalidState({
          message: `This thread moved to ${thread.transferredTo.name}. Carry on there; this copy is read-only.`,
          threadId: rt.threadId,
          status: rt.status,
        });
      }
      const path = thread.checkout.path;
      if (restoreGate?.(thread) !== undefined) return;
      if (yield* checkouts.present(path)) return;
      yield* forkStopInMissing(rt);
      return yield* new InvalidState({
        message: missingThreadFolder(path),
        threadId: rt.threadId,
        status: rt.status,
        folderMissing: { path },
      });
    });

  const userTyped = (threadId: ThreadId, input: UserInput) =>
    Effect.gen(function* () {
      if (input.origin !== undefined || input.notice !== undefined || observers.size === 0) return;
      const thread = yield* store.getThread(threadId).pipe(Effect.option);
      if (Option.isNone(thread)) return;
      yield* notifyObservers(threadId, "onUserInput", (observer) =>
        observer.onUserInput?.(thread.value, input),
      );
    });

  const sendInput = (
    threadId: ThreadId,
    input: UserInput,
    join?: JoinQueued,
    noticeKey?: string,
    joinsWith?: (queued: UserInput) => boolean,
    steerNotice = false,
  ): Effect.Effect<
    JoinResult & { readonly steered?: boolean; readonly replaced?: boolean },
    ThreadNotFound | InvalidState | AgentUnavailable
  > =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      return yield* locked(
        rt,
        Effect.gen(function* () {
          if (isShuttingDown() || rt.closing || rt.reserved) {
            return yield* new InvalidState({
              message: isShuttingDown()
                ? "Gram is quitting"
                : rt.closing
                  ? "the thread is closing"
                  : "the thread's worktree is being cleaned up",
              threadId,
              status: rt.status,
            });
          }
          if ((yield* store.getThread(threadId)).sentTo !== undefined)
            return yield* new InvalidState({ message: RUNS_ON_SERVER, threadId });
          const awaiting = yield* awaitsMachine(rt);
          if (!awaiting) yield* refuseMissingFolder(rt);
          if (noticeKey !== undefined && (yield* store.getThread(threadId)).parked) {
            return yield* new InvalidState({ message: "the thread is archived", threadId });
          }
          const enqueue = () =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              for (const id of rt.queuedAt.keys()) {
                if (!rt.queue.some((item) => item.id === id)) rt.queuedAt.delete(id);
              }
              if (noticeKey !== undefined) {
                const stale = rt.queue.findIndex(
                  (item) => rt.noticeKeys.get(item.id) === noticeKey,
                );
                if (stale >= 0) {
                  const id = rt.queue[stale]!.id;
                  rt.queue[stale] = { id, input };
                  rt.actors.set(id, yield* storedActor);
                  rt.queuedAt.set(id, { at: now, messages: 1 });
                  yield* syncQueue(rt);
                  return { queued: true, replaced: true };
                }
              }
              const last = rt.queue.at(-1);
              const sender = input.origin?.threadId;
              if (
                join !== undefined &&
                last !== undefined &&
                last.input.notice === undefined &&
                (joinsWith === undefined
                  ? sender !== undefined && last.input.origin?.threadId === sender
                  : joinsWith(last.input))
              ) {
                const known = rt.queuedAt.get(last.id);
                const queuedAt = known?.at;
                const messages = known?.messages ?? 1;
                rt.queue[rt.queue.length - 1] = {
                  id: last.id,
                  input: join({ input: last.input, queuedAt, messages }, input, now),
                };
                rt.queuedAt.set(last.id, { at: queuedAt, messages: messages + 1 });
                const joiner = yield* storedActor;
                if (JSON.stringify(rt.actors.get(last.id)) !== JSON.stringify(joiner))
                  rt.actors.set(last.id, {});
                yield* syncQueue(rt);
                return { queued: true, joined: { queuedAt } };
              }
              const id = makeQueueItemId();
              rt.queue.push({ id, input });
              rt.actors.set(id, yield* storedActor);
              rt.queuedAt.set(id, { at: now, messages: 1 });
              if (noticeKey !== undefined) rt.noticeKeys.set(id, noticeKey);
              yield* syncQueue(rt);
              return { queued: true };
            });
          if (awaiting) return yield* enqueue();
          if ((yield* switchHold(rt)) !== undefined) return yield* enqueue();
          const typed =
            input.origin === undefined && input.notice === undefined && noticeKey === undefined;
          if (typed) yield* endWaitForUser(rt);
          else if (yield* waitWithAccount(rt)) return yield* enqueue();
          else if (yield* queueHoldsFor(threadId)) return yield* enqueue();
          if (rt.activeWorktreeHook === true) return yield* enqueue();
          if (noticeKey !== undefined) {
            for (const id of rt.noticeKeys.keys()) {
              if (!rt.queue.some((item) => item.id === id)) rt.noticeKeys.delete(id);
            }
            const turn = rt.turn;
            const stale = rt.queue.findIndex((item) => rt.noticeKeys.get(item.id) === noticeKey);
            if (
              steerNotice &&
              (stale < 0 || stale === rt.queue.length - 1) &&
              rt.status === "running" &&
              rt.session !== undefined &&
              turn !== undefined &&
              turn.idleCompaction === undefined &&
              rt.capabilities?.steer === true
            ) {
              const steered = yield* steerNow(rt, rt.session, turn, input).pipe(
                Effect.catchDefect(() =>
                  Effect.logWarning("notice steer failed; queued instead").pipe(
                    Effect.annotateLogs({ threadId, key: noticeKey }),
                    Effect.as(false),
                  ),
                ),
              );
              if (steered) {
                if (stale >= 0) {
                  rt.queue.splice(stale, 1);
                  yield* syncQueue(rt);
                }
                return { queued: false, steered: true, replaced: stale >= 0 };
              }
            }
          }
          switch (rt.status) {
            case "ended":
              return yield* new InvalidState({
                message: "the thread has ended",
                threadId,
                status: rt.status,
              });
            case "idle":
            case "error":
              if (
                rt.status === "error" &&
                rt.session !== undefined &&
                rt.turn === undefined &&
                rt.queue.length > 0
              ) {
                const result = yield* enqueue();
                yield* becomeIdle(rt);
                return result;
              }
              if (stopHeld(rt)) return yield* enqueue();
              if (rt.session !== undefined && rt.turn === undefined) {
                if (isWorktreeWake(noticeKey)) {
                  const result = yield* enqueue();
                  yield* becomeIdle(rt);
                  return result;
                }
                return yield* sendNow(rt, rt.session, input).pipe(
                  Effect.map((turnId) => ({ queued: false, turnId })),
                  Effect.tapError(() =>
                    rt.turn !== undefined && rt.carrying === undefined
                      ? finishTurn(rt, "interrupted", "sendFailed")
                      : Effect.void,
                  ),
                  Effect.catchTag("InputUndelivered", () => Effect.succeed({ queued: true })),
                );
              }
              if (rt.session !== undefined) return yield* enqueue();
              break;
            case "starting":
              if (
                noticeKey === undefined &&
                rt.turn === undefined &&
                rt.queue.length === 0 &&
                rt.launch === undefined
              ) {
                return { queued: false, turnId: yield* launch(rt, input) };
              }
              return yield* enqueue();
            case "running":
            case "needsApproval":
            case "needsInput":
              return yield* enqueue();
            case "cold":
              break;
          }
          const thread = yield* store.getThread(threadId);
          if (noticeKey !== undefined || rt.queue.length > 0 || rt.launch !== undefined) {
            const result = yield* enqueue();
            yield* openSession(rt, thread);
            return result;
          }
          yield* openSession(rt, thread);
          return { queued: false, turnId: yield* launch(rt, input) };
        }),
      );
    });

  const send: ThreadRuntimesShape["send"] = (threadId, sent) => {
    const input = authored(typedInput(sent));
    return store.getThread(threadId).pipe(
      Effect.flatMap(() => sendInput(threadId, input)),
      Effect.map(sendResultOf),
      Effect.tap(() => userTyped(threadId, input)),
    );
  };

  const withSession = <A, E>(
    threadId: ThreadId,
    f: (rt: Runtime, session: AgentSession) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | InvalidState | ThreadNotFound> =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      return yield* locked(
        rt,
        Effect.suspend((): Effect.Effect<A, E | InvalidState> =>
          rt.session === undefined
            ? Effect.fail(
                new InvalidState({ message: "no live agent session", threadId, status: rt.status }),
              )
            : f(rt, rt.session),
        ),
      );
    });

  const withQueue = <E>(threadId: ThreadId, f: (rt: Runtime) => Effect.Effect<void, E>) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      yield* locked(rt, f(rt).pipe(Effect.andThen(syncQueue(rt))));
    });

  const drainQueue = (rt: Runtime) =>
    Effect.gen(function* () {
      if (
        (rt.queue.length === 0 && rt.launch === undefined) ||
        rt.activeWorktreeHook === true ||
        stopHeld(rt) ||
        rt.closing ||
        rt.reserved ||
        rt.limitWait !== undefined ||
        (yield* switchHold(rt)) !== undefined ||
        (yield* queueHeld(rt)) ||
        (yield* awaitsMachine(rt))
      )
        return;
      switch (rt.status) {
        case "idle":
        case "error":
          if (rt.session !== undefined) {
            if (rt.turn === undefined) yield* becomeIdle(rt);
            return;
          }
          break;
        case "cold":
          break;
        default:
          return;
      }
      const thread = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
      const gate = restoreGate?.(thread);
      if (gate === "wait") return;
      if (gate !== "blocked" && !(yield* checkouts.present(thread.checkout.path))) return;
      yield* openSession(rt, thread).pipe(
        Effect.catchTag("AgentUnavailable", (e) => failUnavailable(rt, e)),
      );
    });

  return {
    persistQueue,
    syncQueue,
    sendNow,
    steerNow,
    deliverNext,
    switchHold,
    pumpDeliveries,
    launch,
    sendInput,
    send,
    userTyped,
    withQueue,
    drainQueue,
    withSession,
    refuseMissingFolder,
  };
};

const WAITING_ON_USER: ReadonlySet<ThreadStatus> = new Set(["needsApproval", "needsInput"]);

const usersOwnWord = (input: UserInput) =>
  input.author === "user" && input.origin === undefined && input.notice === undefined;

const waitingOnUser = (threadId: ThreadId, status: ThreadStatus) =>
  new InvalidState({
    message: "the turn is waiting on you; answer it, or queue the message",
    threadId,
    status,
  });

/** What `makeMessageQueue` gives the rest of `ThreadRuntimes`. */
export type MessageQueue = ReturnType<typeof makeMessageQueue>;

/** What the queue's `ThreadRuntimes` methods read beside the queue itself. */
export interface QueueMethodsDeps {
  readonly store: ThreadStoreShape;
  readonly runtimes: ReadonlyMap<ThreadId, Runtime>;
  readonly getRuntime: GetRuntime;
  readonly drainQueue: MessageQueue["drainQueue"];
  readonly sendInput: MessageQueue["sendInput"];
  readonly userTyped: MessageQueue["userTyped"];
  readonly syncQueue: MessageQueue["syncQueue"];
  readonly withSession: MessageQueue["withSession"];
  readonly refuseMissingFolder: MessageQueue["refuseMissingFolder"];
  readonly steerNow: MessageQueue["steerNow"];
  readonly withQueue: MessageQueue["withQueue"];
  readonly switchHold: MessageQueue["switchHold"];
  readonly pumpDeliveries: MessageQueue["pumpDeliveries"];
  readonly scheduleAccount: LimitResume["scheduleAccount"];
  /**
   * The user's Stop in two halves (`thread-runtimes.ts`): claimed under the lock, so an interrupt
   * past a card stops the very turn its message was queued behind, then run without it.
   */
  readonly claimStop: (rt: Runtime, turnId?: TurnId) => Effect.Effect<StopClaim | undefined>;
  readonly runStop: (rt: Runtime, target: StopClaim) => Effect.Effect<void>;
  /**
   * Whether a machine is still paired (`WorkerHostsShape.paired`). A thread placed on one removed
   * for good keeps its queue, but the boot doesn't send it: the session can't open there, and each
   * restart would fail the thread again and count as its activity. Moving the thread sends it.
   */
  readonly paired?: (id: HostId) => boolean;
}

const queueFirst = (
  { switchHold, syncQueue }: Pick<QueueMethodsDeps, "switchHold" | "syncQueue">,
  rt: Runtime,
  input: UserInput,
) =>
  Effect.gen(function* () {
    if ((yield* switchHold(rt)) !== undefined)
      return yield* new InvalidState({
        threadId: rt.threadId,
        message:
          "Input is held for the orchestrator switch. Wait for it to finish or cancel it before interrupting.",
      });
    const id = makeQueueItemId();
    rt.queue.unshift({ id, input });
    rt.actors.set(id, yield* storedActor);
    rt.queuedAt.set(id, { at: yield* Clock.currentTimeMillis, messages: 1 });
    yield* syncQueue(rt);
  });

/** The `ThreadRuntimes` methods that queue, edit, steer or deliver a thread's input. */
export const makeQueueMethods = ({
  store,
  runtimes,
  getRuntime,
  drainQueue,
  sendInput,
  userTyped,
  syncQueue,
  withSession,
  refuseMissingFolder,
  steerNow,
  withQueue,
  switchHold,
  pumpDeliveries,
  scheduleAccount,
  claimStop,
  runStop,
  paired = () => true,
}: QueueMethodsDeps): Pick<
  ThreadRuntimesShape,
  | "sendQueuedAtBoot"
  | "sendQueuedOn"
  | "sendOrJoin"
  | "sendNotice"
  | "dropNotices"
  | "steer"
  | "editQueued"
  | "reorderQueue"
  | "removeQueued"
  | "steerQueued"
  | "requestSystemDelivery"
  | "cancelSystemDelivery"
> => ({
  sendQueuedAtBoot: Effect.gen(function* () {
    let sent = 0;
    const threads = yield* store.listThreads;
    for (const account of new Set(threads.flatMap((thread) => thread.limitWait?.account ?? []))) {
      yield* scheduleAccount(account);
    }
    for (const thread of threads) {
      if (thread.limitWait?.kind === "backoff") {
        yield* getRuntime(thread.id).pipe(
          Effect.andThen(scheduleAccount(thread.limitWait.account, thread.id)),
          Effect.ignore,
        );
      }
    }
    let unplaced = 0;
    for (const thread of threads) {
      const queued = yield* store.listQueue(thread.id);
      if (thread.parked || queued.length === 0) continue;
      if (thread.awaitingMachine === undefined && !paired(sessionHostOf(thread))) {
        unplaced++;
        continue;
      }
      sent++;
      yield* getRuntime(thread.id).pipe(
        Effect.flatMap((rt) => locked(rt, drainQueue(rt))),
        Effect.catchCause((cause) =>
          Effect.logWarning("couldn't send what the previous run left queued").pipe(
            Effect.annotateLogs({ threadId: thread.id, cause: Cause.pretty(cause) }),
          ),
        ),
      );
    }
    if (sent > 0) {
      yield* Effect.logInfo("sent what the previous run left queued").pipe(
        Effect.annotateLogs({ threads: sent }),
      );
    }
    if (unplaced > 0) {
      yield* Effect.logInfo("left queued: the threads' machines are no longer paired").pipe(
        Effect.annotateLogs({ threads: unplaced }),
      );
    }
  }),
  sendQueuedOn: (hostId) =>
    Effect.gen(function* () {
      const threads = yield* store.listThreads;
      for (const thread of threads) {
        if (thread.parked) continue;
        if (
          hostOf(thread.checkout) !== hostId &&
          hostOf(effectiveCheckout(thread)) !== hostId &&
          sessionHostOf(thread) !== hostId
        )
          continue;
        const live = runtimes.get(thread.id);
        const waiting =
          live === undefined
            ? (yield* store.listQueue(thread.id)).length > 0
            : live.queue.length > 0 || live.launch !== undefined;
        if (!waiting) continue;
        yield* (live === undefined ? getRuntime(thread.id) : Effect.succeed(live)).pipe(
          Effect.flatMap((rt) => locked(rt, drainQueue(rt))),
          Effect.catchCause((cause) =>
            Effect.logWarning("couldn't send what waited for its machine").pipe(
              Effect.annotateLogs({ threadId: thread.id, hostId, cause: Cause.pretty(cause) }),
            ),
          ),
        );
      }
    }),
  sendOrJoin: (threadId, input, join, joinsWith) =>
    sendInput(threadId, input, join, undefined, joinsWith).pipe(
      Effect.tap(() => userTyped(threadId, input)),
    ),
  sendNotice: (threadId, key, input, options) =>
    sendInput(
      threadId,
      { ...input, author: "server" },
      undefined,
      key,
      undefined,
      options?.steer !== false,
    ).pipe(
      Effect.map((result) => ({
        queued: result.queued,
        steered: result.steered === true,
        replaced: result.replaced === true,
      })),
    ),
  dropNotices: (threadId, drop) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      if (rt.noticeKeys.size === 0) return;
      yield* locked(
        rt,
        Effect.gen(function* () {
          const kept = rt.queue.filter((item) => {
            const key = rt.noticeKeys.get(item.id);
            return key === undefined || !drop(key);
          });
          if (kept.length === rt.queue.length) return;
          rt.queue = kept;
          yield* syncQueue(rt);
        }),
      );
    }).pipe(Effect.ignore),
  steer: (threadId, sent, options) =>
    withSession(threadId, (rt, session) => {
      const turn = rt.turn;
      const input = authored(typedInput(sent));
      const stopping = (claim: StopClaim | undefined) => ({ rt, claim });
      return refuseMissingFolder(rt).pipe(
        Effect.andThen((): Effect.Effect<StopClaim | undefined, InvalidState> => {
          if (turn === undefined)
            return Effect.fail(
              new InvalidState({ message: "nothing to steer", threadId, status: rt.status }),
            );
          const interrupting = options?.interrupt === true;
          if (WAITING_ON_USER.has(rt.status)) {
            if (options?.pastCard !== true || !usersOwnWord(input))
              return Effect.fail(waitingOnUser(threadId, rt.status));
            if (interrupting)
              return queueFirst({ switchHold, syncQueue }, rt, input).pipe(
                Effect.andThen(claimStop(rt, turn.id)),
              );
          } else if (interrupting && rt.capabilities?.steerInterrupt !== true)
            return Effect.fail(
              new InvalidState({
                message: "this agent can't be interrupted for input; stop it and send instead",
                threadId,
                status: rt.status,
              }),
            );
          return steerNow(
            rt,
            session,
            turn,
            input,
            interrupting ? { interrupt: true } : undefined,
          ).pipe(
            Effect.flatMap((taken) =>
              taken
                ? Effect.succeed(undefined)
                : Effect.fail(
                    new InvalidState({
                      message: "the agent couldn't take mid-turn input; send it instead",
                      threadId,
                      status: rt.status,
                    }),
                  ),
            ),
          );
        }),
        Effect.map(stopping),
      );
    }).pipe(
      Effect.flatMap(({ rt, claim }) => (claim === undefined ? Effect.void : runStop(rt, claim))),
      Effect.tap(() => userTyped(threadId, sent)),
    ),
  editQueued: (threadId, itemId, input) =>
    withQueue(threadId, (rt) =>
      queueIndex(rt, itemId).pipe(
        Effect.flatMap((index) => Effect.map(storedActor, (actor) => ({ index, actor }))),
        Effect.map(({ index, actor }) => {
          rt.queue[index] = {
            id: itemId,
            input: { ...clientInput(input), ...serverSetOf(rt.queue[index]!.input) },
          };
          rt.actors.set(itemId, actor);
          rt.noticeKeys.delete(itemId);
          const known = rt.queuedAt.get(itemId);
          if (known !== undefined) rt.queuedAt.set(itemId, { at: known.at, messages: 1 });
        }),
      ),
    ),
  reorderQueue: (threadId, itemIds) =>
    withQueue(threadId, (rt) =>
      Effect.suspend(() => {
        const byId = new Map(rt.queue.map((item) => [item.id, item]));
        const reordered = itemIds.flatMap((id) => byId.get(id) ?? []);
        if (reordered.length !== rt.queue.length || new Set(itemIds).size !== itemIds.length) {
          return Effect.fail(
            new InvalidState({
              message: "the order must list every queued item exactly once",
              threadId,
              status: rt.status,
            }),
          );
        }
        rt.queue = reordered;
        return Effect.void;
      }),
    ),
  removeQueued: (threadId, itemId) =>
    withQueue(threadId, (rt) =>
      queueIndex(rt, itemId).pipe(
        Effect.map((index) => {
          rt.queue.splice(index, 1);
        }),
      ),
    ),
  steerQueued: (threadId, itemId) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      yield* locked(
        rt,
        Effect.gen(function* () {
          const index = yield* queueIndex(rt, itemId);
          if ((yield* switchHold(rt)) !== undefined)
            return yield* new InvalidState({
              threadId,
              message:
                "This queued input is held for the orchestrator switch. Wait for it to finish or cancel it before steering.",
            });
          yield* refuseMissingFolder(rt);
          const turn = rt.turn;
          const session = rt.session;
          if (turn === undefined && NOTHING_RUNNING.has(rt.status) && !rt.closing && !rt.reserved) {
            rt.noticeKeys.delete(itemId);
            rt.queue.unshift(...rt.queue.splice(index, 1));
            yield* syncQueue(rt);
            return yield* drainQueue(rt);
          }
          if (
            WAITING_ON_USER.has(rt.status) &&
            (!usersOwnWord(rt.queue[index]!.input) || rt.noticeKeys.has(itemId))
          )
            return yield* new InvalidState({
              message:
                "only your own message goes in past a card; this one waits for the turn to end",
              threadId,
              status: rt.status,
            });
          if (session === undefined || turn === undefined || rt.capabilities?.steer !== true) {
            return yield* new InvalidState({
              message:
                session === undefined
                  ? "no live agent session"
                  : turn === undefined
                    ? "nothing to steer"
                    : "this agent can't take mid-turn input",
              threadId,
              status: rt.status,
            });
          }
          if (!(yield* steerNow(rt, session, turn, rt.queue[index]!.input))) {
            return yield* new InvalidState({
              message: "the agent couldn't take it mid-turn; it stays queued",
              threadId,
              status: rt.status,
            });
          }
          rt.queue.splice(index, 1);
          yield* syncQueue(rt);
        }),
      );
    }),
  requestSystemDelivery: (threadId, key, delivery) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      yield* locked(
        rt,
        Effect.suspend(() => {
          rt.deliveries.set(key, delivery);
          return pumpDeliveries(rt);
        }),
      );
    }),
  cancelSystemDelivery: (threadId, key) =>
    Effect.suspend(() => {
      const rt = runtimes.get(threadId);
      return rt === undefined
        ? Effect.void
        : locked(
            rt,
            Effect.sync(() => void rt.deliveries.delete(key)),
          );
    }),
});
