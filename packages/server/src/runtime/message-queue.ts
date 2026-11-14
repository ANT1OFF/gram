// What a thread is sent: the user's queue, kept in the store, and the system deliveries waiting
// for the thread to be free, each sent as a turn or steered into the running one.

import { storedActor } from "../host/ownership.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Exit from "effect/Exit";
import {
  type Runtime,
  type Turn,
  makeTurnId,
  makeQueueItemId,
  locked,
  type GetRuntime,
  queueIndex,
  NOTHING_RUNNING,
} from "./runtime-state.ts";
import {
  type QueuedInput,
  QueueItemId,
  type UserInput,
  type TurnId,
  fenceWaitNote,
  fromOwnOrchestrator,
  fenceThreadMessage,
  type ThreadId,
  InvalidState,
  type GramUIMessage,
  type ThreadNotFound,
  type AgentUnavailable,
  type Thread,
  type ThreadStatus,
} from "@gram/contracts";
import {
  typedText,
  userMessage,
  userParts,
  authored,
  typedInput,
  withSender,
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
}: MessageQueueDeps) => {
  /** Whether the thread waits for a machine to be named for it (`Thread.awaitingMachine`). */
  const awaitsMachine = (rt: Runtime) =>
    store.getThread(rt.threadId).pipe(
      Effect.map((thread) => thread.awaitingMachine !== undefined),
      Effect.orElseSucceed(() => false),
    );

  /** Called with the runtime lock held. Stores the queue with the launch, if any, at its head. */
  const persistQueue = (rt: Runtime) =>
    Effect.suspend(() => {
      // Each notice keeps its key in the store, so a restart can't take it for the user's word.
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

  /** Called with the runtime lock held, after any queue change. */
  const syncQueue = (rt: Runtime) =>
    Effect.suspend(() =>
      persistQueue(rt).pipe(
        Effect.andThen(
          hub.publish({ type: "thread.queue", threadId: rt.threadId, queue: [...rt.queue] }),
        ),
      ),
    );

  /**
   * Called with the runtime lock held. The user's own message, sent in turn `turnId`, with the note
   * on what they changed in Waiting on you since the agent last heard,
   * heard once the agent takes it (`settleNote`); as it was when there is no news. Not another
   * thread's message or a notice, not a slash command, which the text after it would break, and not
   * an orchestrator's, whose digest carries what waits.
   */
  const withWaitNote = (
    rt: Runtime,
    noted: UserInput,
    turnId: TurnId,
  ): Effect.Effect<UserInput> => {
    // A launch sent again from the queue, or after a restart, takes its note afresh for this turn:
    // what the old one told was never heard, so it is still news.
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
      // A steer into a turn whose note the agent hasn't taken yet tells only what is newer.
      const pending = rt.noteHeard?.turnId === turnId ? rt.noteHeard.items : [];
      const drafted = yield* waits.draftNote(rt.threadId, pending);
      if (drafted === undefined) return input;
      rt.noteHeard = { turnId, items: [...pending, ...drafted.news] };
      const waitNote = fenceWaitNote(drafted.note);
      return { ...input, text: `${input.text}\n\n${waitNote}`, waitNote };
    }).pipe(
      // The message matters more than the note, which waits for the next one.
      Effect.catchCause((cause) =>
        Effect.logWarning("couldn't add the Waiting on you note").pipe(
          Effect.annotateLogs({ threadId: rt.threadId, cause: Cause.pretty(cause) }),
          Effect.as(input),
        ),
      ),
    );
  };

  /**
   * What the agent reads of `input`: another thread's message fenced as that thread's, never bare
   * where the user's words would be; an orchestrator's to its own worker, and everything without
   * an `origin`, as it is. The transcript keeps the text as written, and its origin part names the
   * sender. A thread the store has lost fences it too.
   */
  const forAgent = (rt: Runtime, stored: UserInput): Effect.Effect<UserInput> => {
    // Who wrote it is the transcript's record, not something the agent is told.
    const { author: _, ...input } = stored;
    const origin = input.origin;
    if (origin === undefined) return Effect.succeed(input);
    return store.getThread(rt.threadId).pipe(
      Effect.option,
      Effect.map((thread) =>
        fromOwnOrchestrator(origin, Option.getOrUndefined(thread)?.spawnedBy)
          ? input
          : { ...input, text: fenceThreadMessage(origin, input.text) },
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
      // A launch took its note as it published the message.
      const input = ids.published === true ? sent : yield* withWaitNote(rt, sent, turn.id);
      // The id doubles as the agent transcript id, so a rewind can resume just before this message.
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
      // A session that opened without the agent's own conversation reads the thread's recent
      // turns ahead of its first input, kept until an input carrying them reaches it. Never ahead
      // of a slash command, which the text before it would break: the next input takes them.
      const seed = rt.lostSession;
      const forAgentInput = yield* forAgent(rt, input);
      const read =
        seed === undefined || forAgentInput.text.trimStart().startsWith("/")
          ? forAgentInput
          : { ...forAgentInput, text: `${seed}\n${forAgentInput.text}` };
      const lost = yield* session.send(read, { messageId }).pipe(
        Effect.as(undefined),
        Effect.catchDefect((defect) =>
          isUndelivered(defect) ? Effect.succeed(defect) : Effect.die(defect),
        ),
      );
      if (lost === undefined) {
        if (read !== forAgentInput && rt.lostSession === seed) rt.lostSession = undefined;
        return;
      }
      // The agent never took it, or can't be said to have. A delivery's own failure settles it,
      // so only the queue's input is kept here: out of the feed, at the queue's head, under its id,
      // so a host that did take it knows it again rather than take it twice.
      if (rt.carrying?.turnId === turn.id) return yield* Effect.die(lost);
      yield* Effect.logWarning(
        "thread input didn't reach the agent; kept at the queue's head",
      ).pipe(Effect.annotateLogs({ threadId: rt.threadId, turnId: turn.id }));
      yield* withdrawMessage(rt, messageId);
      if (rt.inFlight?.id === messageId) rt.inFlight = undefined;
      const kept = QueueItemId.make(messageId);
      rt.queue.unshift({ id: kept, input: sent });
      // Kept to be sent again, so it keeps who sent it (`host/ownership.ts`): an input that came
      // off the queue has its writer already; one sent straight to an idle session is this call's.
      if (!rt.actors.has(kept)) rt.actors.set(kept, yield* storedActor);
      yield* finishTurn(rt, "interrupted", "sendFailed");
      yield* syncQueue(rt);
      yield* setStatus(rt, "error", `${lost.message} Your message waits at the top of the queue.`);
      return yield* lost;
    });

  /**
   * Called with the runtime lock held. The transcript records the steered input, wherever it came
   * from: the composer, the queue, or another thread (whose `origin` part names the sender).
   * `false` when the agent refused it (Codex, whose turn can end before ours does): nothing was
   * recorded, and the caller keeps the input, queueing it or handing it back.
   */
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
      } as unknown as GramUIMessage);
      const read = yield* forAgent(rt, input);
      const taken = yield* (
        options?.interrupt === true ? session.steer(read, options) : session.steer(read)
      ).pipe(
        Effect.as(true),
        // Its reason could quote the input, which stays out of the log; its kind can't.
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
      // A steer that didn't go told nothing, so the turn's reply can't make its note heard. Its
      // message is stored only once taken: the agent's reply waits on this lock, so it still
      // follows the message, and a refused one never shows beside the copy its caller sends.
      if (!taken) {
        rt.noteHeard = before;
        return false;
      }
      turn.lastInputAt = yield* Clock.currentTimeMillis;
      // The agent has it now, so a transcript that fails to record it mustn't make a caller
      // send it again.
      yield* publishMessage(rt, message, turn.id).pipe(
        Effect.catchDefect(() =>
          Effect.logWarning("couldn't record a steer the agent took").pipe(
            Effect.annotateLogs({ threadId: rt.threadId }),
          ),
        ),
      );
      return true;
    });

  /**
   * Called with the runtime lock held, on an idle session with nothing queued. Sends the oldest
   * waiting delivery that still has something to say, as a turn of its own; `false` when none did
   * and the thread stays idle. The turn id is made before the turn, so `build` can record the turn
   * that will carry its input before anything is sent.
   */
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
          // A user's send that dies takes the caller down with it; this one has no caller, so the
          // turn is closed here and the thread says why it stopped.
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

  /**
   * Called with the runtime lock held, on a `running` thread. Steers the oldest waiting delivery
   * that asks for it (`SystemDelivery.steer`) into the turn, cancelling nothing. The turn then
   * carries it, and its end settles it: accepted when the adapter ends it, back to wait when the
   * adapter ends it in error, and failed (its owner asks again) on a limit or a lost session, as
   * for a turn of its own. Nothing streamed after the steer accepts it. The rest, and all of them
   * where the turn can't take one (Gram's idle compaction, an agent that can't steer, a turn
   * already carrying a delivery, queued input that goes first, a queue hold), wait for the turn's
   * end. One the agent refuses goes back to wait, and is built again then.
   */
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
      // Deleting the entry in hand is safe mid-iteration; anything else returns at once.
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
          // Nothing reached the agent, so it waits for the turn's end, and `build` runs again then.
          rt.deliveries.set(key, delivery);
          return;
        }
        rt.carrying = { turnId: turn.id, delivery, steered: { key } };
        return;
      }
    });

  /**
   * Called with the runtime lock held. Starts a waiting delivery if the thread can take one now;
   * a busy thread gets to it from `becomeIdle`, or steers one that asks for it.
   */
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
      // They wait in memory, as a stopped server leaves them; the process is about to exit.
      if (rt.deliveries.size === 0 || isShuttingDown()) return;
      const change = yield* switchHold(rt);
      if (change !== undefined && change.phase !== "ready") return;
      // A plain thread's or worker's switch at `ready` lets only its own handoff go, so nothing
      // reaches the new session before it; the rest wait for the switch to let go. The
      // orchestrator's (no `handoff`) lets its boot digest through as before.
      const only = change?.handoff === undefined ? undefined : SWITCH_HANDOFF_KEY;
      if (only !== undefined && !rt.deliveries.has(only)) return;
      // Nor does it open a session for it: the switch owns its target's startup (a reopen takes a
      // fresh startup id), so a handoff asked for with no session fails, and the switch reopens.
      if (only !== undefined && rt.session === undefined) {
        const handoff = rt.deliveries.get(only)!;
        rt.deliveries.delete(only);
        return yield* dispatch(
          rt.threadId,
          "system delivery failed",
          handoff.failed(undefined, "ended"),
        );
      }
      // A cold thread being closed has no session for the close to stop, so it must not get one.
      if (rt.closing) return yield* failPendingDeliveries(rt, "ended");
      // Held for `whileAtRest`, which pumps again once it lets go.
      if (rt.reserved) return;
      // Held until the thread's machine is named: the placement pumps again (`relocate`).
      if (yield* awaitsMachine(rt)) return;
      // Held for the limit's resume, which pumps again.
      if (yield* waitWithAccount(rt)) return;
      switch (rt.status) {
        case "ended":
          return yield* failPendingDeliveries(rt, rt.status);
        case "running":
          return only === undefined ? yield* steerDeliveries(rt) : undefined;
        // Not into a turn waiting on the user: the agent would read it before their answer.
        case "starting":
        case "needsApproval":
        case "needsInput":
          return;
        // A thread in error takes it as a message from the user would: a session whose turn failed
        // sends it like an idle one, and an agent that couldn't start, or whose session went, is
        // opened again, since what stopped it may be gone.
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

  /**
   * Called with the runtime lock held, once the session that will carry `input` is opening: the
   * message goes to the feed now and to the agent when the session is in, never through `queue`.
   */
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
    });

  /**
   * A thread whose folder is gone has nowhere to run: refuses with the path a client can offer to
   * restore, and stops a session still open there. Run under the lock, before any send or steer.
   */
  const refuseMissingFolder = (rt: Runtime) =>
    Effect.gen(function* () {
      const path = (yield* store.getThread(rt.threadId)).checkout.path;
      if (yield* checkouts.present(path)) return;
      yield* forkStopInMissing(rt);
      return yield* new InvalidState({
        message: missingThreadFolder(path),
        threadId: rt.threadId,
        status: rt.status,
        folderMissing: { path },
      });
    });

  /** Tells observers of an input the user typed, once `send` or `steer` has taken it. */
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
          // A thread whose machine isn't named yet has no folder to miss, and starts nothing:
          // whatever is sent waits in its queue, which the placement sends (`relocate`).
          const awaiting = yield* awaitsMachine(rt);
          // Rather than start an agent that fails to spawn or fails every tool.
          if (!awaiting) yield* refuseMissingFolder(rt);
          // A monitor's notice never wakes an archived thread. Read under the lock, so an archive
          // written while the notice waited its turn stops it before any send, steer or open.
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
                  // New text, new writer: it goes as who wrote it now, not as the one it replaced.
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
                // Two writers in one input: if they differ, it is no one's in particular.
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
          // While the thread waits out a limit, only the user's own word starts a turn, and it
          // ends the wait; anything else waits in the queue for the resume. A thread at rest
          // whose account is limited waits with it rather than meet the limit.
          const typed =
            input.origin === undefined && input.notice === undefined && noticeKey === undefined;
          if (typed) yield* endWaitForUser(rt);
          else if (yield* waitWithAccount(rt)) return yield* enqueue();
          // A queue hold (a paused feature) keeps anything but the user's own word from starting
          // or steering a turn, at rest or cold: it waits in the queue for `releaseQueue`.
          else if (yield* queueHoldsFor(threadId)) return yield* enqueue();
          if (noticeKey !== undefined) {
            for (const id of rt.noticeKeys.keys()) {
              if (!rt.queue.some((item) => item.id === id)) rt.noticeKeys.delete(id);
            }
            const turn = rt.turn;
            const stale = rt.queue.findIndex((item) => rt.noticeKeys.get(item.id) === noticeKey);
            if (
              // Steered by default, never so as to cut off a tool call; one sent with
              // `steer: false` waits for the turn's end.
              steerNotice &&
              // One queued ahead of something else keeps its place, so the update never overtakes
              // what was waiting behind the older one.
              (stale < 0 || stale === rt.queue.length - 1) &&
              rt.status === "running" &&
              rt.session !== undefined &&
              turn !== undefined &&
              // Not into Gram's idle compaction: the notice would only be folded into the summary.
              turn.idleCompaction === undefined &&
              rt.capabilities?.steer === true
            ) {
              // A steer the agent rejects leaves the notice to the queue, like one it can't take.
              const steered = yield* steerNow(rt, rt.session, turn, input).pipe(
                // Its message could quote the notice, which stays out of the log.
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
              // Input a failed send left at the queue's head goes first, as it would from cold.
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
              if (rt.session !== undefined && rt.turn === undefined) {
                const kept = yield* sendNow(rt, rt.session, input).pipe(
                  Effect.as(false),
                  Effect.tapError(() =>
                    // deliverNext settles a carrying delivery itself. A direct send has none, and
                    // the turn sendNow opened never reached the adapter.
                    rt.turn !== undefined && rt.carrying === undefined
                      ? finishTurn(rt, "interrupted", "sendFailed")
                      : Effect.void,
                  ),
                  // What didn't reach the agent waits at the queue's head, and the status says why.
                  Effect.catchTag("InputUndelivered", () => Effect.succeed(true)),
                );
                return { queued: kept };
              }
              if (rt.session !== undefined) return yield* enqueue();
              break;
            case "starting":
              // The session opening has nothing to carry yet, so this is the turn it opens with.
              if (
                noticeKey === undefined &&
                rt.turn === undefined &&
                rt.queue.length === 0 &&
                rt.launch === undefined
              ) {
                yield* launch(rt, input);
                return { queued: false };
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
          // What a restart or a failed open left goes first, so this waits behind it. A monitor's
          // notice waits in the queue too, where the monitor can still replace or take it back and
          // an archive holds it.
          if (noticeKey !== undefined || rt.queue.length > 0 || rt.launch !== undefined) {
            const result = yield* enqueue();
            yield* openSession(rt, thread);
            return result;
          }
          yield* openSession(rt, thread);
          yield* launch(rt, input);
          return { queued: false };
        }),
      );
    });

  const send: ThreadRuntimesShape["send"] = (threadId, sent) => {
    const input = authored(typedInput(sent));
    return store.getThread(threadId).pipe(
      Effect.flatMap(() => sendInput(threadId, input)),
      Effect.map(({ queued }) => ({ queued })),
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

  /**
   * Sends the queue of a thread with nothing running, as a send would take it: live from an idle
   * session, or by opening one. For what an archive held back (a monitor's notice, which
   * `becomeIdle` keeps from an archived thread), what a restart left, and a card that closed with
   * no turn. Holds the lock.
   */
  const drainQueue = (rt: Runtime) =>
    Effect.gen(function* () {
      if (
        (rt.queue.length === 0 && rt.launch === undefined) ||
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
      // Nowhere to run, as a send there is refused: the queue waits for the folder to come back.
      if (!(yield* checkouts.present(thread.checkout.path))) return;
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

/**
 * A turn held on a card the user must answer (an approval, a question). Nothing is steered into it:
 * the agent would read the message before the user's answer. It is queued for the turn's end.
 */
const WAITING_ON_USER: ReadonlySet<ThreadStatus> = new Set(["needsApproval", "needsInput"]);

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
}

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
}: QueueMethodsDeps): Pick<
  ThreadRuntimesShape,
  | "sendQueuedAtBoot"
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
    // What waited out a limit when the previous run stopped resumes on the same plan; its queue
    // waits with it.
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
    // This is the resume of the input in flight (`handover` in `thread-runtimes.ts`): a send a
    // crash cut off is still the stored queue's head, with its turn, and `drainQueue` opens a
    // session and sends it once, as the same message (`queue-persistence.test.ts`).
    for (const thread of threads) {
      const queued = yield* store.listQueue(thread.id);
      if (thread.parked || queued.length === 0) continue;
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
  }),
  sendOrJoin: (threadId, input, join, joinsWith) =>
    sendInput(threadId, input, join, undefined, joinsWith).pipe(
      Effect.tap(() => userTyped(threadId, input)),
    ),
  sendNotice: (threadId, key, input, options) =>
    // Marked Gram's in the queue and the transcript, so no restart or steer makes it the user's.
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
      // As a send is: the turn running there is being stopped, and would fail every tool it calls.
      return refuseMissingFolder(rt).pipe(
        Effect.andThen(() =>
          turn === undefined
            ? Effect.fail(
                new InvalidState({ message: "nothing to steer", threadId, status: rt.status }),
              )
            : WAITING_ON_USER.has(rt.status)
              ? Effect.fail(waitingOnUser(threadId, rt.status))
              : options?.interrupt === true && rt.capabilities?.steerInterrupt !== true
                ? Effect.fail(
                    new InvalidState({
                      message:
                        "this agent can't be interrupted for input; stop it and send instead",
                      threadId,
                      status: rt.status,
                    }),
                  )
                : steerNow(rt, session, turn, authored(typedInput(sent)), options).pipe(
                    Effect.flatMap((taken) =>
                      taken
                        ? Effect.void
                        : Effect.fail(
                            new InvalidState({
                              message: "the agent couldn't take mid-turn input; send it instead",
                              threadId,
                              status: rt.status,
                            }),
                          ),
                    ),
                  ),
        ),
      );
    }).pipe(Effect.tap(() => userTyped(threadId, sent))),
  editQueued: (threadId, itemId, input) =>
    withQueue(threadId, (rt) =>
      queueIndex(rt, itemId).pipe(
        Effect.flatMap((index) => Effect.map(storedActor, (actor) => ({ index, actor }))),
        Effect.map(({ index, actor }) => {
          // Whoever wrote the item is still shown as having written it (an edited notice never
          // becomes the user's words), but it goes as whoever edited it: the whole text is theirs.
          const { author: _, ...edited } = input;
          const author = rt.queue[index]!.input.author;
          rt.queue[index] = {
            id: itemId,
            input: author === undefined ? edited : { ...edited, author },
          };
          rt.actors.set(itemId, actor);
          rt.noticeKeys.delete(itemId);
          // The edit is the whole text now: a join after it starts the numbering again.
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
  // Not `withQueue`: the item leaves the queue after the steer lands, never before.
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
          // Refused as a send there would be, into a running turn too: it is being stopped.
          yield* refuseMissingFolder(rt);
          const turn = rt.turn;
          const session = rt.session;
          if (turn === undefined && NOTHING_RUNNING.has(rt.status) && !rt.closing && !rt.reserved) {
            // Nothing to steer into, so the item goes now, ahead of the rest. Sent by hand, a
            // monitor's notice is the user's, which no archive holds back and no newer replaces.
            rt.noticeKeys.delete(itemId);
            rt.queue.unshift(...rt.queue.splice(index, 1));
            yield* syncQueue(rt);
            return yield* drainQueue(rt);
          }
          if (WAITING_ON_USER.has(rt.status)) return yield* waitingOnUser(threadId, rt.status);
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
