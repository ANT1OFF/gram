import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { AgentEvent } from "../agent.ts";
import { Connector } from "../connectors.ts";
import {
  AgentUnavailable,
  AnswerUndelivered,
  InterruptHung,
  InvalidState,
  ModeRefused,
  NotFound,
} from "../errors.ts";
import { FsFilesResult } from "../fs-files.ts";
import { FsSearchResult } from "../fs-search.ts";
import {
  AgentKind,
  Checkout,
  ModelRef,
  PermissionMode,
  RequestAnswer,
  UserInput,
} from "../domain.ts";
import { FsListing } from "../fs.ts";
import { GitState } from "../git.ts";
import { ClaudeSignIn } from "../launch-checks.ts";
import { HostId, ProfileId, RequestId, TerminalId, ThreadId } from "../ids.ts";
import { TerminalEvent, TerminalInfo, TerminalOpened } from "../terminal.ts";
import { WorktreeList } from "../worktrees.ts";
import { PositiveInt } from "./shared.ts";

/**
 * The host protocol's version. A control plane and a host that disagree on it don't talk: the
 * hello says so, and the control plane treats the host as unavailable, and shows a joined machine
 * as needing an update. Bump it when a message either side already sends changes in a way the
 * other's build can't read; a new call doesn't need it, since a host built before it answers that
 * call alone with an unknown-request defect. `HostHello`'s `protocol`, `hostId` and `release` stay
 * readable by every build, so a mismatch is always told apart from a host that didn't answer.
 */
export const HOST_PROTOCOL_VERSION = 2;

/** What a host can do, named so a control plane uses only what a host advertised. */
export const HostCapability = Schema.Literals([
  "files",
  "ports",
  "worktrees",
  "git",
  "terminals",
  "sessions",
  "repos",
  /**
   * Takes a session's send or steer once per delivery id, answering a repeat with the first one's
   * outcome, so a control plane unsure whether one arrived can ask again.
   */
  "deliveries",
]);
export type HostCapability = typeof HostCapability.Type;

/** The host's answer to `host.hello`: who it is and what it can do. */
export const HostHello = Schema.Struct({
  protocol: Schema.Int,
  hostId: HostId,
  capabilities: Schema.Array(HostCapability),
  platform: Schema.String,
  pid: Schema.Int,
  /**
   * The Gram release the host was built from, such as `1.17.0`; absent from a host run from source
   * and from a host built before it was sent (1.16.0 and earlier). A control plane built before it
   * ignores it, as a struct ignores keys it doesn't name.
   */
  release: Schema.optionalKey(Schema.String),
});
export type HostHello = typeof HostHello.Type;

/** A command a joined machine needs, as its host finds it on its own login-shell PATH. */
export const HostTool = Schema.Struct({
  tool: Schema.Literals(["claude", "git"]),
  found: Schema.Boolean,
  /** As `--version` prints it, when it could be read. */
  version: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
});
export type HostTool = typeof HostTool.Type;

/** `host.status`: what the machine can run now. */
export const HostStatus = Schema.Struct({
  claudeSignIn: ClaudeSignIn,
  tools: Schema.Array(HostTool).check(Schema.isMaxLength(8)),
});
export type HostStatus = typeof HostStatus.Type;

/** A host couldn't do what it was asked, for a reason its own side knows. */
export class HostFailed extends Schema.TaggedError<HostFailed>()("HostFailed", {
  message: Schema.String,
}) {}

/** One process on the host, as a port scan sees it. */
export const HostProcess = Schema.Struct({
  pid: Schema.Int,
  ppid: Schema.Int,
  pgid: Schema.optionalKey(Schema.Int),
  tpgid: Schema.optionalKey(Schema.Int),
  command: Schema.String,
});

/** One sweep of the host's listening ports and process tree, as lists for the wire. */
export const HostPortScan = Schema.Struct({
  /** Listening ports by pid. */
  listening: Schema.Array(Schema.Tuple([Schema.Int, Schema.Array(Schema.Int)])),
  /** Children by parent pid. */
  children: Schema.Array(Schema.Tuple([Schema.Int, Schema.Array(Schema.Int)])),
  processes: Schema.optionalKey(Schema.Array(HostProcess)),
});
export type HostPortScan = typeof HostPortScan.Type;

/**
 * A worktree operation the host refused or couldn't finish: `invalidRequest`, `conflict` or
 * `failed`, with `dirty` marking a refusal to delete uncommitted work.
 */
export class HostWorktreeFailed extends Schema.TaggedError<HostWorktreeFailed>()(
  "HostWorktreeFailed",
  {
    reason: Schema.Literals(["invalidRequest", "conflict", "failed"]),
    message: Schema.String,
    dirty: Schema.Boolean,
  },
) {}

/** A command the host ran couldn't start (`spawn`) or overran its bound and was killed. */
export class HostCommandFailed extends Schema.TaggedError<HostCommandFailed>()(
  "HostCommandFailed",
  {
    kind: Schema.Literals(["spawn", "timeout"]),
    bin: Schema.String,
    message: Schema.String,
  },
) {}

/** A new worktree, or the one the request reused. */
export const HostCreatedWorktree = Schema.Struct({
  repoTop: Schema.String,
  checkout: Checkout,
  reused: Schema.Boolean,
  copiedIncludes: Schema.Int,
});

/** What restoring a worktree did; `branchGone` changed nothing. */
export const HostRestoredWorktree = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("restored"),
    source: Schema.Literals(["local", "origin", "pr"]),
  }),
  Schema.Struct({ kind: Schema.Literal("branchGone") }),
]);

/** A checkout's git state as its watcher saw it change. */
export const HostGitChange = Schema.Struct({
  path: Schema.String,
  seq: Schema.Int,
  live: Schema.Boolean,
  state: GitState,
});

/** A thread's terminal as the host holds it, with its raw scrollback. */
export const HostTerminalSnapshot = Schema.Struct({
  terminalId: TerminalId,
  threadId: Schema.optionalKey(ThreadId),
  cwd: Schema.String,
  shell: Schema.String,
  alive: Schema.Boolean,
  script: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Int),
  signal: Schema.optionalKey(Schema.String),
  scrollback: Schema.String,
  scrollbackCut: Schema.Boolean,
  cols: Schema.Int,
  rows: Schema.Int,
});

/**
 * A thread's shell starting or ending on the host, so the control plane can count it among the
 * thread's processes for its port chips.
 */
export const HostTerminalRoot = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("add"),
    threadId: ThreadId,
    pid: Schema.Int,
    terminalId: TerminalId,
  }),
  Schema.Struct({ kind: Schema.Literal("remove"), pid: Schema.Int }),
]);

/**
 * An agent session to open on the host, named by the control plane (`handle`) so it can close one
 * whose open it gave up on. Only what crosses as data: the thread's app tools reach the agent over
 * the control plane's MCP endpoint, never in-process.
 */
export const HostSessionOpen = Schema.Struct({
  handle: Schema.String,
  agent: AgentKind,
  threadId: ThreadId,
  cwd: Schema.String,
  resumeId: Schema.optionalKey(Schema.String),
  fork: Schema.optionalKey(Schema.Boolean),
  resumeAt: Schema.optionalKey(Schema.String),
  sessionId: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(ModelRef),
  permissionMode: Schema.optionalKey(PermissionMode),
  mcp: Schema.optionalKey(
    Schema.Struct({
      url: Schema.String,
      headers: Schema.Record(Schema.String, Schema.String),
    }),
  ),
  additionalDirectories: Schema.optionalKey(Schema.Array(Schema.String)),
  audience: Schema.optionalKey(Schema.Literals(["plain", "orchestrator", "worker", "dream"])),
  instructions: Schema.optionalKey(Schema.String),
  outwardGate: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Literals(["all", "irreversible"])]),
  ),
  confineWrites: Schema.optionalKey(Schema.Boolean),
  pinCwd: Schema.optionalKey(Schema.Boolean),
  mcpAllowlist: Schema.optionalKey(Schema.Array(Schema.String)),
  mcpDenylist: Schema.optionalKey(Schema.Array(Schema.String)),
  mcpNoneWithoutToolSearch: Schema.optionalKey(Schema.Boolean),
  noBlockingAsk: Schema.optionalKey(Schema.Boolean),
  peerMessaging: Schema.optionalKey(Schema.Boolean),
});
export type HostSessionOpen = typeof HostSessionOpen.Type;

/** Which of a session's optional controls the host's agent offers, and its connectors' lists. */
export const HostSessionOpened = Schema.Struct({
  closeToolGate: Schema.Boolean,
  stopBackgroundTasks: Schema.Boolean,
  stopTask: Schema.Boolean,
  addDirectories: Schema.Boolean,
  processId: Schema.Boolean,
  connectors: Schema.optionalKey(
    Schema.Struct({
      authenticate: Schema.Boolean,
      allowlist: Schema.optionalKey(Schema.Array(Schema.String)),
      denylist: Schema.optionalKey(Schema.Array(Schema.String)),
      claudeAiUnavailable: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type HostSessionOpened = typeof HostSessionOpened.Type;

/** An agent event, numbered in the order its session emitted it, from 1. */
export const HostSessionEvent = Schema.Struct({
  seq: Schema.Int,
  event: AgentEvent,
});

/** One report of a session's MCP servers. */
export const HostConnectorsSeen = Schema.Struct({
  detailed: Schema.Boolean,
  whole: Schema.Boolean,
  connectors: Schema.Array(Connector),
});

/** A started OAuth sign-in: the page to open, or `started` when the agent opened it itself. */
export const HostSignInStart = Schema.Union([
  Schema.Struct({ authorizationUrl: Schema.String }),
  Schema.Literal("started"),
]);

/** What the host's agents keep across sessions, dropped so the next session reads it afresh. */
export const HostAgentReload = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("runtime") }),
  Schema.Struct({
    kind: Schema.Literal("config"),
    profileId: Schema.optionalKey(ProfileId),
  }),
  Schema.Struct({ kind: Schema.Literal("allConfig") }),
]);
export type HostAgentReload = typeof HostAgentReload.Type;

const session = { handle: Schema.String };
const sessionErrors = Schema.Union([AgentUnavailable, HostFailed]);

const terminalErrors = Schema.Union([NotFound, InvalidState, HostFailed]);

const worktreeErrors = Schema.Union([HostWorktreeFailed, HostFailed]);
const commandErrors = Schema.Union([HostCommandFailed, HostFailed]);
const openCheckouts = Schema.Array(Schema.String);

const listErrors = Schema.Union([NotFound, InvalidState, HostFailed]);
const readErrors = Schema.Union([InvalidState, HostFailed]);

/**
 * What a control plane asks of a worker host. The caller has already decided a path is one it may
 * read; the host only reads it. Paths are the host's own. That holds while the only caller is the
 * host's own parent over a private pipe: a host reached over a network checks paths itself.
 */
export const HostRpcs = RpcGroup.make(
  /** The first call on a connection: the host's version, id and capabilities. */
  Rpc.make("host.hello", { success: HostHello }),
  /** A folder's entries for the Files panel. */
  Rpc.make("host.files.list", {
    payload: { path: Schema.String, showHidden: Schema.Boolean, limit: PositiveInt },
    success: FsListing,
    error: listErrors,
  }),
  /** Lines matching `query` under `root`. */
  Rpc.make("host.files.search", {
    payload: {
      root: Schema.String,
      query: Schema.String,
      regex: Schema.Boolean,
      caseSensitive: Schema.Boolean,
      offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      limit: PositiveInt,
    },
    success: FsSearchResult,
    error: readErrors,
  }),
  /** Every file name under `root`, capped. */
  Rpc.make("host.files.names", {
    payload: { root: Schema.String },
    success: FsFilesResult,
    error: readErrors,
  }),
  /** One sweep of the host's listening ports and processes. */
  Rpc.make("host.ports.scan", { success: HostPortScan, error: HostFailed }),
  /**
   * What this machine can run: whether its own Claude Code is signed in to a subscription (its
   * `claude auth status`, the classification only, never the output or a credential) and whether
   * `claude` and `git` are installed there. An older host answers with an unknown-request defect,
   * which the control plane reads as unknown.
   */
  Rpc.make("host.status", { success: HostStatus }),
  /**
   * The host's own clone of the repository at `url`, in the folder it keeps clones in: cloned when
   * it has none, fetched when it has. What a worker placed on this machine makes its worktree from.
   */
  Rpc.make("host.repos.ensure", {
    payload: { url: Schema.String },
    success: Schema.Struct({ path: Schema.String }),
    error: worktreeErrors,
  }),
  /** A repo's worktrees, those open in a thread marked. */
  Rpc.make("host.worktrees.list", {
    payload: { repoPath: Schema.String, openCheckouts },
    success: WorktreeList,
    error: worktreeErrors,
  }),
  /** The branches a new worktree can start from, and the one an empty picker uses. */
  Rpc.make("host.worktrees.baseBranches", {
    payload: { repoPath: Schema.String },
    success: Schema.Struct({
      branches: Schema.Array(Schema.String),
      default: Schema.optionalKey(Schema.String),
    }),
    error: worktreeErrors,
  }),
  /** A new worktree on `branch`, or the one already on it. */
  Rpc.make("host.worktrees.create", {
    payload: {
      repoPath: Schema.String,
      branch: Schema.optionalKey(Schema.String),
      base: Schema.optionalKey(Schema.String),
      openCheckouts,
    },
    success: HostCreatedWorktree,
    error: worktreeErrors,
  }),
  /** Removes a worktree, then unions `mergeRules` back into the main checkout's settings. */
  Rpc.make("host.worktrees.remove", {
    payload: {
      repoPath: Schema.String,
      worktreeDir: Schema.String,
      force: Schema.optionalKey(Schema.Boolean),
      mergeRules: Schema.optionalKey(Schema.Array(Schema.String)),
      openCheckouts,
    },
    error: worktreeErrors,
  }),
  /** Recreates a worktree that was deleted, at its old folder on its branch. */
  Rpc.make("host.worktrees.restore", {
    payload: {
      repoPath: Schema.String,
      worktreeDir: Schema.String,
      branch: Schema.String,
      fromPr: Schema.optionalKey(Schema.Int),
      openCheckouts,
    },
    success: HostRestoredWorktree,
    error: worktreeErrors,
  }),
  /** Permission rules approved in a worktree that its main checkout lacks. */
  Rpc.make("host.worktrees.pendingPermissions", {
    payload: { repoPath: Schema.String, worktreeDir: Schema.String },
    success: Schema.Array(Schema.String),
    error: worktreeErrors,
  }),
  /** A checkout's local git state: branch, changes, HEAD. */
  Rpc.make("host.git.local", {
    payload: { cwd: Schema.String },
    success: GitState,
    error: commandErrors,
  }),
  /** Whether a checkout's folder is there; false only when it is definitely gone. */
  Rpc.make("host.git.present", { payload: { cwd: Schema.String }, success: Schema.Boolean }),
  /** Each checkout's git state as it changes, until the caller stops listening. */
  Rpc.make("host.git.watch", {
    payload: {
      paths: Schema.Array(Schema.String),
      debounceMs: Schema.optionalKey(Schema.Number),
      cooldownMs: Schema.optionalKey(Schema.Number),
      backend: Schema.optionalKey(Schema.Literals(["parcel", "node"])),
    },
    success: HostGitChange,
    stream: true,
  }),
  /**
   * A shell in `cwd`, already chosen by the control plane, with the settings it read. Without
   * `path`, as for another machine, the shell is the host's own default on its own PATH.
   */
  Rpc.make("host.terminals.open", {
    payload: {
      threadId: Schema.optionalKey(ThreadId),
      cwd: Schema.String,
      cols: PositiveInt,
      rows: PositiveInt,
      shell: Schema.optionalKey(Schema.String),
      command: Schema.optionalKey(Schema.String),
      script: Schema.optionalKey(Schema.String),
      settingsShell: Schema.optionalKey(Schema.String),
      path: Schema.optionalKey(Schema.String),
    },
    success: TerminalOpened,
    error: terminalErrors,
  }),
  Rpc.make("host.terminals.input", {
    payload: { terminalId: TerminalId, data: Schema.String },
    error: terminalErrors,
  }),
  Rpc.make("host.terminals.resize", {
    payload: { terminalId: TerminalId, cols: PositiveInt, rows: PositiveInt },
    error: terminalErrors,
  }),
  /** Kills the shell and waits for it to exit. */
  Rpc.make("host.terminals.close", {
    payload: { terminalId: TerminalId },
    error: Schema.Union([NotFound, HostFailed]),
  }),
  Rpc.make("host.terminals.list", {
    payload: { threadId: Schema.optionalKey(ThreadId) },
    success: Schema.Array(TerminalInfo),
  }),
  /** The scrollback as one `replay`, then live output, ending after `exit`. */
  Rpc.make("host.terminals.subscribe", {
    payload: { terminalId: TerminalId },
    success: TerminalEvent,
    error: Schema.Union([NotFound, HostFailed]),
    stream: true,
  }),
  Rpc.make("host.terminals.snapshot", {
    payload: { threadId: ThreadId },
    success: Schema.Array(HostTerminalSnapshot),
  }),
  /** Threads' shells as they start and end, until the caller stops listening. */
  Rpc.make("host.terminals.roots", { success: HostTerminalRoot, stream: true }),
  /**
   * Opens an agent session on the host under the control plane's `handle`. A close for the handle
   * that comes first, or while it opens, leaves the session closed.
   */
  Rpc.make("host.sessions.open", {
    payload: HostSessionOpen,
    success: HostSessionOpened,
    error: sessionErrors,
  }),
  /**
   * The session's events after `afterSeq`: those the host still keeps, then each as it comes. Ends
   * once the session's events have ended and every one was sent.
   */
  Rpc.make("host.sessions.events", {
    payload: { ...session, afterSeq: Schema.Int },
    success: HostSessionEvent,
    error: NotFound,
    stream: true,
  }),
  /** Confirms every event up to `seq`, which the host then lets go. */
  Rpc.make("host.sessions.ack", { payload: { ...session, seq: Schema.Int } }),
  /** The last report of the session's MCP servers, then each new one. */
  Rpc.make("host.sessions.connectorsSeen", {
    payload: session,
    success: HostConnectorsSeen,
    stream: true,
  }),
  Rpc.make("host.sessions.send", {
    payload: {
      ...session,
      input: UserInput,
      messageId: Schema.optionalKey(Schema.String),
      /** Taken once per session on a host that serves `deliveries`. */
      deliveryId: Schema.optionalKey(Schema.String),
    },
    error: HostFailed,
  }),
  Rpc.make("host.sessions.steer", {
    payload: { ...session, input: UserInput, deliveryId: Schema.optionalKey(Schema.String) },
    error: HostFailed,
  }),
  Rpc.make("host.sessions.interrupt", {
    payload: session,
    error: Schema.Union([InterruptHung, HostFailed]),
  }),
  Rpc.make("host.sessions.closeToolGate", {
    payload: session,
    error: HostFailed,
  }),
  Rpc.make("host.sessions.stopBackgroundTasks", {
    payload: session,
    success: Schema.Int,
    error: HostFailed,
  }),
  Rpc.make("host.sessions.stopTask", {
    payload: { ...session, taskId: Schema.String },
    success: Schema.Boolean,
    error: HostFailed,
  }),
  Rpc.make("host.sessions.respond", {
    payload: { ...session, requestId: RequestId, answer: RequestAnswer },
    error: Schema.Union([AnswerUndelivered, HostFailed]),
  }),
  Rpc.make("host.sessions.setMode", {
    payload: { ...session, mode: PermissionMode },
    error: Schema.Union([ModeRefused, HostFailed]),
  }),
  Rpc.make("host.sessions.setModel", {
    payload: { ...session, model: ModelRef },
    error: HostFailed,
  }),
  Rpc.make("host.sessions.addDirectories", {
    payload: { ...session, paths: Schema.Array(Schema.String) },
    success: Schema.Boolean,
    error: HostFailed,
  }),
  Rpc.make("host.sessions.processId", {
    payload: session,
    success: Schema.NullOr(Schema.Int),
    error: HostFailed,
  }),
  Rpc.make("host.sessions.connectorsStatus", {
    payload: session,
    success: Schema.Array(Connector),
    error: sessionErrors,
  }),
  Rpc.make("host.sessions.connectorsReconnect", {
    payload: { ...session, name: Schema.String },
    error: sessionErrors,
  }),
  Rpc.make("host.sessions.connectorsSetEnabled", {
    payload: { ...session, name: Schema.String, enabled: Schema.Boolean },
    success: Schema.Literals(["applied", "restart"]),
    error: sessionErrors,
  }),
  Rpc.make("host.sessions.connectorsAuthenticate", {
    payload: { ...session, name: Schema.String },
    success: HostSignInStart,
    error: sessionErrors,
  }),
  /** Ends the session and waits for its agent to stop. Unknown handles are already closed. */
  Rpc.make("host.sessions.close", { payload: session }),
  /** Drops what the host's agents keep across sessions (`AgentHost.reloadConfig` and kin). */
  Rpc.make("host.sessions.reload", {
    payload: { agent: AgentKind, reload: HostAgentReload },
  }),
  /**
   * Keeps a token the user ran `claude setup-token` for on the main machine, and consented to send
   * to this one, owner-only in the host's folder: its new Claude sessions sign in with it. The
   * payload is `Redacted`, so a log or error that prints it shows `<redacted>`. A host built before
   * this answers with an unknown-request defect.
   */
  Rpc.make("host.claude.setToken", {
    payload: { token: Schema.RedactedFromValue(Schema.String) },
    error: HostFailed,
  }),
  /** Deletes the kept token; true when there was one. */
  Rpc.make("host.claude.forgetToken", { success: Schema.Boolean, error: HostFailed }),
);
