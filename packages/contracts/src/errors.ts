import * as Schema from "effect/Schema";
import { AgentKind, PermissionMode, ThreadStatus } from "./domain.ts";
import { FolderAccessDenial } from "./folder-access.ts";
import { ProfileId, RequestId, ThreadId } from "./ids.ts";

/** The server has no handler for this RPC yet. Every RPC's error union includes it. */
export class NotImplemented extends Schema.TaggedError<NotImplemented>()("NotImplemented", {
  rpc: Schema.String,
}) {}

export class ThreadNotFound extends Schema.TaggedError<ThreadNotFound>()("ThreadNotFound", {
  threadId: ThreadId,
}) {}

export class RequestNotFound extends Schema.TaggedError<RequestNotFound>()("RequestNotFound", {
  threadId: ThreadId,
  requestId: RequestId,
}) {}

/** The command isn't valid in the thread's current state (e.g. steer while idle). */
export class InvalidState extends Schema.TaggedError<InvalidState>()("InvalidState", {
  message: Schema.String,
  threadId: Schema.optionalKey(ThreadId),
  status: Schema.optionalKey(ThreadStatus),
  /** Set when the OS refused to read a folder or file, so a client can offer recovery. */
  access: Schema.optionalKey(FolderAccessDenial),
  /** Set when the thread's folder is gone, so a client can offer to restore it. */
  folderMissing: Schema.optionalKey(Schema.Struct({ path: Schema.String })),
}) {}

export const AgentUnavailableReason = Schema.Literals([
  "not-logged-in",
  "api-key-auth",
  "third-party-provider",
  "claude-not-found",
  "startup-failed",
  "auth-status-failed",
  /** `resume` named a session with no transcript, e.g. one opened but never sent a message. */
  "session-not-found",
]);
export type AgentUnavailableReason = typeof AgentUnavailableReason.Type;

export class AgentUnavailable extends Schema.TaggedError<AgentUnavailable>()("AgentUnavailable", {
  agent: AgentKind,
  /** Drives the recovery card ("Run `claude /login`"); absent for adapter-less agents. */
  reason: Schema.optionalKey(AgentUnavailableReason),
  message: Schema.String,
}) {}

/** `interrupt()` didn't settle within the watchdog timeout; the runtime closes and resumes. */
export class InterruptHung extends Schema.TaggedError<InterruptHung>()("InterruptHung", {
  timeoutMs: Schema.Int,
}) {}

/**
 * The agent refused a permission mode, e.g. Claude Code with bypass disabled by a managed policy.
 * Never on the wire: the runtime answers `thread.setMode` with an `InvalidState` carrying `message`.
 */
export class ModeRefused extends Schema.TaggedError<ModeRefused>()("ModeRefused", {
  mode: PermissionMode,
  message: Schema.String,
}) {}

/**
 * The agent didn't take an answer to one of its requests, which is still waiting on it. Never on
 * the wire: the runtime keeps the request up and answers `thread.respond` with an `InvalidState`
 * carrying `message`.
 */
export class AnswerUndelivered extends Schema.TaggedError<AnswerUndelivered>()(
  "AnswerUndelivered",
  { message: Schema.String },
) {}

/** Server-owned permission metadata. Never accepted as part of a client's approval answer. */
export const AppToolApprovalResolution = Schema.Struct({
  origin: Schema.Literals(["user", "runtime", "unknown"]),
  reason: Schema.String,
  threadId: ThreadId,
  requestId: Schema.optionalKey(RequestId),
  resolvedAt: Schema.Number,
  permissionMode: Schema.optionalKey(PermissionMode),
});
export type AppToolApprovalResolution = typeof AppToolApprovalResolution.Type;

/** An app tool call failed, or was refused pending the user's approval. */
export class AppToolError extends Schema.TaggedError<AppToolError>()("AppToolError", {
  tool: Schema.String,
  message: Schema.String,
  approvalRequired: Schema.optionalKey(Schema.Boolean),
  approvalResolution: Schema.optionalKey(AppToolApprovalResolution),
}) {}

export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  message: Schema.String,
  command: Schema.optionalKey(Schema.String),
  stderr: Schema.optionalKey(Schema.String),
}) {}

export class WorktreeDirty extends Schema.TaggedError<WorktreeDirty>()("WorktreeDirty", {
  path: Schema.String,
  changedFiles: Schema.Int,
}) {}

export class FsError extends Schema.TaggedError<FsError>()("FsError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  entity: Schema.Literals([
    "project",
    "profile",
    "palette",
    "label",
    "worktree",
    "file",
    "task",
    "backgroundTask",
    "queueItem",
    "terminal",
    "checkpoint",
    "session",
    "stash",
    "workspace",
    "dream",
    "wait",
    "message",
    "question",
  ]),
  id: Schema.String,
  /** Human-readable, e.g. "Folder not found: ~/code/x". */
  message: Schema.optionalKey(Schema.String),
}) {}

export class GatewayError extends Schema.TaggedError<GatewayError>()("GatewayError", {
  profileId: ProfileId,
  message: Schema.String,
}) {}
