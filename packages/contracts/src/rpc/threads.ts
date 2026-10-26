import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { DraftId } from "../attachments.ts";
import { BabysitBudget } from "../babysit.ts";
import { CheckoutInUse, CheckoutUsers, CheckoutUsersPayload } from "../checkout-use.ts";
import { ClosedThread, ReopenedClosedThread } from "../closed-threads.ts";
import { CodexHome } from "../codex-home.ts";
import {
  SupportedModelRef,
  PermissionMode,
  RequestAnswer,
  Thread,
  ThreadLabels,
  UserInput,
} from "../domain.ts";
import {
  AgentUnavailable,
  GitError,
  InterruptHung,
  InvalidState,
  NotFound,
  RequestNotFound,
  ThreadNotFound,
  WorktreeDirty,
} from "../errors.ts";
import { FeedRev, ShowPanelFields, ThreadFeedEvent } from "../events.ts";
import { MessageId, QueueItemId, RequestId, TaskId, ThreadId } from "../ids.ts";
import { ThreadWakes } from "../orchestration.ts";
import { ReviewMonitorResult } from "../review-monitor.ts";
import { ReorderThreadsPayload } from "../sidebar.ts";
import { PlanEdit, ThreadPlan } from "../thread-plan.ts";
import { WAIT_TITLE_MAX, WaitId, WaitItem, WaitKind, WaitListState } from "../waits.ts";
import {
  CheckoutRequest,
  RespondManyResult,
  RestartMidTurn,
  RestartSessionResult,
  SendResult,
  StartSessionResult,
  ThreadHistoryPage,
  ThreadSearchResult,
} from "../threads.ts";
import { RestoreWorktreeResult, WorktreeRemoval } from "../worktrees.ts";
import { PositiveInt, errors, threadRef } from "./shared.ts";

/** Threads: their lifecycle, turns, queue, feed and history, and what the sidebar asks of them. */
export const ThreadRpcs = RpcGroup.make(
  Rpc.make("thread.create", {
    payload: {
      projectRoot: Schema.String,
      checkout: CheckoutRequest,
      model: Schema.optionalKey(SupportedModelRef),
      mode: Schema.optionalKey(PermissionMode),
      title: Schema.optionalKey(Schema.String),
      /** First prompt; omit to open a warm draft. */
      input: Schema.optionalKey(UserInput),
      /** Continue this agent session (see `sessions.list`) instead of starting a fresh one. */
      resumeSessionId: Schema.optionalKey(Schema.String),
      /** With `resumeSessionId`: the Codex home `sessions.list` named for that session. */
      codexHome: Schema.optionalKey(CodexHome),
      /** Adopts the attachments staged for this `/new` draft before the first input is sent. */
      draftId: Schema.optionalKey(DraftId),
    },
    success: Thread,
    error: errors(NotFound, AgentUnavailable, GitError, InvalidState, CheckoutInUse),
  }),
  Rpc.make("thread.send", {
    payload: { ...threadRef, input: UserInput },
    success: SendResult,
    error: errors(ThreadNotFound, InvalidState, AgentUnavailable),
  }),
  Rpc.make("thread.steer", {
    payload: { ...threadRef, input: UserInput },
    error: errors(ThreadNotFound, InvalidState),
  }),
  Rpc.make("thread.interrupt", {
    payload: threadRef,
    error: errors(ThreadNotFound, InterruptHung),
  }),
  /** Resumes a thread waiting out a provider limit (`Thread.limitWait`) now; nothing without one. */
  Rpc.make("thread.resumeLimitWait", { payload: threadRef, error: errors(ThreadNotFound) }),
  /** Stops a thread's limit wait: no resume comes, and it stands failed until the user sends. */
  Rpc.make("thread.cancelLimitWait", { payload: threadRef, error: errors(ThreadNotFound) }),
  /**
   * Stops the thread's agent session and opens it again on the same conversation, so the agent
   * reads its settings, MCP servers, connectors, instructions, skills and CLI from disk afresh. A
   * thread with no session open but a conversation has one opened. `midTurn` says what a running
   * turn gets, `afterTurn` when absent. `InvalidState` for a closed thread, one whose folder is
   * gone, and one whose session is still starting.
   */
  Rpc.make("thread.restartSession", {
    payload: { ...threadRef, midTurn: Schema.optionalKey(RestartMidTurn) },
    success: RestartSessionResult,
    error: errors(ThreadNotFound, InvalidState),
  }),
  /**
   * Opens a cold thread's agent session with no turn, connecting its MCP servers as a message
   * would, so its Connectors tab can list them live. `InvalidState` for a closed or archived
   * thread, a dream, and one whose folder is gone.
   */
  Rpc.make("thread.startSession", {
    payload: threadRef,
    success: StartSessionResult,
    error: errors(ThreadNotFound, InvalidState),
  }),
  /** Stops one of the agent's background tasks; its end arrives as a `thread.background` without it. */
  Rpc.make("thread.stopTask", {
    payload: { ...threadRef, taskId: Schema.String },
    error: errors(ThreadNotFound, NotFound, InvalidState),
  }),
  Rpc.make("thread.respond", {
    payload: { ...threadRef, requestId: RequestId, answer: RequestAnswer },
    error: errors(ThreadNotFound, RequestNotFound, InvalidState),
  }),
  /**
   * Several answers in one round trip, for the approvals inbox that answers a group of identical
   * requests at once. They are given in order, and one that fails
   * (a request already answered, a thread since closed) says so in its own row without stopping
   * the rest, so the call itself only fails when the payload doesn't decode.
   */
  Rpc.make("thread.respondMany", {
    payload: {
      answers: Schema.Array(
        Schema.Struct({ threadId: ThreadId, requestId: RequestId, answer: RequestAnswer }),
      ),
    },
    success: Schema.Array(RespondManyResult),
    error: errors(),
  }),
  Rpc.make("thread.setMode", {
    payload: { ...threadRef, mode: PermissionMode },
    error: errors(ThreadNotFound, InvalidState),
  }),
  Rpc.make("thread.setModel", {
    payload: { ...threadRef, model: SupportedModelRef },
    error: errors(ThreadNotFound, InvalidState, AgentUnavailable),
  }),
  /** `InvalidState`: a turn is running, or the message has no agent ids to resume from. */
  Rpc.make("thread.fork", {
    payload: {
      ...threadRef,
      /** Fork after this message; omit to fork at the latest message. */
      fromMessageId: Schema.optionalKey(MessageId),
      /** Defaults to the source thread's checkout; `newWorktree` forks into a new worktree. */
      checkout: Schema.optionalKey(CheckoutRequest),
      title: Schema.optionalKey(Schema.String),
    },
    success: Thread,
    error: errors(
      ThreadNotFound,
      InvalidState,
      NotFound,
      GitError,
      WorktreeDirty,
      AgentUnavailable,
    ),
  }),
  Rpc.make("thread.rewind", {
    payload: { ...threadRef, toMessageId: MessageId, files: Schema.Boolean },
    error: errors(ThreadNotFound, InvalidState, GitError),
  }),
  Rpc.make("thread.rename", {
    payload: { ...threadRef, title: Schema.String },
    error: errors(ThreadNotFound),
  }),
  /**
   * Gives the thread's agent a folder outside its checkout, as `/add-dir` does in a terminal. A
   * relative `path` is from the checkout and `~` is home; answers the folder granted.
   */
  Rpc.make("thread.addDirectory", {
    payload: { ...threadRef, path: Schema.String },
    success: Schema.String,
    error: errors(ThreadNotFound, NotFound, InvalidState),
  }),
  Rpc.make("thread.pin", {
    payload: { ...threadRef, pinned: Schema.Boolean },
    error: errors(ThreadNotFound),
  }),
  Rpc.make("thread.park", {
    payload: { ...threadRef, parked: Schema.Boolean },
    error: errors(ThreadNotFound),
  }),
  Rpc.make("thread.label", {
    payload: { ...threadRef, labels: ThreadLabels },
    error: errors(ThreadNotFound, NotFound),
  }),
  Rpc.make("thread.close", {
    payload: {
      ...threadRef,
      /**
       * Also remove the thread's worktree; `force` discards uncommitted changes. `deleteBranch` also
       * deletes its local branch, merged through that PR, when the server's check says it's safe.
       */
      removeWorktree: Schema.optionalKey(
        Schema.Struct({
          force: Schema.Boolean,
          deleteBranch: Schema.optionalKey(
            Schema.Struct({ repo: Schema.String, number: Schema.Int }),
          ),
        }),
      ),
      /** Rules from `worktree.pendingPermissions` to union back, once the removal succeeds. */
      permissionRules: Schema.optionalKey(Schema.Array(Schema.String)),
      /**
       * Refuse with `InvalidState`, stopping nothing, unless the thread is at rest: no turn, nothing
       * queued, waiting on the user or running in the background. For closes nobody asked of this
       * thread by name, such as the Worktrees dialog's bulk removal of finished workers.
       */
      onlyAtRest: Schema.optionalKey(Schema.Boolean),
    },
    success: WorktreeRemoval,
    error: errors(ThreadNotFound, WorktreeDirty, GitError, InvalidState),
  }),
  /**
   * Recreates a thread's worktree deleted outside Gram, at its recorded path on its branch,
   * and seeds it as a new worktree is. With `fromPr`, a branch gone from the repo and `origin` is
   * recreated from its PR's head.
   */
  Rpc.make("thread.restoreWorktree", {
    payload: { ...threadRef, fromPr: Schema.optionalKey(Schema.Boolean) },
    success: RestoreWorktreeResult,
    error: errors(ThreadNotFound, InvalidState, GitError, CheckoutInUse),
  }),
  Rpc.make("thread.queue.edit", {
    payload: { ...threadRef, itemId: QueueItemId, input: UserInput },
    error: errors(ThreadNotFound, NotFound),
  }),
  Rpc.make("thread.queue.reorder", {
    /** Every queued item id, in the new order. */
    payload: { ...threadRef, itemIds: Schema.Array(QueueItemId) },
    error: errors(ThreadNotFound, InvalidState),
  }),
  Rpc.make("thread.queue.remove", {
    payload: { ...threadRef, itemId: QueueItemId },
    error: errors(ThreadNotFound, NotFound),
  }),
  /**
   * Injects a queued item into the running turn; it leaves the queue only once the agent takes it.
   * With no turn running, the item is sent now.
   */
  Rpc.make("thread.queue.steer", {
    payload: { ...threadRef, itemId: QueueItemId },
    error: errors(ThreadNotFound, NotFound, InvalidState),
  }),
  Rpc.make("thread.markUnread", {
    payload: { ...threadRef, unread: Schema.Boolean },
    error: errors(ThreadNotFound),
  }),
  /**
   * The user's edit of the thread's plan: every step it lists, in order. A step whose text, status
   * or PR changed, and a new one, become the user's and are locked against the helper. An edit with
   * no goal and no steps removes the plan, and answers `null`.
   */
  Rpc.make("thread.setPlan", {
    payload: { ...threadRef, plan: PlanEdit },
    success: Schema.NullOr(ThreadPlan),
    error: errors(ThreadNotFound),
  }),
  /**
   * Asks the helper to bring the thread's plan up to date now (Refresh), or with `rebuild` to drop
   * its unlocked steps and derive them again from the whole thread. Answers the plan as it then is;
   * with the helper off or out of budget, the plan unchanged.
   */
  Rpc.make("thread.refreshPlan", {
    payload: { ...threadRef, rebuild: Schema.optionalKey(Schema.Boolean) },
    success: Schema.NullOr(ThreadPlan),
    error: errors(ThreadNotFound),
  }),
  /**
   * The user's Done on a Waiting on you item, or with `undo` its reopening. Answers the item as it
   * then is; the thread's open items also arrive as `thread.waits`. The agent hears of it with the
   * next note, not now. `undo` fails with `InvalidState` while `MAX_OPEN_WAITS` are open.
   */
  Rpc.make("thread.resolveWait", {
    payload: { ...threadRef, id: WaitId, undo: Schema.optionalKey(Schema.Boolean) },
    success: WaitItem,
    error: errors(ThreadNotFound, NotFound, InvalidState),
  }),
  /**
   * Keeps a helper's suggestion as an item of the thread's own, counted and with its chip drawn in
   * the reply it came from. Answers the item as it then is. Fails with `InvalidState` while the
   * thread already has `MAX_OPEN_WAITS` open, and with `NotFound` for an id that is no open
   * suggestion.
   */
  Rpc.make("thread.keepWait", {
    payload: { ...threadRef, id: WaitId },
    success: WaitItem,
    error: errors(ThreadNotFound, NotFound, InvalidState),
  }),
  /**
   * The user's "Add to Waiting on you" on a message: an item of `kind` (a `draft` without one)
   * anchored there, titled from the message's first line unless `title` names it. The agent hears
   * of it with the next note. Fails with `NotFound` for a message the thread hasn't stored, and with
   * `InvalidState` while the thread already has `MAX_OPEN_WAITS` open.
   */
  Rpc.make("thread.addWait", {
    payload: {
      ...threadRef,
      messageId: MessageId,
      kind: Schema.optionalKey(WaitKind),
      title: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(WAIT_TITLE_MAX))),
    },
    success: WaitItem,
    error: errors(ThreadNotFound, NotFound, InvalidState),
  }),
  /**
   * The thread's Waiting on you items, oldest first: the open ones, or with `all` the resolved ones
   * kept too (30 days), for the tray's Resolved line. Reading them tells the agent nothing.
   */
  Rpc.make("thread.listWaits", {
    payload: { ...threadRef, state: Schema.optionalKey(WaitListState) },
    success: Schema.Array(WaitItem),
    error: errors(ThreadNotFound),
  }),
  Rpc.make("thread.markCompleted", {
    payload: { ...threadRef, completed: Schema.Boolean },
    error: errors(ThreadNotFound),
  }),
  /** Babysit mode on the bound PR; enabling resets its counters. */
  Rpc.make("thread.setBabysit", {
    payload: {
      ...threadRef,
      enabled: Schema.Boolean,
      budget: Schema.optionalKey(BabysitBudget),
    },
    success: Thread,
    error: errors(ThreadNotFound, InvalidState),
  }),
  /** Watch review-bot rounds on the thread's PR; enabling binds the branch's PR if none is bound. */
  Rpc.make("thread.setReviewMonitor", {
    payload: { ...threadRef, enabled: Schema.Boolean },
    success: ReviewMonitorResult,
    error: errors(ThreadNotFound, InvalidState),
  }),
  /**
   * The stored messages before `before`, from the `FEED_WINDOW_TURNS`th user message back on: the
   * page a feed that has `earlier` history prepends.
   */
  Rpc.make("thread.history", {
    payload: { ...threadRef, before: MessageId },
    success: ThreadHistoryPage,
    error: errors(ThreadNotFound),
  }),
  /** Message search; `threadId` limits it to one thread. */
  Rpc.make("thread.search", {
    payload: {
      query: Schema.String,
      threadId: Schema.optionalKey(ThreadId),
      limit: Schema.optionalKey(PositiveInt),
    },
    success: ThreadSearchResult,
    error: errors(ThreadNotFound),
  }),
  /**
   * The thread's feed. With `afterRev` (a `caughtUp` or `message` revision this client holds
   * everything up to), the head is `resumed` rather than `messages` when the server can resume from
   * it: not past a rewind, not a revision it hasn't issued, and not too far behind. `from` is the
   * oldest message the client holds; changes to older ones are left out.
   */
  Rpc.make("thread.subscribe", {
    payload: {
      ...threadRef,
      afterRev: Schema.optionalKey(FeedRev),
      from: Schema.optionalKey(MessageId),
    },
    success: ThreadFeedEvent,
    error: errors(ThreadNotFound),
    stream: true,
  }),
  /** The last closed threads, newest first, marked with what changed since they closed. */
  Rpc.make("threads.closed.list", { success: Schema.Array(ClosedThread), error: errors() }),
  /**
   * ⌘⇧T: takes the newest closed thread off the list and opens it again from its stored record,
   * under its own id with its conversation, its place in a workspace included. One whose folder is
   * gone opens too, cold, for the folder-missing flow to restore. `null` when there are none. A
   * reopen that fails puts the entry back.
   */
  Rpc.make("threads.closed.reopen", {
    success: Schema.NullOr(ReopenedClosedThread),
    error: errors(NotFound, AgentUnavailable, GitError, InvalidState, CheckoutInUse),
  }),
  Rpc.make("threads.usingCheckout", {
    payload: CheckoutUsersPayload,
    success: CheckoutUsers,
    error: errors(),
  }),
  // App-tool actions: task chips and panels
  Rpc.make("task.accept", {
    payload: { ...threadRef, taskId: TaskId },
    success: Thread,
    error: errors(ThreadNotFound, NotFound, InvalidState, AgentUnavailable, GitError),
  }),
  Rpc.make("task.dismiss", {
    payload: { ...threadRef, taskId: TaskId },
    error: errors(ThreadNotFound, NotFound),
  }),
  Rpc.make("ui.showPanel", { payload: ShowPanelFields, error: errors(ThreadNotFound) }),
  // Wakes a plain thread set itself with `schedule_wake`
  Rpc.make("threads.wakes", { success: ThreadWakes, error: errors() }),
  /** Drops one of the thread's pending wakes, or with no `id` all of them. */
  Rpc.make("thread.cancelWake", {
    payload: { ...threadRef, id: Schema.optionalKey(Schema.String) },
    success: Schema.Struct({ cancelled: Schema.Int }),
    error: errors(),
  }),
  // Sidebar
  Rpc.make("threads.reorder", { payload: ReorderThreadsPayload, error: errors() }),
);
