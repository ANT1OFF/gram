import * as Schema from "effect/Schema";
import { AgentFailure } from "./agent-failure.ts";
import { CodexHome } from "./codex-home.ts";
import {
  ApprovalScope,
  BackgroundTask,
  CacheWriteSplit,
  PendingRequest,
  PermissionMode,
  PlanItem,
  SubagentUsage,
  TokenUsage,
  SpeedState,
} from "./domain.ts";
import { MessageId, RequestId } from "./ids.ts";
import { CompactionActivity } from "./thread-status.ts";
import { TurnEndReason, UIMessageChunkSchema } from "./ui-message.ts";
import { CwdEvent } from "./worktree-move.ts";

/** Feature flags so the UI can hide what an agent lacks. */
export const AgentCapabilities = Schema.Struct({
  fork: Schema.Boolean,
  rewind: Schema.Literals(["none", "history", "historyAndFiles"]),
  steer: Schema.Boolean,
  planMode: Schema.Boolean,
  approvalScopes: Schema.Array(ApprovalScope),
  userQuestions: Schema.Boolean,
  costReporting: Schema.Boolean,
  perTurnModel: Schema.Boolean,
  reasoningEffort: Schema.Boolean,
  listSessions: Schema.Boolean,
  subagentStreams: Schema.Boolean,
  /** The agent can stop one of its background tasks by id (`thread.stopTask`). */
  stopTasks: Schema.Boolean,
});
export type AgentCapabilities = typeof AgentCapabilities.Type;

export const SlashCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  argumentHint: Schema.optionalKey(Schema.String),
  aliases: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type SlashCommand = typeof SlashCommand.Type;

export const AgentStatus = Schema.Literals([
  "starting",
  "idle",
  "running",
  "awaitingApproval",
  "awaitingInput",
  "compacting",
  "retrying",
  "error",
]);
export type AgentStatus = typeof AgentStatus.Type;

export const FileChange = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["add", "modify", "delete"]),
});
export type FileChange = typeof FileChange.Type;

export const IdentityEvent = Schema.Struct({
  type: Schema.Literal("identity"),
  agentSessionId: Schema.String,
  /** Codex: the home the session lives in (see `Thread.codexHome`). */
  codexHome: Schema.optionalKey(CodexHome),
  model: Schema.String,
  tools: Schema.Array(Schema.String),
  commands: Schema.Array(SlashCommand),
});

export const ChunkEvent = Schema.Struct({
  type: Schema.Literal("chunk"),
  messageId: MessageId,
  chunk: UIMessageChunkSchema,
});

/**
 * An image a tool call returned, as the agent received it. Adapter to server only: the server
 * stores the bytes beside the thread's attachments and puts a `data-tool-image` part in the
 * message, so base64 never reaches the feed or the stored transcript. Emitted before the call's
 * output chunk, and with the image taken out of that output.
 */
export const ToolImageEvent = Schema.Struct({
  type: Schema.Literal("toolImage"),
  messageId: MessageId,
  toolCallId: Schema.String,
  mediaType: Schema.String,
  /** Base64. */
  data: Schema.String,
});

/**
 * Internal live-adapter provenance, emitted only for a genuine Codex imageView item after its
 * pending call input. It is neither a UI chunk nor persisted/reconstructed from tool outputs.
 */
export const ToolImageReadEvent = Schema.Struct({
  type: Schema.Literal("toolImageRead"),
  origin: Schema.Literal("codex-image-view"),
  messageId: MessageId,
  toolCallId: Schema.String,
  path: Schema.String,
});

/**
 * A completed genuine native image view. Capture requires the matching live admission, lane,
 * turn and pending call input, not this descriptor alone. That exact native-read capability may
 * authorize an external file, subject to credential/storage, checked-open and bounded-image guards.
 * User/MCP outputs and stored replay cannot mint it; no original-path serving grant is created.
 */
export const ToolImageSourceEvent = Schema.Struct({
  type: Schema.Literal("toolImageSource"),
  origin: Schema.Literal("codex-image-view"),
  messageId: MessageId,
  toolCallId: Schema.String,
  path: Schema.String,
});

export const StatusEvent = Schema.Struct({
  type: Schema.Literal("status"),
  status: AgentStatus,
  /** The human activity line shown in the sidebar row ("Running pnpm test…"). */
  detail: Schema.optionalKey(Schema.String),
  /** With `compacting`, or `retrying` within it: when the compaction started and what is known. */
  compaction: Schema.optionalKey(CompactionActivity),
});

export const RequestEvent = Schema.Struct({
  type: Schema.Literal("request"),
  request: PendingRequest,
});

export const RequestResolvedEvent = Schema.Struct({
  type: Schema.Literal("requestResolved"),
  requestId: RequestId,
});

export const PlanEvent = Schema.Struct({
  type: Schema.Literal("plan"),
  items: Schema.Array(PlanItem),
});

/**
 * The thread's goal as the agent keeps it (Codex's `thread/goal`), which becomes its plan's goal;
 * without `objective` the agent cleared it.
 */
export const GoalEvent = Schema.Struct({
  type: Schema.Literal("goal"),
  objective: Schema.optionalKey(Schema.String),
});

export const FilesEvent = Schema.Struct({
  type: Schema.Literal("files"),
  changes: Schema.Array(FileChange),
});

export const UsageEvent = Schema.Struct({
  type: Schema.Literal("usage"),
  tokens: TokenUsage,
  partial: Schema.optionalKey(Schema.Boolean),
  telemetryVersion: Schema.optionalKey(
    Schema.Literals(["codex-request-delta-v1", "codex-last-request-v1"]),
  ),
  contextWindow: Schema.optionalKey(Schema.Int),
  /** The latest request's whole prompt; see `UsageSummary.contextTokens`. */
  contextTokens: Schema.optionalKey(Schema.Int),
  /**
   * Cumulative for the agent session, from zero: a resumed session starts over, and the server adds
   * sessions up into `UsageSummary.costUsd`.
   */
  costUsd: Schema.optionalKey(Schema.Number),
  /** `costUsd` is the adapter's guess from the tokens so far, until the agent prices the turn. */
  costEstimated: Schema.optionalKey(Schema.Boolean),
  /** The turn's main-conversation cache writes so far, by TTL; see `UsageSummary.cacheWrites`. */
  cacheWrites: Schema.optionalKey(CacheWriteSplit),
});

/**
 * A subagent's own totals, which `UsageEvent` never covers: that one measures the main
 * conversation. Emitted repeatedly while a subagent runs and once when a backgrounded one reports
 * back, keyed by tool call id so a card can pick up the run it spawned.
 */
export const SubagentUsageEvent = Schema.Struct({
  type: Schema.Literal("subagentUsage"),
  usage: SubagentUsage,
});

/**
 * The background tasks the agent has running (shells, subagents), leaving out the housekeeping
 * ones. The agent wakes when one finishes, so its session has to outlive them. A level: each event
 * replaces the last, and a new session starts with none.
 */
export const BackgroundTasksEvent = Schema.Struct({
  type: Schema.Literal("backgroundTasks"),
  tasks: Schema.Array(BackgroundTask),
});

/**
 * The tail of a background shell's output while it runs, as the adapter read it back: at most its
 * last 8 KiB, the whole tail each time, sent when it changed. Its tool call already has its final
 * result, so this is no part of the transcript, and nothing of it reaches the agent.
 */
export const BackgroundOutputEvent = Schema.Struct({
  type: Schema.Literal("backgroundOutput"),
  /** One of the tasks of the latest `backgroundTasks` event. */
  taskId: Schema.NonEmptyString,
  /** The tool call that started it. */
  toolCallId: Schema.optionalKey(Schema.String),
  output: Schema.String,
});

export const TurnEndEvent = Schema.Struct({
  type: Schema.Literal("turnEnd"),
  reason: TurnEndReason,
  error: Schema.optionalKey(Schema.String),
  /** With `error`: what kind of failure it was, when the adapter could tell. */
  failure: Schema.optionalKey(AgentFailure),
});

export const EndedEvent = Schema.Struct({
  type: Schema.Literal("ended"),
  reason: Schema.String,
});

/** The permission mode changed: by the user, a plan approval, or the agent. */
export const ModeEvent = Schema.Struct({
  type: Schema.Literal("mode"),
  mode: PermissionMode,
});

/**
 * The user changed the model from inside the session (Claude's `/model`). `model` is what they asked
 * for, an alias or a full id, so it matches the ids a model picker offers.
 */
export const SpeedEvent = Schema.Struct({ type: Schema.Literal("speed"), state: SpeedState });

export const ModelEvent = Schema.Struct({
  type: Schema.Literal("model"),
  model: Schema.String,
});

/**
 * A usage limit the agent is near (`warning`) or at (`rejected`), as the agent reported it, or a
 * plain reading of it (`allowed`) for the usage meter, which never notifies.
 */
export const rateLimitFields = {
  status: Schema.Literals(["allowed", "warning", "rejected"]),
  /** The agent's name for the limit's window, e.g. `five_hour` or `overage`; `usage` when it gave none. */
  window: Schema.String,
  /** How much of the window is used, from 0 to 1. */
  utilization: Schema.optionalKey(Schema.Number),
  /** When the window resets, in epoch milliseconds. */
  resetsAt: Schema.optionalKey(Schema.Number),
  /**
   * The agent says turns go on past the window on credits or consumption billing (Claude's extra
   * usage, Codex's credits): a full window is no stop. Absent when it said nothing of it.
   */
  credits: Schema.optionalKey(Schema.Literal(true)),
};

/**
 * The agent's report of a usage limit, on every request that is near or past one. The server
 * decides which of them the user is told about.
 */
export const RateLimitEvent = Schema.Struct({
  type: Schema.Literal("rateLimit"),
  ...rateLimitFields,
});

/** Opaque identity for a known low-priority startup diagnostic; never a path or provider payload. */
export const StartupDiagnostic = Schema.Struct({
  key: Schema.String,
  source: Schema.String,
});
export type StartupDiagnostic = typeof StartupDiagnostic.Type;

/** Something the user should see that isn't part of the transcript (auth, retries, version skew). */
export const NoticeEvent = Schema.Struct({
  type: Schema.Literal("notice"),
  level: Schema.Literals(["info", "warning", "error"]),
  message: Schema.String,
  startupDiagnostic: Schema.optionalKey(StartupDiagnostic),
});

/**
 * The claude.ai connectors that worked for this session, or that Claude Code remembers connecting
 * once, and now need signing in to again, in full after any change; empty when none is left.
 */
export const ConnectorsLapsedEvent = Schema.Struct({
  type: Schema.Literal("connectorsLapsed"),
  names: Schema.Array(Schema.String),
});

/** What an `AgentSession` emits: UIMessage chunks plus a small set of control events. */
export const AgentEvent = Schema.Union([
  IdentityEvent,
  ChunkEvent,
  ToolImageEvent,
  ToolImageReadEvent,
  ToolImageSourceEvent,
  StatusEvent,
  RequestEvent,
  RequestResolvedEvent,
  PlanEvent,
  GoalEvent,
  FilesEvent,
  UsageEvent,
  SubagentUsageEvent,
  BackgroundTasksEvent,
  BackgroundOutputEvent,
  TurnEndEvent,
  EndedEvent,
  ModeEvent,
  ModelEvent,
  SpeedEvent,
  NoticeEvent,
  RateLimitEvent,
  CwdEvent,
  ConnectorsLapsedEvent,
]);
export type AgentEvent = typeof AgentEvent.Type;

/**
 * Safety class of an app tool, enforced by the registry rather than the model.
 * `outwardGated` is outward, but the tool raises its own card per call, so babysit mode can waive it;
 * transports pass it through like *self*.
 */
export const AppToolClass = Schema.Literals([
  "read",
  "self",
  "crossThread",
  "outward",
  "outwardGated",
]);
export type AppToolClass = typeof AppToolClass.Type;

export const AppToolDescriptor = Schema.Struct({
  /** Name within the `gram` MCP server, e.g. `set_title`. */
  name: Schema.String,
  class: AppToolClass,
  description: Schema.String,
});
export type AppToolDescriptor = typeof AppToolDescriptor.Type;
