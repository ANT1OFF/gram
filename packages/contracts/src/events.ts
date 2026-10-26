import * as Schema from "effect/Schema";
import { rateLimitFields, StartupDiagnostic } from "./agent.ts";
import { SessionRestartReason, UIMessageChunkSchema, UIMessageSchema } from "./ui-message.ts";
import { ThreadSuggestions } from "./assist.ts";
import { KeybindingsState } from "./depth.ts";
import {
  AgentKind,
  BackgroundOutput,
  BackgroundTask,
  PendingRequest,
  PlanItem,
  Thread,
  UsageSummary,
} from "./domain.ts";
import { GitState } from "./git.ts";
import { MessageId, RequestId, ThreadId, WorkspaceId } from "./ids.ts";
import { ThreadPortsEvent, ThreadTerminalProcessesEvent } from "./ports.ts";
import { ReviewRound } from "./review.ts";
import { ThreadPlan } from "./thread-plan.ts";
import { CompactionActivity, ThreadStatus } from "./thread-status.ts";
import { QueuedInput, ThreadIdentity, ThreadSummary } from "./thread-summary.ts";
import { LimitRecord } from "./usage-limits.ts";
import { WaitItem } from "./waits.ts";

export const PanelKind = Schema.Literals(["diff", "pr", "files", "terminal", "preview"]);
export type PanelKind = typeof PanelKind.Type;

/** What `ui.showPanel` asks a window to open. */
export const ShowPanelFields = {
  threadId: ThreadId,
  panel: PanelKind,
  /** A file path, PR tab, or localhost URL, depending on `panel`. */
  target: Schema.optionalKey(Schema.String),
  /**
   * A `preview` page the thread's agent already opened in its pane (`browser_navigate`), at
   * `target`, which may be a public page it was allowed: the tab shows it rather than loading it.
   */
  driven: Schema.optionalKey(Schema.Boolean),
};

/** Pushed to every window on `events.subscribe`. */
export const ServerEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("threads.snapshot"), threads: Schema.Array(ThreadSummary) }),
  Schema.Struct({ type: Schema.Literal("thread.upsert"), thread: Thread }),
  Schema.Struct({ type: Schema.Literal("thread.removed"), threadId: ThreadId }),
  Schema.Struct({
    type: Schema.Literal("thread.status"),
    threadId: ThreadId,
    status: ThreadStatus,
    /** The human activity line shown in the sidebar row ("Running pnpm test…"). */
    detail: Schema.optionalKey(Schema.String),
    /** The compaction under way; every `thread.status` without it says none is. */
    compaction: Schema.optionalKey(CompactionActivity),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.request"),
    threadId: ThreadId,
    request: PendingRequest,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.requestResolved"),
    threadId: ThreadId,
    requestId: RequestId,
  }),
  /** The full queue after any change: send, drain, edit, reorder or remove. */
  Schema.Struct({
    type: Schema.Literal("thread.queue"),
    threadId: ThreadId,
    queue: Schema.Array(QueuedInput),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.identity"),
    threadId: ThreadId,
    identity: ThreadIdentity,
  }),
  /** Same shape as `ThreadSummary.usage`; pushed after each turn's usage report. */
  Schema.Struct({ type: Schema.Literal("thread.usage"), threadId: ThreadId, usage: UsageSummary }),
  /**
   * The agent's todo list (`items`) and the thread's plan after either changes, both in full:
   * without `plan` the thread has none.
   */
  Schema.Struct({
    type: Schema.Literal("thread.plan"),
    threadId: ThreadId,
    items: Schema.Array(PlanItem),
    plan: Schema.optionalKey(ThreadPlan),
  }),
  /**
   * The thread's open Waiting on you items after any change, in full, oldest first, with what the
   * helper resolved lately as `ThreadSummary.helperResolved` has it.
   */
  Schema.Struct({
    type: Schema.Literal("thread.waits"),
    threadId: ThreadId,
    waits: Schema.Array(WaitItem),
    helperResolved: Schema.optionalKey(Schema.Array(WaitItem)),
  }),
  Schema.Struct({ type: Schema.Literal("git.state"), threadId: ThreadId, state: GitState }),
  /** A bot review round completed on the thread's PR; published once per round. */
  Schema.Struct({ type: Schema.Literal("pr.reviewRound"), threadId: ThreadId, round: ReviewRound }),
  ThreadPortsEvent,
  ThreadTerminalProcessesEvent,
  /** The agent's background tasks after any change; an empty list says none is left. */
  Schema.Struct({
    type: Schema.Literal("thread.background"),
    threadId: ThreadId,
    tasks: Schema.Array(BackgroundTask),
  }),
  /**
   * A running background shell's output tail after it changed, at most its last 8 KiB. Not stored:
   * `ThreadSummary.backgroundOutput` has the latest of each task still running, and a task's
   * output goes with it.
   */
  Schema.Struct({
    type: Schema.Literal("thread.backgroundOutput"),
    threadId: ThreadId,
    ...BackgroundOutput.fields,
  }),
  /** `ThreadSummary.pendingRestart` after it changes; without `reason` none is pending. */
  Schema.Struct({
    type: Schema.Literal("thread.pendingRestart"),
    threadId: ThreadId,
    reason: Schema.optionalKey(SessionRestartReason),
  }),
  /** `ThreadSummary.lapsedConnectors` after any change; an empty list says none is left. */
  Schema.Struct({
    type: Schema.Literal("thread.lapsedConnectors"),
    threadId: ThreadId,
    names: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("notify"),
    kind: Schema.Literals(["needsInput", "done", "error", "info"]),
    title: Schema.String,
    startupDiagnostic: Schema.optionalKey(StartupDiagnostic),
    /** The PR whose failed CI generated this notice; presentation may defer to its worker. */
    ciFailure: Schema.optionalKey(Schema.String),
    body: Schema.optionalKey(Schema.String),
    threadId: Schema.optionalKey(ThreadId),
  }),
  /**
   * Suggested replies for the focused thread's turn that just ended. Not stored: `thread.suggestions`
   * gives the latest again.
   */
  Schema.Struct({ type: Schema.Literal("thread.suggestions"), ...ThreadSuggestions.fields }),
  /**
   * A usage limit worth telling the user about, reported by `threadId`'s agent. Sent once per
   * window, reset and threshold across every thread, not on each report.
   */
  Schema.Struct({ type: Schema.Literal("rateLimit"), threadId: ThreadId, ...rateLimitFields }),
  /**
   * Every usage-limit reading from `threadId`'s agent, shown or not: the title bar's usage meter.
   * `gateway` marks a session on a gateway profile, whose limits aren't the subscription's.
   */
  Schema.Struct({
    type: Schema.Literal("usageLimit"),
    threadId: ThreadId,
    agent: AgentKind,
    gateway: Schema.optionalKey(Schema.Literal(true)),
    /** The gateway profile the session runs on, with `gateway`. */
    profileId: Schema.optionalKey(Schema.String),
    ...rateLimitFields,
  }),
  /**
   * The latest reading of every limit window still current, sent first to each client that
   * connects: the server keeps them across restarts, so the meter needn't wait for a new report.
   */
  Schema.Struct({
    type: Schema.Literal("usageLimits.snapshot"),
    limits: Schema.Array(LimitRecord),
  }),
  Schema.Struct({ type: Schema.Literal("ui.showPanel"), ...ShowPanelFields }),
  /** `keybindings.json` changed on disk (or through `keybindings.set`). */
  Schema.Struct({ type: Schema.Literal("keybindings.changed"), keybindings: KeybindingsState }),
  /**
   * The app's settings changed behind the windows' backs (an approved `settings_propose`); each
   * window pulls them again.
   */
  Schema.Struct({ type: Schema.Literal("settings.changed") }),
  /** Gateway profiles, or which ones have keys, changed; clients refetch profiles and models. */
  Schema.Struct({ type: Schema.Literal("profiles.changed") }),
  /** The review requests list changed; clients refetch `reviewRequests.list`. */
  Schema.Struct({ type: Schema.Literal("reviewRequests.changed") }),
  /** The user's open PRs changed; clients refetch `openPrs.list`. */
  Schema.Struct({ type: Schema.Literal("openPrs.changed") }),
  /** A plain thread's pending wakes changed; clients refetch `threads.wakes`. */
  Schema.Struct({ type: Schema.Literal("threadWakes.changed") }),
  /** A workspace was saved or removed, or its slot changed hands; clients refetch `workspace.list`. */
  Schema.Struct({ type: Schema.Literal("workspaces.changed") }),
  /** A workspace's ledger, charter or pause changed; clients refetch what they show of it. */
  Schema.Struct({ type: Schema.Literal("orchestration.changed"), workspaceId: WorkspaceId }),
  /**
   * The workspace's orchestrator wrote to its memory, `questions.md` included (`ask_user`,
   * `close_question`); clients refetch what they read of it.
   */
  Schema.Struct({ type: Schema.Literal("memory.changed"), workspaceId: WorkspaceId }),
  /** A dream of the workspace started, ended, was adopted or went; clients refetch `dream.list`. */
  Schema.Struct({ type: Schema.Literal("dreams.changed"), workspaceId: WorkspaceId }),
  /** A thread of the workspace produced a file (`outputs.ts`); clients refetch `workspace.outputs`. */
  Schema.Struct({ type: Schema.Literal("outputs.changed"), workspaceId: WorkspaceId }),
]);
export type ServerEvent = typeof ServerEvent.Type;

/**
 * A thread's feed revision: it increases with every change to the thread's stored messages and is
 * never reused, a closed and reopened thread included. `thread.subscribe`'s `afterRev` resumes from
 * one.
 */
export const FeedRev = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export type FeedRev = typeof FeedRev.Type;

/**
 * Pushed on `thread.subscribe`, in order: one `messages` (recent history) or `resumed` (what changed
 * since `afterRev`), then `chunk`s replaying the in-flight message from its first chunk, then
 * `caughtUp`, then live `message`s and `chunk`s.
 */
export const ThreadFeedEvent = Schema.Union([
  /**
   * The thread's stored history from its `FEED_WINDOW_TURNS`th-last user message on, `earlier`
   * when there is more before it, which `thread.history` pages in. Not only sent on subscribe: it
   * may be re-sent at any time (e.g. after a rewind) as a full replacement, followed by the same
   * replay and `caughtUp`. Clients reset their message state and buffer live chunks until
   * `caughtUp`.
   */
  Schema.Struct({
    type: Schema.Literal("messages"),
    messages: Schema.Array(UIMessageSchema),
    earlier: Schema.optionalKey(Schema.Boolean),
  }),
  /**
   * In place of `messages` when the subscription's `afterRev` could be resumed from: the stored
   * messages written since that revision, from its `from` on, in thread order, each to replace the
   * one with its id or go at the end. Nothing was removed since, or the server would have sent
   * `messages`.
   */
  Schema.Struct({ type: Schema.Literal("resumed"), messages: Schema.Array(UIMessageSchema) }),
  /**
   * A user message or a full-message upsert; replaces any message with the same id. `rev` is the
   * thread's revision once it's stored.
   */
  Schema.Struct({ type: Schema.Literal("message"), message: UIMessageSchema, rev: FeedRev }),
  Schema.Struct({
    type: Schema.Literal("chunk"),
    messageId: MessageId,
    chunk: UIMessageChunkSchema,
  }),
  /**
   * The history before it is complete as of `rev`, which a later subscription can pass as
   * `afterRev`. The in-flight messages replayed before it don't count: their stored rows can be
   * older than `rev`.
   */
  Schema.Struct({ type: Schema.Literal("caughtUp"), rev: FeedRev }),
]);
export type ThreadFeedEvent = typeof ThreadFeedEvent.Type;
