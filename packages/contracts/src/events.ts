import * as Schema from "effect/Schema";
import {
  AgentCapabilities,
  AgentNoticeAction,
  rateLimitFields,
  StartupDiagnostic,
} from "./agent.ts";
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
import { MessageId, RequestId, ThreadId, TurnId, WorkspaceId } from "./ids.ts";
import { MachineState } from "./machines.ts";
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
  Schema.Struct({
    type: Schema.Literal("thread.queue"),
    threadId: ThreadId,
    queue: Schema.Array(QueuedInput),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.identity"),
    threadId: ThreadId,
    identity: ThreadIdentity,
    /**
     * What the session's agent can do (steer mid-turn, interrupt for a message, fork), sent as the
     * session reports its identity. Otherwise only a snapshot carries them, and a thread created
     * after a window subscribed (a worker spawned meanwhile) would have none there.
     */
    capabilities: Schema.optionalKey(AgentCapabilities),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.usage"),
    threadId: ThreadId,
    usage: UsageSummary,
    /** The turn the reading is of, where one is open. */
    turnId: Schema.optionalKey(TurnId),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.plan"),
    threadId: ThreadId,
    items: Schema.Array(PlanItem),
    plan: Schema.optionalKey(ThreadPlan),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.waits"),
    threadId: ThreadId,
    waits: Schema.Array(WaitItem),
    helperResolved: Schema.optionalKey(Schema.Array(WaitItem)),
  }),
  Schema.Struct({ type: Schema.Literal("git.state"), threadId: ThreadId, state: GitState }),
  Schema.Struct({ type: Schema.Literal("pr.reviewRound"), threadId: ThreadId, round: ReviewRound }),
  ThreadPortsEvent,
  ThreadTerminalProcessesEvent,
  Schema.Struct({
    type: Schema.Literal("thread.background"),
    threadId: ThreadId,
    tasks: Schema.Array(BackgroundTask),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.backgroundOutput"),
    threadId: ThreadId,
    ...BackgroundOutput.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.pendingRestart"),
    threadId: ThreadId,
    reason: Schema.optionalKey(SessionRestartReason),
  }),
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
    action: Schema.optionalKey(AgentNoticeAction),
    /** The PR whose failed CI generated this notice; presentation may defer to its worker. */
    ciFailure: Schema.optionalKey(Schema.String),
    body: Schema.optionalKey(Schema.String),
    threadId: Schema.optionalKey(ThreadId),
  }),
  Schema.Struct({ type: Schema.Literal("thread.suggestions"), ...ThreadSuggestions.fields }),
  Schema.Struct({ type: Schema.Literal("rateLimit"), threadId: ThreadId, ...rateLimitFields }),
  Schema.Struct({
    type: Schema.Literal("usageLimit"),
    threadId: ThreadId,
    agent: AgentKind,
    accountScope: Schema.optionalKey(Schema.String),
    gateway: Schema.optionalKey(Schema.Literal(true)),
    /** The gateway profile the session runs on, with `gateway`. */
    profileId: Schema.optionalKey(Schema.String),
    ...rateLimitFields,
  }),
  Schema.Struct({
    type: Schema.Literal("usageLimits.snapshot"),
    limits: Schema.Array(LimitRecord),
  }),
  Schema.Struct({
    type: Schema.Literal("machines.snapshot"),
    machines: Schema.Array(MachineState),
  }),
  Schema.Struct({ type: Schema.Literal("ui.showPanel"), ...ShowPanelFields }),
  Schema.Struct({ type: Schema.Literal("keybindings.changed"), keybindings: KeybindingsState }),
  Schema.Struct({ type: Schema.Literal("settings.changed") }),
  Schema.Struct({ type: Schema.Literal("profiles.changed") }),
  Schema.Struct({ type: Schema.Literal("reviewRequests.changed") }),
  Schema.Struct({ type: Schema.Literal("openPrs.changed") }),
  Schema.Struct({ type: Schema.Literal("threadWakes.changed") }),
  Schema.Struct({ type: Schema.Literal("workspaces.changed") }),
  Schema.Struct({ type: Schema.Literal("orchestration.changed"), workspaceId: WorkspaceId }),
  Schema.Struct({ type: Schema.Literal("memory.changed"), workspaceId: WorkspaceId }),
  Schema.Struct({ type: Schema.Literal("routines.changed"), workspaceId: WorkspaceId }),
  Schema.Struct({ type: Schema.Literal("dreams.changed"), workspaceId: WorkspaceId }),
  Schema.Struct({ type: Schema.Literal("outputs.changed"), workspaceId: WorkspaceId }),
  Schema.Struct({ type: Schema.Literal("docs.changed"), workspaceId: WorkspaceId }),
  Schema.Struct({ type: Schema.Literal("pages.changed"), workspaceId: WorkspaceId }),
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
  Schema.Struct({
    type: Schema.Literal("messages"),
    messages: Schema.Array(UIMessageSchema),
    earlier: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("resumed"), messages: Schema.Array(UIMessageSchema) }),
  Schema.Struct({ type: Schema.Literal("message"), message: UIMessageSchema, rev: FeedRev }),
  Schema.Struct({
    type: Schema.Literal("chunk"),
    messageId: MessageId,
    chunk: UIMessageChunkSchema,
  }),
  Schema.Struct({ type: Schema.Literal("caughtUp"), rev: FeedRev }),
]);
export type ThreadFeedEvent = typeof ThreadFeedEvent.Type;
