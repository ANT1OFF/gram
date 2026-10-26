// What `ThreadRuntimes` offers the rest of the server, and the inputs its operations take.

import type {
  ThreadId,
  TurnId,
  AgentUnavailable,
  InvalidState,
  NotFound,
  RequestId,
  RequestNotFound,
  QueueItemId,
  Checkout,
  ModelRef,
  PermissionMode,
  UserInput,
  Thread,
  GramUIMessage,
  SendResult,
  WorkerQuiet,
  ThreadNotFound,
  RequestAnswer,
  RespondManyResult,
  GitError,
  WorktreeDirty,
  CompletedReason,
  GramUIMessageChunk,
  MessageId,
  ThreadStatus,
  ThreadSummary,
  ThreadHistoryPage,
  ApprovalRequest,
  RestartMidTurn,
  RestartSessionResult,
  StartSessionResult,
} from "@gram/contracts";
import type { HistoryRewind, ThreadStoreShape, TurnRecord } from "../persistence/thread-store.ts";
import type * as Effect from "effect/Effect";
import type { ResumeHold, QueueHold, TurnHold } from "./turn-holds.ts";
import type * as Scope from "effect/Scope";
import type { ThreadReplay } from "../events/event-hub.ts";
import type { ServerApprovalAnswer } from "./server-approvals.ts";
import type { AgentSession, AppToolRegistryPort, ToolAudience } from "@gram/agents";
import type { McpConfigChange } from "./session-restarts.ts";
import type { SessionPolicyPort } from "./session-policy.ts";
import type { SystemDelivery } from "./system-delivery.ts";
import type { RuntimeObserver } from "./runtime-observer.ts";

export interface CreateThreadInput {
  /** A thread id chosen by the caller; a new one when absent. */
  readonly id?: ThreadId;
  readonly projectRoot: string;
  readonly checkout: Checkout;
  readonly model?: ModelRef;
  readonly mode?: PermissionMode;
  readonly title?: string;
  readonly input?: UserInput;
  /** An existing agent session to continue, e.g. one picked from `sessions.list`. */
  readonly resumeSessionId?: string;
  /** With `resumeSessionId`: the Codex home that session lives in, as `sessions.list` named it. */
  readonly codexHome?: NonNullable<Thread["codexHome"]>;
  /** A closed thread coming back under its own `id`: its kept messages and turns are put back. */
  readonly restoreClosedHistory?: boolean;
  /**
   * With `restoreClosedHistory`: what the closed thread was beyond its conversation, as it was
   * stored, put back in the row. Server-only; thread.create RPC accepts none of these fields.
   * Its bound PR can restore a worktree deleted since.
   */
  readonly kept?: Partial<
    Pick<Thread, "userNamed" | "agentNamed" | "labels" | "pinned" | "boundPr" | "extraPrs">
  >;
  /** Orchestration's fields, in the row from its first insert; only `orchestrator.open` gives a role. */
  readonly role?: NonNullable<Thread["role"]>;
  readonly workspaceId?: NonNullable<Thread["workspaceId"]>;
  readonly spawnedBy?: NonNullable<Thread["spawnedBy"]>;
  readonly additionalDirectories?: ReadonlyArray<string>;
  /** Worktrees in other repos the thread holds beside `checkout` (`Thread.extraCheckouts`). */
  readonly extraCheckouts?: ReadonlyArray<Checkout>;
  /**
   * Leaves a thread without `input` cold instead of opening its session now. An orchestrator's
   * session policy turns on a workspace slot it can only claim once the row exists, so its first
   * open has to wait for the claim.
   */
  readonly deferOpen?: boolean;
}

/** What a caller checked of a thread, for an operation to refuse once it no longer holds. */
export interface ClaimGuard {
  /**
   * The checkout the caller checked: refuse unless the thread is still in it and follows no other,
   * since a move meanwhile would make it the wrong one to act on.
   */
  readonly expectedCheckout?: string;
  /** Refuse unless this still holds of the thread as stored, read under the runtime lock. */
  readonly stillHolds?: (thread: Thread) => boolean;
}

export interface CloseThreadOptions extends ClaimGuard {
  /** Also remove the thread's worktree; `force` discards uncommitted changes. */
  readonly removeWorktree?: { readonly force: boolean };
  readonly permissionRules?: ReadonlyArray<string>;
  /** Refuse with `InvalidState`, stopping nothing, unless the thread is at rest (`atRest`). */
  readonly onlyAtRest?: boolean;
}

/**
 * A rewind to an assistant message keeps it and resumes at its last agent message id. A rewind to
 * a user message drops it (edit / resend from there) and resumes at the previous message; with
 * no previous message the agent starts a fresh session.
 */
export type RewindPlan = HistoryRewind;

/** Where a fork branches off: the source thread and the message the forked conversation ends at. */
export interface ForkPlan {
  readonly source: Thread;
  readonly messageId: string;
  readonly role: GramUIMessage["role"];
  readonly turnId: TurnId | undefined;
  /** The fork point's last agent message id, where the forked agent session resumes. */
  readonly resumeAt: string;
}

export interface ForkOptions {
  readonly checkout: Checkout;
  readonly title?: string | undefined;
}

/**
 * Folds `next` into a queued input from the same sender. `queuedAt` is when the item was queued and
 * `messages` how many it already holds, both as the runtime saw them since the server started: an
 * item queued before that is one message of unknown age.
 */
export type JoinQueued = (
  queued: {
    readonly input: UserInput;
    readonly queuedAt: number | undefined;
    readonly messages: number;
  },
  next: UserInput,
  now: number,
) => UserInput;

export interface JoinResult extends SendResult {
  /** Set when the input joined a queued item rather than queueing one of its own. */
  readonly joined?: { readonly queuedAt: number | undefined } | undefined;
}

export interface NoticeResult extends SendResult {
  /** The running turn took it mid-turn. */
  readonly steered: boolean;
  /** It took the place of an earlier notice with the same key that was still queued. */
  readonly replaced: boolean;
}

export interface ThreadRuntimesShape {
  /** The current silent-tool condition; absent once the turn streams again or ends. */
  quiet(threadId: ThreadId): Effect.Effect<WorkerQuiet | undefined, ThreadNotFound>;
  /** The agent is compacting its context, which streams nothing and may take a minute. */
  compacting(threadId: ThreadId): Effect.Effect<boolean, ThreadNotFound>;
  /** The live activity line while it is busy ("Running uv run pytest"), as its status shows it. */
  activity(threadId: ThreadId): Effect.Effect<string | undefined, ThreadNotFound>;
  create(input: CreateThreadInput): Effect.Effect<Thread, AgentUnavailable | InvalidState>;
  /**
   * Sends now when idle; otherwise joins the runtime-owned queue, sent on the next idle. The agent
   * gets the note on Waiting on you with it, when there is news, as it is sent.
   */
  send(
    threadId: ThreadId,
    input: UserInput,
  ): Effect.Effect<SendResult, ThreadNotFound | InvalidState | AgentUnavailable>;
  /**
   * `send` for a message from another thread. While the thread is busy, an input whose `origin`
   * names the same sender as the queue's last item joins that item through `join` instead of
   * queueing behind it. An item without an `origin` is the user's and is never joined, and neither
   * is a notice or an item something else was queued after, so the queue keeps its order.
   * `joinsWith` replaces the same-sender rule for input that has no sender, such as answers from
   * the board: the last item is joined when it says so of that item as it is then, under the lock.
   */
  sendOrJoin(
    threadId: ThreadId,
    input: UserInput,
    join: JoinQueued,
    joinsWith?: (queued: UserInput) => boolean,
  ): Effect.Effect<JoinResult, ThreadNotFound | InvalidState | AgentUnavailable>;
  steer(threadId: ThreadId, input: UserInput): Effect.Effect<void, ThreadNotFound | InvalidState>;
  /**
   * Delivers a server-authored notice (a PR monitor's): steered into a `running` turn whose agent
   * can take mid-turn input, and otherwise `send`, which a steer that fails falls back to. `key`
   * names what the notice is about, so a newer one replaces an older one with the same key still
   * in the queue, in its place, and the thread only ever reads the newest. It isn't steered past
   * something queued behind that older one. Nothing else in the queue
   * is touched, and an item the user has edited is theirs and no longer replaced. Keys live in
   * memory, so an item queued before a restart is never replaced. Observers don't hear of it as
   * input the user typed.
   */
  sendNotice(
    threadId: ThreadId,
    key: string,
    input: UserInput,
  ): Effect.Effect<NoticeResult, ThreadNotFound | InvalidState | AgentUnavailable>;
  /** Takes every notice `sendNotice` queued under a key `drop` picks out of the queue. */
  dropNotices(threadId: ThreadId, drop: (key: string) => boolean): Effect.Effect<void>;
  /** Interrupts the running turn; after the watchdog, closes the session and resumes it. */
  interrupt(threadId: ThreadId): Effect.Effect<void, ThreadNotFound>;
  /**
   * Asks the open turn to stop at its next tool boundary, never interrupting it: the session's
   * tool gate closes, so every call from now on is refused with `PAUSE_STOP_TEXT` (with no gate the
   * words are steered in), a call already running finishes, and the agent ends its turn itself. A
   * card waiting on the user stays theirs to answer. The session keeps the conversation, and
   * background tasks keep running. `true` when a turn was open.
   */
  stopAtToolBoundary(threadId: ThreadId): Effect.Effect<boolean, ThreadNotFound>;
  /** Resumes a thread waiting out a limit now, as its timer would; nothing without a wait. */
  resumeLimitWait(threadId: ThreadId): Effect.Effect<void, ThreadNotFound>;
  /** Stops a thread's limit wait: no resume comes, and it stands failed until the user sends. */
  cancelLimitWait(threadId: ThreadId): Effect.Effect<void, ThreadNotFound>;
  /** Adds a hold every timed resume asks first, for as long as the scope lasts. */
  holdResumes(hold: ResumeHold): Effect.Effect<void, never, Scope.Scope>;
  /** Adds a hold an idle thread asks before its queue starts a turn, for as long as the scope lasts. */
  holdQueues(hold: QueueHold): Effect.Effect<void, never, Scope.Scope>;
  /** Adds a hold a turn the agent opens by itself asks, for as long as the scope lasts. */
  holdAgentTurns(hold: TurnHold): Effect.Effect<void, never, Scope.Scope>;
  /** Sends what a queue hold kept waiting, now that it lets go; nothing when the queue is empty. */
  releaseQueue(threadId: ThreadId): Effect.Effect<void>;
  /**
   * Stops the thread's session, ending any turn as interrupted, once its folder is gone: an agent
   * left running in a deleted folder fails every tool. The thread goes cold, and is told when a
   * turn was cut short. Nothing happens while the folder is there, or with no session.
   */
  stopInMissingFolder(threadId: ThreadId): Effect.Effect<void>;
  /** Stops one of the session's background tasks; `NotFound` when it isn't running. */
  stopTask(
    threadId: ThreadId,
    taskId: string,
  ): Effect.Effect<void, ThreadNotFound | NotFound | InvalidState>;
  respond(
    threadId: ThreadId,
    requestId: RequestId,
    answer: RequestAnswer,
  ): Effect.Effect<void, ThreadNotFound | RequestNotFound | InvalidState>;
  /**
   * `respond` for each answer in turn, one after the other, so an inbox can answer a group of
   * requests in one call. One that fails says why in its own row and the rest still go; the
   * effect itself never fails.
   */
  respondMany(
    answers: ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly requestId: RequestId;
      readonly answer: RequestAnswer;
    }>,
  ): Effect.Effect<ReadonlyArray<RespondManyResult>>;
  /**
   * A live session is asked first and the mode is only recorded once it accepts, so the thread
   * never shows a mode its agent refused. `InvalidState` carries the agent's reason.
   */
  setMode(
    threadId: ThreadId,
    mode: PermissionMode,
  ): Effect.Effect<void, ThreadNotFound | InvalidState>;
  setModel(
    threadId: ThreadId,
    model: ModelRef,
  ): Effect.Effect<void, ThreadNotFound | AgentUnavailable | InvalidState>;
  /** Persists a thread edit, publishes `thread.upsert`, and applies pin/park side effects. */
  updateThread: ThreadStoreShape["updateThread"];
  /**
   * Stops the session, releases the checkout, then removes the thread. A thread has one close at a
   * time: a caller that comes while one runs waits for it and, should it fail, tries its own with
   * its own options. One that succeeded without the worktree removal a waiting caller asked for
   * fails that caller with `InvalidState`. Interrupting a caller leaves the close to finish.
   */
  close(
    threadId: ThreadId,
    options?: CloseThreadOptions,
  ): Effect.Effect<void, ThreadNotFound | GitError | WorktreeDirty | InvalidState>;
  /**
   * Runs `release` once no close of the thread is running: at once, or when the running one ends.
   * For what a caller holds around `close` (a git watcher, the terminal gate), whose wait for it may
   * be interrupted while the close goes on.
   */
  releaseAfterClose(threadId: ThreadId, release: Effect.Effect<void>): Effect.Effect<void>;
  editQueued(
    threadId: ThreadId,
    itemId: QueueItemId,
    input: UserInput,
  ): Effect.Effect<void, ThreadNotFound | NotFound>;
  /** `itemIds` must list every queued item exactly once. */
  reorderQueue(
    threadId: ThreadId,
    itemIds: ReadonlyArray<QueueItemId>,
  ): Effect.Effect<void, ThreadNotFound | InvalidState>;
  removeQueued(
    threadId: ThreadId,
    itemId: QueueItemId,
  ): Effect.Effect<void, ThreadNotFound | NotFound>;
  /**
   * Injects a queued item into the running turn instead of waiting for the turn to end. The item
   * leaves the queue only once the agent has taken it, so a rejected steer loses nothing. With
   * nothing running, it is sent now, ahead of the rest of the queue.
   */
  steerQueued(
    threadId: ThreadId,
    itemId: QueueItemId,
  ): Effect.Effect<void, ThreadNotFound | NotFound | InvalidState>;
  /** Sets or clears `completedAt`, the only settle marker, with its reason. */
  markCompleted(
    threadId: ThreadId,
    reason: CompletedReason | undefined,
  ): Effect.Effect<Thread, ThreadNotFound>;
  /**
   * Edits the thread's completion as the store's transaction reads it (`updateCompletion`), and
   * publishes the thread when `f` changed it; `f` returns `undefined` to leave it be.
   */
  updateCompletion(
    threadId: ThreadId,
    f: (thread: Thread) => Thread | undefined,
  ): Effect.Effect<{ readonly thread: Thread; readonly changed: boolean }, ThreadNotFound>;
  /** Appends a data part (from an app tool) to the in-flight message, or to a new message. */
  emitChunk(
    threadId: ThreadId,
    chunk: GramUIMessageChunk,
  ): Effect.Effect<MessageId, ThreadNotFound>;
  /** Replaces a data part by type + id in `messageId`, in flight or finished. */
  updateDataPart(
    threadId: ThreadId,
    messageId: string,
    chunk: GramUIMessageChunk,
  ): Effect.Effect<void, ThreadNotFound>;
  status(threadId: ThreadId): Effect.Effect<ThreadStatus, ThreadNotFound>;
  /**
   * Runs `effect` while the thread stays at rest: refuses with `InvalidState`, running nothing,
   * unless it is cold (no session, so no agent can start anything of its own) and at rest by the
   * test `onlyAtRest` closes by, pending requests included; likewise when `guard` no longer holds.
   * Until `effect` ends, sends are turned away and system deliveries wait. For work on its checkout
   * nobody asked of the thread by name.
   */
  whileAtRest<A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
    guard?: ClaimGuard,
  ): Effect.Effect<A, E | ThreadNotFound | InvalidState, R>;
  readonly snapshot: Effect.Effect<ReadonlyArray<ThreadSummary>>;
  /** One thread's entry in `snapshot`, without building the others'; `undefined` when not found. */
  summaryOf(threadId: ThreadId): Effect.Effect<ThreadSummary | undefined>;
  /** The turns this server closed at boot because the previous run was cut off in them. */
  readonly cutAtBoot: ReadonlyArray<TurnRecord>;
  /**
   * Sends what the previous run left queued in each thread that isn't archived, opening its
   * session. Run once at boot, after the session policy is set; an archived thread's queue waits
   * for it to come back.
   */
  readonly sendQueuedAtBoot: Effect.Effect<void>;
  /**
   * How many threads a quit would cut off: with a turn open (running, or waiting on an approval or an
   * answer), or with a background shell, subagent or monitor still going. Terminal tabs aren't
   * runtimes; `app.diagnostics` adds those.
   */
  readonly working: Effect.Effect<ReadonlyArray<ThreadId>>;
  /** Each open agent session's own OS process, where the agent runs one locally. */
  readonly processIds: Effect.Effect<ReadonlyArray<readonly [ThreadId, number]>>;
  /**
   * Stops every agent session for the server's shutdown. From then on sends are refused and no
   * session opens. A turn this cuts off keeps what it streamed but is itself left open, as a kill
   * leaves it, so the next boot records it interrupted and continues it (`cutAtBoot`): finished
   * now, it would read as an error and run its end checkpoint, whose git calls can outlast a quit.
   */
  readonly shutdown: Effect.Effect<void>;
  /** Refuses sends and new sessions from now on, as `shutdown` does, without stopping any. */
  readonly stopAccepting: Effect.Effect<void>;
  /** How many agent sessions are open. */
  readonly openSessions: Effect.Effect<number>;
  /**
   * What a subscription starts with: the last `FEED_WINDOW_TURNS` turns. With `afterRev`, only the
   * messages written since, from `from` on, when that is a revision the thread can resume from and
   * no more than `RESUME_MAX_MESSAGES` changed.
   */
  replay(
    threadId: ThreadId,
    afterRev?: number,
    from?: string,
  ): Effect.Effect<ThreadReplay, ThreadNotFound>;
  /** A page of the thread's history before `before`, for a feed scrolled back to its start. */
  history(threadId: ThreadId, before: string): Effect.Effect<ThreadHistoryPage, ThreadNotFound>;
  /**
   * The thread's messages still streaming, as they stand now: a big one is stored less often than
   * its parts complete (`PERSIST_SPACING`), so what is stored can be behind. Empty for a thread at rest.
   */
  readonly liveMessages: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<GramUIMessage>>;
  /** Validates a rewind to `messageId` and works out where the agent resumes. */
  rewindTarget(
    threadId: ThreadId,
    messageId: string,
  ): Effect.Effect<RewindPlan, ThreadNotFound | InvalidState>;
  /**
   * Drops the conversation past the plan's message, republishes the history, and reopens the agent
   * at `resumeAt` (or fresh). An optional trusted checkpoint effect runs only after final
   * provenance admission in the same SQL transaction, before commit and feed publication.
   */
  rewind(
    threadId: ThreadId,
    plan: RewindPlan,
    restoreFiles?: Effect.Effect<void, GitError>,
  ): Effect.Effect<void, ThreadNotFound | InvalidState | GitError>;
  /** Validates forking `threadId` at `messageId`, or at its latest message. */
  forkTarget(
    threadId: ThreadId,
    messageId: string | undefined,
  ): Effect.Effect<ForkPlan, ThreadNotFound | InvalidState>;
  /**
   * Creates the fork in `checkout` with the conversation up to the plan's message. A checkout with
   * an open session is refused. The fork's agent session opens on its first send, forking the
   * source session at `resumeAt`.
   */
  fork(plan: ForkPlan, options: ForkOptions): Effect.Effect<Thread, InvalidState>;
  /**
   * Sets the checkout the thread is working in without touching its session (`undefined`, or its own
   * checkout, returns it there) and publishes `thread.upsert`. The path for followed worktree moves;
   * app tools that relocate the session use `moveCheckout`.
   */
  setCurrentCheckout(
    threadId: ThreadId,
    checkout: Checkout | undefined,
  ): Effect.Effect<Thread, ThreadNotFound>;
  /**
   * Raises an approval card that the server answers itself, for app tool calls, whatever the agent.
   * Waits for `respond`; the turn ending or the session closing denies it.
   */
  requestApproval(
    threadId: ThreadId,
    request: Omit<ApprovalRequest, "kind" | "id">,
  ): Effect.Effect<ServerApprovalAnswer, ThreadNotFound>;
  /** The live agent session, for app tools that drive it directly. */
  session(threadId: ThreadId): Effect.Effect<AgentSession, ThreadNotFound | InvalidState>;
  /**
   * Moves the thread to `checkout`, dropping any followed worktree. A live session reopens there once
   * it's idle.
   */
  moveCheckout(threadId: ThreadId, checkout: Checkout): Effect.Effect<Thread, ThreadNotFound>;
  /** Grants the agent extra folders: live when the host can, otherwise on reopen once idle. */
  addDirectories(
    threadId: ThreadId,
    paths: ReadonlyArray<string>,
  ): Effect.Effect<Thread, ThreadNotFound>;
  /**
   * Reopens a live session once it's idle so it reloads its config (MCP servers), resuming the
   * conversation; one still opening reopens at its first idle, since it read the old config.
   * `noSession` when nothing is open or opening; the next session loads the config anyway.
   */
  reloadSession(threadId: ThreadId): Effect.Effect<"reopening" | "noSession", ThreadNotFound>;
  /**
   * Restarts the thread's agent session so the agent reads its setup from disk again: the host drops
   * what it keeps across sessions for the thread's profile (`AgentHost.reloadConfig`), the session
   * stops by the path an eviction takes and opens again on the same conversation, and the transcript
   * gets a `session-restart` marker once it is up. A running turn is waited for, or with `interrupt`
   * ended as interrupted first. With no session open, a thread with a conversation has one opened
   * (the retry after a failed restart); one without answers `noSession`. Refused once the thread is
   * closing or ended, while its session starts, while its checkout is reserved, and when its folder
   * is gone.
   */
  restartSession(
    threadId: ThreadId,
    midTurn?: RestartMidTurn,
  ): Effect.Effect<RestartSessionResult, ThreadNotFound | InvalidState>;
  /**
   * Opens a cold or evicted thread's agent session with no turn and no prompt, by the path creating
   * a thread takes, so what the session reports can be shown: the Connectors tab asks when it is
   * shown. The session connects the thread's MCP servers exactly as its next message would, which
   * is the thread starting itself, not a reader looking: readers still connect nothing. `open` when
   * a session is open or opening already; it is evicted when idle like any other. Refused once the
   * thread is closing or ended, for an archived thread and a dream, while its checkout is reserved,
   * while input waits in its queue, and when its folder is gone. A paused workspace is the caller's
   * to ask about.
   */
  startSession(
    threadId: ThreadId,
  ): Effect.Effect<StartSessionResult, ThreadNotFound | InvalidState>;
  /**
   * An agent's MCP config changed (`change`): unless `agents.restartOnMcpChange` is off, each live
   * session it reaches restarts as `restartSession` does, with a `mcpConfig` divider, once it has
   * no turn open, nothing queued or waiting to be delivered, no request open and no background task
   * running. The host drops what it keeps once per profile now, so a session opened from here on
   * reads the new config. Until its restart a thread's summary carries `pendingRestart`; a session
   * that ends first needs nothing, and loses it. Returns the threads marked.
   */
  mcpConfigChanged(change: McpConfigChange): Effect.Effect<ReadonlyArray<ThreadId>>;
  /**
   * Forgets the thread's agent session and opens a fresh one in its place: the same thread,
   * transcript and queue, a new `agentSessionId`, and nothing of the old conversation in the agent's
   * context. Returns the id it replaced, whose transcript is left where
   * it is. Refused while a turn is open, while the session is starting or waits on a request, once
   * the thread has ended, and for a fork, which would reopen by forking its source again. Messages
   * from before it can no longer be rewound or forked to: see `beforeHandoff`.
   */
  claimSessionSwitch(
    threadId: ThreadId,
    change: NonNullable<Thread["sessionSwitch"]>,
  ): Effect.Effect<Thread, ThreadNotFound | InvalidState>;
  switchSession(
    threadId: ThreadId,
    attemptId: string,
  ): Effect.Effect<string | undefined, ThreadNotFound | InvalidState | AgentUnavailable>;
  cancelSessionSwitch(
    threadId: ThreadId,
    attemptId: string,
  ): Effect.Effect<void, ThreadNotFound | InvalidState>;
  releaseSwitch(
    threadId: ThreadId,
    attemptId: string,
  ): Effect.Effect<void, ThreadNotFound | InvalidState>;
  freshSession(
    threadId: ThreadId,
  ): Effect.Effect<string | undefined, ThreadNotFound | InvalidState>;
  /** Late-bound: the app-tool registry depends on this service. */
  setAppTools(port: AppToolRegistryPort): Effect.Effect<void>;
  /** Late-bound like `setAppTools`: what a thread's role adds to its sessions. Absent, every thread is plain. */
  setSessionPolicy(port: SessionPolicyPort): Effect.Effect<void>;
  /** Who the thread is to the app tools, by the session policy; `plain` for an unknown thread. */
  audienceOf(threadId: ThreadId): Effect.Effect<ToolAudience>;
  /**
   * Sends one server-authored input per `(threadId, key)` as a turn of its own, as soon as the
   * thread can take it. It is held in memory and never
   * joins the user's queue, so it isn't in `ThreadSummary.queue`, isn't persisted, and can't be
   * edited, removed, reordered or steered. Queued user input goes first. A request whose key is
   * still waiting replaces that one, which then hears nothing. A `cold` thread is opened for it; an
   * `error` or `ended` one fails it at once, and a thread that gets there fails what is waiting.
   * Returns once the request is recorded (and sent, when the thread was idle), not on acceptance.
   */
  requestSystemDelivery(
    threadId: ThreadId,
    key: string,
    delivery: SystemDelivery,
  ): Effect.Effect<void, ThreadNotFound>;
  /** Drops a delivery that hasn't been sent; one a turn already carries still reports its outcome. */
  cancelSystemDelivery(threadId: ThreadId, key: string): Effect.Effect<void>;
  /** Registers `observer` until the scope closes. */
  observe(observer: RuntimeObserver): Effect.Effect<void, never, Scope.Scope>;
}
