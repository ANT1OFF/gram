import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { DraftId } from "../attachments.ts";
import { BabysitBudget } from "../babysit.ts";
import { CheckoutInUse, CheckoutUsers, CheckoutUsersPayload } from "../checkout-use.ts";
import { ClosedThread, ReopenedClosedThread } from "../closed-threads.ts";
import { CodexHome } from "../codex-home.ts";
import { DocId } from "../docs.ts";
import {
  ModelRef,
  PermissionMode,
  RequestAnswer,
  Thread,
  ThreadBrowserStatus,
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
import { MessageId, QueueItemId, RequestId, TaskId, ThreadId, TurnId } from "../ids.ts";
import { ThreadWakes } from "../orchestration.ts";
import { TurnUndoDataSchema } from "../ui-message.ts";
import { ReviewMonitorResult } from "../review-monitor.ts";
import { SavedDiff } from "../saved-work.ts";
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

const clientMessageId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/));

/** Threads: their lifecycle, turns, queue, feed and history, and what the sidebar asks of them. */
export const ThreadRpcs = RpcGroup.make(
  Rpc.make("thread.create", {
    payload: {
      projectRoot: Schema.String,
      checkout: CheckoutRequest,
      model: Schema.optionalKey(ModelRef),
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
      /**
       * Other repositories the thread also works in, by their projects' folders here. With a new
       * worktree, each gets a worktree of its own on the same branch and machine, removed with
       * the thread's; in a folder as it is on this machine, each folder is given as it is.
       * Refused for a folder on another machine. Its agent has them all before its first turn.
       */
      alsoIn: Schema.optionalKey(Schema.Array(Schema.String)),
    },
    success: Thread,
    error: errors(NotFound, AgentUnavailable, GitError, InvalidState, CheckoutInUse),
  }),
  Rpc.make("thread.createFromProfile", {
    payload: { profile: Schema.Unknown, threadId: Schema.optionalKey(ThreadId) },
    success: Thread,
    error: errors(NotFound, AgentUnavailable, GitError, InvalidState),
  }),
  Rpc.make("thread.send", {
    payload: { ...threadRef, input: UserInput, clientMessageId },
    success: SendResult,
    error: errors(ThreadNotFound, InvalidState, AgentUnavailable),
  }),
  Rpc.make("thread.steer", {
    payload: {
      ...threadRef,
      input: UserInput,
      clientMessageId,
      interrupt: Schema.optionalKey(Schema.Boolean),
    },
    error: errors(ThreadNotFound, InvalidState),
  }),
  Rpc.make("thread.interrupt", {
    payload: threadRef,
    error: errors(ThreadNotFound, InterruptHung),
  }),
  Rpc.make("thread.resumeLimitWait", { payload: threadRef, error: errors(ThreadNotFound) }),
  Rpc.make("thread.resumeAfterMachineLost", {
    payload: threadRef,
    error: errors(ThreadNotFound, InvalidState, AgentUnavailable),
  }),
  Rpc.make("thread.restoreFromBranch", {
    payload: threadRef,
    error: errors(ThreadNotFound, InvalidState),
  }),
  Rpc.make("thread.savedDiff", {
    payload: threadRef,
    success: Schema.Struct({ saved: Schema.optionalKey(SavedDiff) }),
    error: errors(ThreadNotFound),
  }),
  Rpc.make("thread.cancelLimitWait", { payload: threadRef, error: errors(ThreadNotFound) }),
  Rpc.make("thread.restartSession", {
    payload: { ...threadRef, midTurn: Schema.optionalKey(RestartMidTurn) },
    success: RestartSessionResult,
    error: errors(ThreadNotFound, InvalidState),
  }),
  Rpc.make("thread.startSession", {
    payload: threadRef,
    success: StartSessionResult,
    error: errors(ThreadNotFound, InvalidState),
  }),
  Rpc.make("thread.stopTask", {
    payload: { ...threadRef, taskId: Schema.String },
    error: errors(ThreadNotFound, NotFound, InvalidState),
  }),
  Rpc.make("thread.respond", {
    payload: {
      ...threadRef,
      requestId: RequestId,
      answer: RequestAnswer,
      shown: Schema.optionalKey(Schema.String),
    },
    error: errors(ThreadNotFound, RequestNotFound, InvalidState),
  }),
  Rpc.make("thread.respondMany", {
    payload: {
      answers: Schema.Array(
        Schema.Struct({
          threadId: ThreadId,
          requestId: RequestId,
          answer: RequestAnswer,
          shown: Schema.optionalKey(Schema.String),
        }),
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
    payload: { ...threadRef, model: ModelRef },
    error: errors(ThreadNotFound, InvalidState, AgentUnavailable),
  }),
  Rpc.make("thread.startFreshOn", {
    payload: { ...threadRef, model: ModelRef },
    success: Thread,
    error: errors(ThreadNotFound, InvalidState),
  }),
  Rpc.make("thread.switchAgent", {
    payload: {
      ...threadRef,
      target: ModelRef,
      /**
       * Ask the old session for a handoff note in one last turn first; on by default. Off, the new
       * session gets Gram's facts and the recent turns only. A thread out of usage or errored gets
       * no note turn either way: the new agent writes the note (limit mode).
       */
      note: Schema.optionalKey(Schema.Boolean),
    },
    success: Thread,
    error: errors(ThreadNotFound, InvalidState, AgentUnavailable),
  }),
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
  Rpc.make("thread.undoTurn", {
    payload: { ...threadRef, turnId: TurnId },
    success: TurnUndoDataSchema,
    error: errors(ThreadNotFound, InvalidState, NotFound, GitError),
  }),
  Rpc.make("thread.rename", {
    payload: { ...threadRef, title: Schema.String },
    error: errors(ThreadNotFound),
  }),
  Rpc.make("thread.addDirectory", {
    payload: { ...threadRef, path: Schema.String },
    success: Schema.String,
    error: errors(ThreadNotFound, NotFound, InvalidState),
  }),
  Rpc.make("thread.pin", {
    payload: { ...threadRef, pinned: Schema.Boolean },
    error: errors(ThreadNotFound),
  }),
  Rpc.make("thread.hideDoc", {
    payload: { ...threadRef, docId: DocId },
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
  Rpc.make("thread.queue.steer", {
    payload: { ...threadRef, itemId: QueueItemId, clientMessageId },
    error: errors(ThreadNotFound, NotFound, InvalidState),
  }),
  Rpc.make("thread.markUnread", {
    payload: { ...threadRef, unread: Schema.Boolean },
    error: errors(ThreadNotFound),
  }),
  Rpc.make("thread.snooze", {
    payload: { ...threadRef, until: Schema.NullOr(Schema.Number) },
    success: Thread,
    error: errors(ThreadNotFound, InvalidState),
  }),
  Rpc.make("thread.browserStatus", {
    payload: threadRef,
    success: ThreadBrowserStatus,
    error: errors(ThreadNotFound),
  }),
  Rpc.make("thread.setBrowser", {
    payload: { ...threadRef, browser: Schema.Boolean },
    success: Thread,
    error: errors(ThreadNotFound, InvalidState),
  }),
  Rpc.make("thread.setPlan", {
    payload: { ...threadRef, plan: PlanEdit },
    success: Schema.NullOr(ThreadPlan),
    error: errors(ThreadNotFound),
  }),
  Rpc.make("thread.refreshPlan", {
    payload: { ...threadRef, rebuild: Schema.optionalKey(Schema.Boolean) },
    success: Schema.NullOr(ThreadPlan),
    error: errors(ThreadNotFound),
  }),
  Rpc.make("thread.resolveWait", {
    payload: { ...threadRef, id: WaitId, undo: Schema.optionalKey(Schema.Boolean) },
    success: WaitItem,
    error: errors(ThreadNotFound, NotFound, InvalidState),
  }),
  Rpc.make("thread.keepWait", {
    payload: { ...threadRef, id: WaitId },
    success: WaitItem,
    error: errors(ThreadNotFound, NotFound, InvalidState),
  }),
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
  Rpc.make("thread.listWaits", {
    payload: { ...threadRef, state: Schema.optionalKey(WaitListState) },
    success: Schema.Array(WaitItem),
    error: errors(ThreadNotFound),
  }),
  Rpc.make("thread.markCompleted", {
    payload: { ...threadRef, completed: Schema.Boolean },
    error: errors(ThreadNotFound),
  }),
  Rpc.make("thread.setBabysit", {
    payload: {
      ...threadRef,
      enabled: Schema.Boolean,
      budget: Schema.optionalKey(BabysitBudget),
    },
    success: Thread,
    error: errors(ThreadNotFound, InvalidState),
  }),
  Rpc.make("thread.setReviewMonitor", {
    payload: { ...threadRef, enabled: Schema.Boolean },
    success: ReviewMonitorResult,
    error: errors(ThreadNotFound, InvalidState),
  }),
  Rpc.make("thread.history", {
    payload: { ...threadRef, before: MessageId },
    success: ThreadHistoryPage,
    error: errors(ThreadNotFound),
  }),
  Rpc.make("thread.search", {
    payload: {
      query: Schema.String,
      threadId: Schema.optionalKey(ThreadId),
      limit: Schema.optionalKey(PositiveInt),
    },
    success: ThreadSearchResult,
    error: errors(ThreadNotFound),
  }),
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
  Rpc.make("threads.closed.list", { success: Schema.Array(ClosedThread), error: errors() }),
  Rpc.make("threads.closed.reopen", {
    success: Schema.NullOr(ReopenedClosedThread),
    error: errors(NotFound, AgentUnavailable, GitError, InvalidState, CheckoutInUse),
  }),
  Rpc.make("threads.usingCheckout", {
    payload: CheckoutUsersPayload,
    success: CheckoutUsers,
    error: errors(),
  }),
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
  Rpc.make("threads.wakes", { success: ThreadWakes, error: errors() }),
  Rpc.make("thread.cancelWake", {
    payload: { ...threadRef, id: Schema.optionalKey(Schema.String) },
    success: Schema.Struct({ cancelled: Schema.Int }),
    error: errors(),
  }),
  Rpc.make("threads.reorder", { payload: ReorderThreadsPayload, error: errors() }),
);
