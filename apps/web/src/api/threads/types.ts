import type {
  BabysitBudget,
  CheckoutUsers,
  ClosedThread,
  ReopenedClosedThread,
  MessageId,
  ModelRef,
  PermissionMode,
  PlanEdit,
  QueueItemId,
  RequestAnswer,
  RequestId,
  RespondManyResult,
  RestartMidTurn,
  RestartSessionResult,
  RestoreWorktreeResult,
  ReviewMonitorResult,
  SendResult,
  StartSessionResult,
  TaskId,
  Thread,
  ThreadHistoryPage,
  ThreadId,
  ThreadLabels,
  ThreadPlan,
  ThreadSearchResult,
  UserInput,
  WorktreeRemoval,
} from "@gram/contracts";

import type {
  ApiServerEvent,
  ApiThreadFeedEvent,
  CloseThreadOptions,
  CreateThreadInput,
  FeedResume,
  ForkThreadOptions,
  RespondManyAnswer,
  SearchThreadsOptions,
} from "../types";

/** A thread: its feed and history, its turns and queue, and the sidebar and close actions on it. */
export interface ThreadsApi {
  events(signal: AbortSignal): AsyncIterable<ApiServerEvent>;
  /**
   * The thread's feed, resubscribed after a drop. `resume` is asked before each subscription where
   * to resume from (`ThreadFeed.resume`); without it, or when it answers `undefined`, each one
   * starts with the recent history.
   */
  threadFeed(
    threadId: ThreadId,
    signal: AbortSignal,
    resume?: () => FeedResume | undefined,
  ): AsyncIterable<ApiThreadFeedEvent>;
  /** The page of history before `before` (`thread.history`). */
  threadHistory(threadId: ThreadId, before: string): Promise<ThreadHistoryPage>;
  createThread(input: CreateThreadInput): Promise<Thread>;
  send(threadId: ThreadId, input: UserInput): Promise<SendResult>;
  steer(threadId: ThreadId, input: UserInput): Promise<void>;
  interrupt(threadId: ThreadId): Promise<void>;
  /** Resumes a thread waiting out a provider limit now. */
  resumeLimitWait(threadId: ThreadId): Promise<void>;
  /** Stops a thread's limit wait; it stands failed until the user sends. */
  cancelLimitWait(threadId: ThreadId): Promise<void>;
  /**
   * Restarts the agent session on the same conversation, so the agent reads its config from disk
   * again (`thread.restartSession`). `midTurn` is what a running turn gets: `afterTurn` by default.
   */
  restartSession(threadId: ThreadId, midTurn?: RestartMidTurn): Promise<RestartSessionResult>;
  /**
   * Opens a cold thread's session with no turn (`thread.startSession`), which connects its MCP
   * servers as a message would; `open` when one is open or opening already.
   */
  startSession(threadId: ThreadId): Promise<StartSessionResult>;
  /**
   * Stops one of the agent's background tasks. Rejects with `NotFound` when it isn't running and
   * `InvalidState` when the agent can't stop one; its end arrives as a `thread.background` event.
   */
  stopTask(threadId: ThreadId, taskId: string): Promise<void>;
  respond(threadId: ThreadId, requestId: RequestId, answer: RequestAnswer): Promise<void>;
  /**
   * Several answers in one round trip, given in order. Never rejects for one of them: a request
   * already answered or a thread since closed says so in its own row, and the rest still go out.
   */
  respondMany(answers: readonly RespondManyAnswer[]): Promise<readonly RespondManyResult[]>;
  setMode(threadId: ThreadId, mode: PermissionMode): Promise<void>;
  setModel(threadId: ThreadId, model: ModelRef): Promise<void>;
  rename(threadId: ThreadId, title: string): Promise<void>;
  /** Gives the thread a folder outside its checkout; resolves to the folder granted. */
  addDirectory(threadId: ThreadId, path: string): Promise<string>;
  /**
   * The user's edit of the thread's plan: every step, in order. Changed and new steps become the
   * user's and are locked against the helper. Resolves to the saved plan, `null` when the edit
   * emptied it; the change also arrives as `thread.plan`.
   */
  setPlan(threadId: ThreadId, plan: PlanEdit): Promise<ThreadPlan | null>;
  /**
   * Has the helper bring the plan up to date now; `rebuild` re-derives every step nobody locked.
   * Resolves to the plan as it then is, unchanged when the helper is off or out of budget.
   */
  refreshPlan(threadId: ThreadId, rebuild?: boolean): Promise<ThreadPlan | null>;
  pin(threadId: ThreadId, pinned: boolean): Promise<void>;
  park(threadId: ThreadId, parked: boolean): Promise<void>;
  /** The manually ordered sidebar, top to bottom; each thread's `sortOrder` becomes its index. */
  reorderThreads(threadIds: readonly ThreadId[]): Promise<void>;
  label(threadId: ThreadId, labels: ThreadLabels): Promise<void>;
  markUnread(threadId: ThreadId, unread: boolean): Promise<void>;
  /**
   * Babysit mode on the thread's PR. Enabling binds the branch's PR if needed, turns on its review
   * monitor and resets the counters; the change arrives as `thread.upsert`.
   */
  threadSetBabysit(threadId: ThreadId, enabled: boolean, budget?: BabysitBudget): Promise<Thread>;
  /**
   * Watches review-bot rounds on the thread's PR, binding the branch's PR first if none is bound.
   * The change arrives as `thread.upsert`.
   */
  threadSetReviewMonitor(threadId: ThreadId, enabled: boolean): Promise<ReviewMonitorResult>;
  /**
   * Stops the thread and removes it from the list. Its folder stays on disk unless
   * `options.removeWorktree`; a dirty worktree then rejects with `WorktreeDirty` unless forced.
   */
  closeThread(threadId: ThreadId, options?: CloseThreadOptions): Promise<WorktreeRemoval>;
  /**
   * Recreates the thread's worktree deleted outside Gram, on its branch; with `fromPr`, a
   * branch gone from the repo and `origin` comes back from its PR's head.
   */
  restoreWorktree(threadId: ThreadId, fromPr?: boolean): Promise<RestoreWorktreeResult>;
  /** The last closed threads, newest first, each marked with what changed since. */
  listClosedThreads(): Promise<readonly ClosedThread[]>;
  /**
   * Takes the newest closed thread off the list and opens it again, its place in a workspace
   * included, or names the thread that shows its session; `null` when there are none.
   */
  reopenClosedThread(): Promise<ReopenedClosedThread | null>;
  /** Permission rules approved in the thread's worktree that the main checkout doesn't have yet. */
  pendingPermissions(threadId: ThreadId): Promise<readonly string[]>;
  /**
   * Rewinds the conversation to `toMessageId`: an assistant target is kept, a user target is
   * removed (it's about to be replaced by an edit). `files` also restores the working tree. The
   * feed re-sends `messages` afterwards.
   */
  rewind(threadId: ThreadId, toMessageId: MessageId, files: boolean): Promise<void>;
  /** A new thread with the conversation up to `options.fromMessageId`; `forkedFrom` names the source. */
  forkThread(threadId: ThreadId, options?: ForkThreadOptions): Promise<Thread>;
  /** Full-text search over messages, across threads or within `options.threadId`. */
  searchThreads(query: string, options?: SearchThreadsOptions): Promise<ThreadSearchResult>;
  queueEdit(threadId: ThreadId, itemId: QueueItemId, input: UserInput): Promise<void>;
  /** Every queued item id, in the new order. */
  queueReorder(threadId: ThreadId, itemIds: readonly QueueItemId[]): Promise<void>;
  queueRemove(threadId: ThreadId, itemId: QueueItemId): Promise<void>;
  /** Injects a queued item into the running turn; it leaves the queue only once the agent takes it. */
  queueSteer(threadId: ThreadId, itemId: QueueItemId): Promise<void>;
  acceptTask(threadId: ThreadId, taskId: TaskId): Promise<Thread>;
  dismissTask(threadId: ThreadId, taskId: TaskId): Promise<void>;
  /**
   * A worktree on the PR's head branch in `projectRoot` and a thread there following the PR. `repo`
   * (`owner/repo`) defaults to the project's own repository.
   */
  prCheckout(projectRoot: string, number: number, repo?: string): Promise<Thread>;
  /** The open threads (parked ones too) already using the checkout at `path`. */
  checkoutUsers(path: string): Promise<CheckoutUsers>;
}
