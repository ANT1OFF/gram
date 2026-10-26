// What a thread is sent: the user's queue, kept in the store, and the system deliveries waiting
// for the thread to be free, each sent as a turn or steered into the running one.

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
} from "@gram/contracts";
import { typedText, userMessage, userParts, authored, typedInput } from "./user-input.ts";
import type { AgentSession } from "@gram/agents";
import { randomUUID } from "node:crypto";
import type { JoinQueued, JoinResult, ThreadRuntimesShape } from "./thread-runtimes-shape.ts";
import { missingThreadFolder } from "../fs/folders.ts";
import type { RuntimeObserver, NotifyObservers, Dispatch } from "./runtime-observer.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { EventHubShape } from "../events/event-hub.ts";
import type { CheckoutServiceShape } from "./hooks.ts";
import type { ThreadWaitsShape } from "../waits/service.ts";
import type { FeedWriter } from "./feed-writer.ts";
import type { TurnLifecycle } from "./turn-lifecycle.ts";
import type { LimitResume } from "./limit-resume.ts";

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
  /** Called with the runtime lock held. Stores the queue with the launch, if any, at its head. */
  const persistQueue = (rt: Runtime) =>
    Effect.suspend(() => {
      // Each notice keeps its key in the store, so a restart can't take it for the user's word.
      const queue = rt.queue.map((item): QueuedInput => {
        const noticeKey = rt.noticeKeys.get(item.id);
        return noticeKey === undefined ? item : { ...item, noticeKey };
      });
      const head = [rt.launch, rt.inFlight].flatMap((item): ReadonlyArray<QueuedInput> => {
        if (item === undefined) return [];
        const noticeKey = rt.noticeKeys.get(item.id);
        return [
          {
            id: item.id,
            input: item.input,
            turnId: item.turnId,
            ...(noticeKey === undefined ? {} : { noticeKey }),
          },
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
        yield* publishMessage(rt, userMessage(input, messageId, turn.id, now), turn.id);
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
      yield* session.send(yield* forAgent(rt, input), { messageId });
    });

  /**
   * Called with the runtime lock held. The transcript records the steered input, wherever it came
   * from: the composer, the queue, or another thread (whose `origin` part names the sender).
   * `false` when the agent refused it (Codex, whose turn can end before ours does): nothing was
   * recorded, and the caller keeps the input, queueing it or handing it back.
   */
  const steerNow = (rt: Runtime, session: AgentSession, turn: Turn, sent: UserInput) =>
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
      const message = {
        id: messageId,
        role: "user",
        parts: userParts(input, messageId),
        metadata: {
          turnId: turn.id,
          createdAt: now,
          ...(input.author === undefined ? {} : { author: input.author }),
        },
      } as unknown as GramUIMessage;
      const read = yield* forAgent(rt, input);
      const taken = yield* session.steer(read).pipe(
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
  const deliverNext = (rt: Runtime, session: AgentSession): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      for (;;) {
        const next = rt.deliveries.entries().next().value;
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
   * Called with the runtime lock held. Starts a waiting delivery if the thread can take one now;
   * a busy thread gets to it from `becomeIdle`.
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
      // A cold thread being closed has no session for the close to stop, so it must not get one.
      if (rt.closing) return yield* failPendingDeliveries(rt, "ended");
      // Held for `whileAtRest`, which pumps again once it lets go.
      if (rt.reserved) return;
      // Held for the limit's resume, which pumps again.
      if (yield* waitWithAccount(rt)) return;
      switch (rt.status) {
        case "ended":
          return yield* failPendingDeliveries(rt, rt.status);
        case "starting":
        case "running":
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
              yield* deliverNext(rt, rt.session);
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
      yield* persistQueue(rt);
      yield* publishMessage(rt, userMessage(input, id, turnId, createdAt), turnId);
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
          // A thread whose folder is gone has nowhere to run: say so, with the path a client can
          // offer to restore, rather than start an agent that fails to spawn or fails every tool.
          const path = (yield* store.getThread(threadId)).checkout.path;
          if (!(yield* checkouts.present(path))) {
            yield* forkStopInMissing(rt);
            return yield* new InvalidState({
              message: missingThreadFolder(path),
              threadId,
              status: rt.status,
              folderMissing: { path },
            });
          }
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
                yield* syncQueue(rt);
                return { queued: true, joined: { queuedAt } };
              }
              const id = makeQueueItemId();
              rt.queue.push({ id, input });
              rt.queuedAt.set(id, { at: now, messages: 1 });
              if (noticeKey !== undefined) rt.noticeKeys.set(id, noticeKey);
              yield* syncQueue(rt);
              return { queued: true };
            });
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
              if (rt.session !== undefined && rt.turn === undefined) {
                yield* sendNow(rt, rt.session, input).pipe(
                  Effect.tapError(() =>
                    // deliverNext settles a carrying delivery itself. A direct send has none, and
                    // the turn sendNow opened never reached the adapter.
                    rt.turn !== undefined && rt.carrying === undefined
                      ? finishTurn(rt, "interrupted", "sendFailed")
                      : Effect.void,
                  ),
                );
                return { queued: false };
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
        (yield* queueHeld(rt))
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
  };
};

/** What `makeMessageQueue` gives the rest of `ThreadRuntimes`. */
export type MessageQueue = ReturnType<typeof makeMessageQueue>;

/** What the queue's `ThreadRuntimes` methods read beside the queue itself. */
export interface QueueMethodsDeps {
  readonly store: ThreadStoreShape;
  readonly checkouts: CheckoutServiceShape;
  readonly runtimes: ReadonlyMap<ThreadId, Runtime>;
  readonly getRuntime: GetRuntime;
  readonly drainQueue: MessageQueue["drainQueue"];
  readonly sendInput: MessageQueue["sendInput"];
  readonly userTyped: MessageQueue["userTyped"];
  readonly syncQueue: MessageQueue["syncQueue"];
  readonly withSession: MessageQueue["withSession"];
  readonly steerNow: MessageQueue["steerNow"];
  readonly withQueue: MessageQueue["withQueue"];
  readonly switchHold: MessageQueue["switchHold"];
  readonly pumpDeliveries: MessageQueue["pumpDeliveries"];
  readonly scheduleAccount: LimitResume["scheduleAccount"];
}

/** The `ThreadRuntimes` methods that queue, edit, steer or deliver a thread's input. */
export const makeQueueMethods = ({
  store,
  checkouts,
  runtimes,
  getRuntime,
  drainQueue,
  sendInput,
  userTyped,
  syncQueue,
  withSession,
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
  sendNotice: (threadId, key, input) =>
    // Marked Gram's in the queue and the transcript, so no restart or steer makes it the user's.
    sendInput(threadId, { ...input, author: "server" }, undefined, key).pipe(
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
  steer: (threadId, sent) =>
    withSession(threadId, (rt, session) => {
      const turn = rt.turn;
      return turn === undefined
        ? Effect.fail(
            new InvalidState({ message: "nothing to steer", threadId, status: rt.status }),
          )
        : steerNow(rt, session, turn, authored(typedInput(sent))).pipe(
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
          );
    }).pipe(Effect.tap(() => userTyped(threadId, sent))),
  editQueued: (threadId, itemId, input) =>
    withQueue(threadId, (rt) =>
      queueIndex(rt, itemId).pipe(
        Effect.map((index) => {
          // Whoever wrote the item still did: an edited notice never becomes the user's words.
          const { author: _, ...edited } = input;
          const author = rt.queue[index]!.input.author;
          rt.queue[index] = {
            id: itemId,
            input: author === undefined ? edited : { ...edited, author },
          };
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
          const turn = rt.turn;
          const session = rt.session;
          if (turn === undefined && NOTHING_RUNNING.has(rt.status) && !rt.closing && !rt.reserved) {
            // Refused as a send there would be.
            const path = (yield* store.getThread(threadId)).checkout.path;
            if (!(yield* checkouts.present(path))) {
              return yield* new InvalidState({
                message: missingThreadFolder(path),
                threadId,
                status: rt.status,
                folderMissing: { path },
              });
            }
            // Nothing to steer into, so the item goes now, ahead of the rest. Sent by hand, a
            // monitor's notice is the user's, which no archive holds back and no newer replaces.
            rt.noticeKeys.delete(itemId);
            rt.queue.unshift(...rt.queue.splice(index, 1));
            yield* syncQueue(rt);
            return yield* drainQueue(rt);
          }
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
