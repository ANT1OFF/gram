import * as Schema from "effect/Schema";
import { HostCheckResult, HostCheckRepositorySetup } from "./host-checks.ts";
export { HostCheckResult, HostCheckFailure } from "./host-checks.ts";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { AgentEvent } from "../agent.ts";
import { HostAppToolsAnswer, HostAppToolsRequest } from "./host-app-tools.ts";
import { Connector } from "../connectors.ts";
import {
  AgentUnavailable,
  AnswerUndelivered,
  InterruptHung,
  InvalidState,
  ModeRefused,
  NotFound,
} from "../errors.ts";
import { BrowserScope, CodexSurfaces } from "../settings.ts";
import { CodexHome } from "../codex-home.ts";
import { FsFilesResult, FsResolveResult } from "../fs-files.ts";
import { FsSearchResult } from "../fs-search.ts";
import {
  AgentKind,
  Checkout,
  ModelRef,
  PermissionMode,
  RequestAnswer,
  UserInput,
} from "../domain.ts";
import { FolderListing, FsFile, FsListing, HostFolderChecked } from "../fs.ts";
import { GitState } from "../git.ts";
import { ClaudeSignIn } from "../launch-checks.ts";
import { HostId, ProfileId, RequestId, TerminalId, ThreadId, WorkspaceId } from "../ids.ts";
import { SHARED_PART_BYTES, SharedListing, SharedPart } from "../shared-folder.ts";
import { TerminalEvent, TerminalInfo, TerminalOpened } from "../terminal.ts";
import { ProfileFile } from "../thread-profile.ts";
import { FileImage } from "../thread-ui.ts";
import { WorktreeList } from "../worktrees.ts";
import {
  WorktreeHookInspection,
  WorktreeHookOutcome,
  WorktreeHookRequest,
  WorktreeHookRun,
} from "../worktree-hooks.ts";
import { PositiveInt } from "./shared.ts";
import {
  HostBusy,
  HostStopCheckout,
  HostStopKept,
  HostStopPrepared,
  HostStopRestored,
} from "./host-stop.ts";
import {
  HostAntigravityStatus,
  HostCodexStatus,
  HostGrokStatus,
  HostModel,
  HostOpenCodeStatus,
} from "./host-agents.ts";

export * from "./host-app-tools.ts";
export * from "./host-stop.ts";

/**
 * The host protocol's version. Between releases the protocol only grows: a new call, a new optional
 * field, a new feature a host names in its hello. So a control plane and a host on different
 * releases keep working together, each without what the other doesn't have yet, and updating one
 * doesn't make the other restart. `host-compat.test.ts` holds every change to that, against the
 * protocol as each release since 1.19.0 spoke it (`host-released/<release>.json`).
 *
 * Bump it only for a break decided on purpose: a message either side already sends changing in a
 * way a released build can't read. A control plane then refuses a host outside
 * `HOST_PROTOCOL_OLDEST` to this version, its hello says so, and a joined machine shows as needing
 * an update. `HostHello`'s `protocol`, `hostId` and `release` stay readable by every build, so a
 * mismatch is always told apart from a host that didn't answer.
 */
export const HOST_PROTOCOL_VERSION = 2;

/**
 * The oldest protocol version this build's control plane still talks to. Raise it only when what a
 * host of that version sends can no longer be read.
 */
export const HOST_PROTOCOL_OLDEST = 2;

/**
 * What a host can do, named so a control plane uses only what a host advertised. This list is
 * closed: a control plane of 1.19 or earlier refuses a hello naming anything else, so a host names
 * what came later in its hello's `features` (`HostFeature`).
 */
export const HostCapability = Schema.Literals([
  "files",
  "ports",
  "worktrees",
  "git",
  "terminals",
  "sessions",
  "repos",
  "deliveries",
  "file-reads",
  "attachments",
  "checks",
  "repo-identity",
  "update",
  "folders",
]);
export type HostCapability = typeof HostCapability.Type;

/** The capabilities a host must name for a control plane to use it at all. This list never grows. */
export const HOST_REQUIRED_CAPABILITIES: ReadonlyArray<HostCapability> = [
  "files",
  "ports",
  "worktrees",
  "git",
  "terminals",
  "sessions",
  "repos",
];

import { HostFeature } from "./host-features.ts";
export { HostFeature };

/** `HostHello.diskId` and `bootId`: a random id, as a host writes it. */
export const HostDiskId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,64}$/));

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
  /**
   * What it can do beyond `capabilities`, as `HostFeature` names it; absent from a host built
   * before it was sent (1.19.0 and earlier). A control plane built before it ignores it.
   */
  features: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(64))).check(Schema.isMaxLength(256)),
  ),
  /**
   * The disk the host runs on: an id it made the first time it started there, kept in its own
   * folder beside its key but never with its clones. Same disk, the machine's folders are still
   * there; another, it is a new machine under the same key, whose folders a resume puts back
   * before any session opens, and a host that says a disk it replaced is refused. Absent from a
   * joined machine's host built before it (1.31.0 and earlier) or one that couldn't keep the id,
   * and from this machine's own host. A control plane built before it ignores it.
   */
  diskId: Schema.optionalKey(HostDiskId),
  /**
   * This start of the host's process: a fresh id each time it starts, so a redial from the same
   * process (its connection only dropped) is told apart from a restart on the same disk, which
   * took its sessions with it. Sent with `diskId`.
   */
  bootId: Schema.optionalKey(HostDiskId),
  /**
   * The host couldn't keep part of `diskId` (its clones' own volume): what is on its disk can't be
   * told from one start to the next, so each start owes a resume. Sent with `diskId`.
   */
  diskUnknown: Schema.optionalKey(Schema.Literal(true)),
});
export type HostHello = typeof HostHello.Type;

/** Whether the host that said `hello` can do `what`. */
export const hostServes = (
  hello: Pick<HostHello, "capabilities" | "features">,
  what: HostCapability | HostFeature,
): boolean =>
  (hello.capabilities as ReadonlyArray<string>).includes(what) ||
  (hello.features?.includes(what) ?? false);

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
  /**
   * What its Claude Code lists, for a worker placed there to resolve its tier against this
   * machine. Absent from a host before 1.19, and when Claude Code couldn't list; the control plane
   * then resolves against its own lists. A control plane built before it ignores it.
   */
  models: Schema.optionalKey(Schema.Array(HostModel).check(Schema.isMaxLength(64))),
  /**
   * Its Codex, from a host that runs Codex sessions (`agent-codex`). A control plane built before
   * it ignores it.
   */
  codex: Schema.optionalKey(HostCodexStatus),
  /**
   * Its OpenCode, from a host that runs OpenCode sessions (`agent-opencode-sessions`). A control
   * plane built before it ignores it.
   */
  opencode: Schema.optionalKey(HostOpenCodeStatus),
  /**
   * Its Grok Build, from a host that runs Grok Build sessions (`agent-grok`). A control plane built
   * before it ignores it.
   */
  grok: Schema.optionalKey(HostGrokStatus),
  /**
   * Its Antigravity, from a host that runs Antigravity sessions (`agent-antigravity`). A control
   * plane built before it ignores it.
   */
  antigravity: Schema.optionalKey(HostAntigravityStatus),
});
export type HostStatus = typeof HostStatus.Type;

/** How a host's last update ended, as it keeps it across the restart. */
export const HostUpdateOutcome = Schema.Struct({
  /** The release it tried to move to. */
  release: Schema.String.check(Schema.isMaxLength(64)),
  outcome: Schema.Literals(["updated", "rolledBack", "failed"]),
  /** Why, for one that didn't update. */
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(400))),
  /** Epoch ms. */
  at: Schema.Number,
});
export type HostUpdateOutcome = typeof HostUpdateOutcome.Type;

/**
 * `host.update.check`: whether the host could update now, and how its last update ended. Asked
 * once a connection has passed its hello, which is what tells a host that just updated that its
 * new release dialled in and works, so the previous one can go.
 */
export const HostUpdateCheck = Schema.Struct({
  /** Absent when it can update; otherwise what is running. */
  busy: Schema.optionalKey(HostBusy),
  last: Schema.optionalKey(HostUpdateOutcome),
});
export type HostUpdateCheck = typeof HostUpdateCheck.Type;

/** A step of `host.update.start`, in order; the stream ends once the service is handed over. */
export const HostUpdateProgress = Schema.Union([
  Schema.Struct({
    phase: Schema.Literal("downloading"),
    received: Schema.Number,
    total: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({ phase: Schema.Literals(["verifying", "unpacking", "testing", "switching"]) }),
]);
export type HostUpdateProgress = typeof HostUpdateProgress.Type;

/**
 * Why a host didn't update: `busy` (work a restart would cut off, which it names), `invalid` (not
 * a release it would take: malformed, not newer, or not for this platform), `unsupported` (run
 * from source, or not as its service), `failed` (the download, checksum, unpacking or test).
 */
export class HostUpdateRefused extends Schema.TaggedError<HostUpdateRefused>()(
  "HostUpdateRefused",
  {
    reason: Schema.Literals(["busy", "invalid", "unsupported", "failed"]),
    message: Schema.String,
    busy: Schema.optionalKey(HostBusy),
  },
) {}

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

/** A loopback address `host.loopback.open` connects to; `localhost` tries IPv4, then IPv6. */
export const LoopbackHost = Schema.Literals(["127.0.0.1", "::1", "localhost"]);
export type LoopbackHost = typeof LoopbackHost.Type;

/** The ports a loopback tunnel reaches: a dev server's, never a system service's. */
export const LoopbackPort = Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65_535 }));

/** One tunnel, named by the control plane that opens it. */
export const LoopbackTunnelId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,64}$/));

/** What a loopback tunnel carries from the host: `connected` once, then the port's bytes. */
export const LoopbackEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("connected") }),
  Schema.Struct({ type: Schema.Literal("data"), data: Schema.String }),
]);
export type LoopbackEvent = typeof LoopbackEvent.Type;

/** The most bytes one `data` event or one `host.loopback.send` carries. */
export const LOOPBACK_CHUNK_BYTES = 64 * 1024;

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

/**
 * A worktree on the host as it is now, read there for the control plane to compare with what it
 * recorded when it made it: never a grant of anything by itself.
 */
export const HostRepoIdentity = Schema.Struct({
  /** The identity of the worktree's `origin` (transport, host, port, account, path); absent when it has none the host clones. */
  identity: Schema.optionalKey(Schema.String),
  /** The worktree shares its repository with the clone at `repoRoot`. */
  ofClone: Schema.Boolean,
  /** The branch checked out there; absent when detached or unreadable. */
  branch: Schema.optionalKey(Schema.String),
});
export type HostRepoIdentity = typeof HostRepoIdentity.Type;

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
    worktreeSetup: Checkout.fields.worktreeSetup,
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
  gateConnectors: Schema.optionalKey(Schema.Boolean),
  confineWrites: Schema.optionalKey(Schema.Boolean),
  /** The folder is someone else's code: none of its own agent settings load. */
  untrustedTree: Schema.optionalKey(Schema.Boolean),
  pinCwd: Schema.optionalKey(Schema.Boolean),
  mcpAllowlist: Schema.optionalKey(Schema.Array(Schema.String)),
  mcpDenylist: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * One more MCP server for the session, by address. A host built before it was sent drops it,
   * and the session then opens without that server, never with more than it was meant to have.
   */
  mcpServer: Schema.optionalKey(Schema.Struct({ name: Schema.String, url: Schema.String })),
  mcpNoneWithoutToolSearch: Schema.optionalKey(Schema.Boolean),
  noBlockingAsk: Schema.optionalKey(Schema.Boolean),
  peerMessaging: Schema.optionalKey(Schema.Boolean),
  /**
   * The session drives the user's browser (`OpenSessionOptions.browser`); a host that serves
   * `browser-policy` holds an absent one off. A host built before it drops the field and leaves
   * the CLI's own default, so a control plane sends no session to a host that doesn't name
   * `browser-policy` (`agentHostThroughHost`, `agentHostOnMachine`).
   */
  browser: Schema.optionalKey(Schema.Boolean),
  /**
   * Which surfaces a session with `browser` keeps (`OpenSessionOptions.browserSurfaces`). A host
   * built before it drops the field and keeps them all.
   */
  browserSurfaces: Schema.optionalKey(CodexSurfaces),
  /**
   * The only sites and Mac apps a session with `browser` may act on
   * (`OpenSessionOptions.browserScope`). A host built before it drops the field and doesn't limit.
   */
  browserScope: Schema.optionalKey(BrowserScope),
  /** Each action in the browser asks first (`OpenSessionOptions.browserAsk`). */
  browserAsk: Schema.optionalKey(Schema.Boolean),
  /**
   * Codex: the home the session was first opened in (`OpenSessionOptions.codexHome`), so a resume
   * finds it there. Sent only to a host that names `agent-codex`.
   */
  codexHome: Schema.optionalKey(CodexHome),
  /**
   * Codex: a restart, whose open waits for the previous session's app-server on the host to exit
   * (`OpenSessionOptions.waitForPreviousSession`). Sent only to a host that names `agent-codex`.
   */
  waitForPrevious: Schema.optionalKey(Schema.Boolean),
  /**
   * A memory update's session (`OpenSessionOptions.dreamFilesOnly`): no native tool, no settings,
   * only the app tools, in a folder of the host's own. Sent only to a host that names
   * `dream-sessions`.
   */
  dreamFilesOnly: Schema.optionalKey(Schema.Boolean),
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

const fileRead = {
  path: Schema.String,
  roots: Schema.Array(Schema.String),
  outside: Schema.Struct({ allowed: Schema.Boolean, refusal: Schema.String }),
};

/** What a project's vocabulary reads from its checkout, its thread titles aside. */
export const HostVocabulary = Schema.Struct({
  symbols: Schema.Array(Schema.String),
  files: Schema.Array(Schema.String),
  branches: Schema.Array(Schema.String),
});

/** A file `send_file` takes from the host: its path there, its size and its bytes as base64. */
export const HostFetchedFile = Schema.Struct({
  path: Schema.String,
  size: Schema.Int,
  data: Schema.String,
});
export type HostFetchedFile = typeof HostFetchedFile.Type;
const readErrors = Schema.Union([InvalidState, HostFailed]);

/** The most bytes one `host.files.part` carries. */
export const HOST_FILE_PART_BYTES = 4 * 2 ** 20;

/**
 * A part of a file on the host: the file's path there, its size and modification time (epoch ms,
 * whole) as they were when the part was read, and the part's bytes as base64. A reader that sees
 * the size or the time change between parts has read a file that changed under it.
 */
export const HostFilePart = Schema.Struct({
  path: Schema.String,
  size: Schema.Int,
  mtime: Schema.Int,
  data: Schema.String,
});
export type HostFilePart = typeof HostFilePart.Type;

/**
 * What a control plane asks of a worker host. The caller has already decided a path is one it may
 * read; the host only reads it. Paths are the host's own. That holds while the only caller is the
 * host's own parent over a private pipe: a host reached over a network checks paths itself.
 */
export const HostRpcs = RpcGroup.make(
  Rpc.make("host.hello", { success: HostHello }),
  Rpc.make("host.files.list", {
    payload: { path: Schema.String, showHidden: Schema.Boolean, limit: PositiveInt },
    success: FsListing,
    error: listErrors,
  }),
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
  Rpc.make("host.files.names", {
    payload: { root: Schema.String },
    success: FsFilesResult,
    error: readErrors,
  }),
  Rpc.make("host.files.scope", {
    payload: { path: Schema.String, roots: Schema.Array(Schema.String) },
    success: Schema.String,
    error: listErrors,
  }),
  Rpc.make("host.files.file", {
    payload: { ...fileRead, maxBytes: PositiveInt },
    success: FsFile,
    error: listErrors,
  }),
  Rpc.make("host.files.image", {
    payload: { ...fileRead, maxBytes: PositiveInt },
    success: FileImage,
    error: listErrors,
  }),
  Rpc.make("host.files.resolve", {
    payload: {
      paths: Schema.Array(Schema.String),
      roots: Schema.Array(Schema.String),
      outside: Schema.Array(Schema.String),
    },
    success: Schema.Struct({
      files: FsResolveResult.fields.files,
      unchecked: Schema.Array(Schema.String),
    }),
    error: readErrors,
  }),
  Rpc.make("host.files.vocabulary", {
    payload: { root: Schema.String },
    success: HostVocabulary,
    error: readErrors,
  }),
  Rpc.make("host.files.fetch", {
    payload: { path: Schema.String, cwd: Schema.String, maxBytes: PositiveInt },
    success: HostFetchedFile,
    error: listErrors,
  }),
  Rpc.make("host.files.part", {
    payload: {
      ...fileRead,
      offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      length: PositiveInt.check(Schema.isLessThanOrEqualTo(HOST_FILE_PART_BYTES)),
    },
    success: HostFilePart,
    error: listErrors,
  }),
  Rpc.make("host.folders.browse", {
    payload: { input: Schema.String, limit: PositiveInt },
    success: FolderListing,
    error: listErrors,
  }),
  Rpc.make("host.folders.check", {
    payload: { path: Schema.String },
    success: HostFolderChecked,
    error: listErrors,
  }),
  Rpc.make("host.attachments.put", {
    payload: { threadId: ThreadId, name: Schema.String, data: Schema.String },
    success: Schema.Struct({ path: Schema.String }),
    error: readErrors,
  }),
  Rpc.make("host.attachments.remove", { payload: { threadId: ThreadId } }),
  Rpc.make("host.shared.open", {
    payload: { workspaceId: WorkspaceId },
    success: Schema.Struct({ path: Schema.String }),
    error: readErrors,
  }),
  Rpc.make("host.shared.list", {
    payload: { workspaceId: WorkspaceId },
    success: SharedListing,
    error: readErrors,
  }),
  Rpc.make("host.shared.read", {
    payload: {
      workspaceId: WorkspaceId,
      path: Schema.String,
      offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      length: PositiveInt.check(Schema.isLessThanOrEqualTo(SHARED_PART_BYTES)),
    },
    success: SharedPart,
    error: readErrors,
  }),
  Rpc.make("host.shared.write", {
    payload: {
      workspaceId: WorkspaceId,
      path: Schema.String,
      offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      data: Schema.String,
      size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      mtimeMs: Schema.Number,
      sha256: Schema.String,
      ifMatch: Schema.String,
    },
    success: Schema.Struct({ placed: Schema.Boolean }),
    error: readErrors,
  }),
  Rpc.make("host.shared.remove", {
    payload: { workspaceId: WorkspaceId, path: Schema.String, ifMatch: Schema.String },
    success: Schema.Struct({ removed: Schema.Boolean }),
    error: readErrors,
  }),
  Rpc.make("host.threadPlaces.make", {
    payload: { threadId: ThreadId, files: Schema.Array(ProfileFile) },
    success: Schema.Struct({ path: Schema.String }),
    error: readErrors,
  }),
  Rpc.make("host.threadPlaces.lay", {
    payload: { checkout: Schema.String, files: Schema.Array(ProfileFile) },
    success: Schema.Struct({ laid: Schema.Array(Schema.String) }),
    error: readErrors,
  }),
  Rpc.make("host.threadPlaces.remove", { payload: { threadId: ThreadId } }),
  Rpc.make("host.ports.scan", { success: HostPortScan, error: HostFailed }),
  Rpc.make("host.loopback.open", {
    payload: { tunnelId: LoopbackTunnelId, host: LoopbackHost, port: LoopbackPort },
    success: LoopbackEvent,
    error: HostFailed,
    stream: true,
  }),
  Rpc.make("host.loopback.send", {
    payload: { tunnelId: LoopbackTunnelId, data: Schema.String },
    error: HostFailed,
  }),
  Rpc.make("host.loopback.end", { payload: { tunnelId: LoopbackTunnelId } }),
  Rpc.make("host.status", { success: HostStatus }),
  Rpc.make("host.update.check", { success: HostUpdateCheck }),
  Rpc.make("host.update.start", {
    payload: { release: Schema.String.check(Schema.isMaxLength(64)) },
    success: HostUpdateProgress,
    error: HostUpdateRefused,
    stream: true,
  }),
  Rpc.make("host.stop.prepare", {
    payload: {
      checkouts: Schema.Array(HostStopCheckout).check(Schema.isMaxLength(512)),
      force: Schema.optionalKey(Schema.Boolean),
      remote: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
    },
    success: HostStopPrepared,
    error: HostFailed,
  }),
  Rpc.make("host.stop.keep", {
    payload: {
      checkouts: Schema.Array(HostStopCheckout).check(Schema.isMaxLength(64)),
      remote: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
    },
    success: Schema.Struct({ kept: Schema.Array(HostStopKept) }),
    error: HostFailed,
  }),
  Rpc.make("host.stop.cancel", {}),
  Rpc.make("host.stop.going", {
    success: Schema.Struct({ withinMs: Schema.Int }),
    stream: true,
  }),
  Rpc.make("host.stop.restore", {
    payload: {
      threadId: ThreadId,
      cwd: Schema.String.check(Schema.isMaxLength(4096)),
      url: Schema.String.check(Schema.isMaxLength(2048)),
      branch: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
      remote: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
      commit: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
      caughtUp: Schema.optionalKey(Schema.Boolean),
      /**
       * Another machine's ref of the thread to read instead of this host's own, served by a host
       * that names `wip-restore-ref`: it must be a ref of `threadId` and comes with `commit`.
       * Nothing else is tried when it isn't there: no branch is fallen back on.
       */
      ref: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
      /**
       * A resume before set out to put this folder back and didn't finish with it, served by a
       * host that names `wip-restore-pending`: one that is there is checked, not taken as is.
       */
      pending: Schema.optionalKey(Schema.Literal(true)),
      /**
       * A person took the branch without the work the stop kept (`commit`), which is gone from
       * the remote: the folder is made from `branch` all the same. A host before it does so
       * unasked, which the caller holds it to.
       */
      fromBranch: Schema.optionalKey(Schema.Literal(true)),
    },
    success: HostStopRestored,
    error: HostFailed,
  }),
  Rpc.make("host.stop.drop", {
    payload: {
      threadId: ThreadId,
      cwd: Schema.String.check(Schema.isMaxLength(4096)),
      remote: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
    },
    success: Schema.Struct({ dropped: Schema.Boolean }),
    error: HostFailed,
  }),
  Rpc.make("host.repos.ensure", {
    payload: { url: Schema.String },
    success: Schema.Struct({ path: Schema.String }),
    error: worktreeErrors,
  }),
  Rpc.make("host.repos.identify", {
    payload: { repoRoot: Schema.String, path: Schema.String },
    success: HostRepoIdentity,
    error: HostFailed,
  }),
  Rpc.make("host.worktrees.list", {
    payload: { repoPath: Schema.String, openCheckouts },
    success: WorktreeList,
    error: worktreeErrors,
  }),
  Rpc.make("host.worktrees.baseBranches", {
    payload: { repoPath: Schema.String },
    success: Schema.Struct({
      branches: Schema.Array(Schema.String),
      default: Schema.optionalKey(Schema.String),
    }),
    error: worktreeErrors,
  }),
  Rpc.make("host.worktrees.create", {
    payload: {
      repoPath: Schema.String,
      branch: Schema.optionalKey(Schema.String),
      base: Schema.optionalKey(Schema.String),
      untrusted: Schema.optionalKey(Schema.Boolean),
      openCheckouts,
    },
    success: HostCreatedWorktree,
    error: worktreeErrors,
  }),
  Rpc.make("host.worktreeHooks.inspect", {
    payload: WorktreeHookRequest.fields,
    success: WorktreeHookInspection,
    error: HostFailed,
  }),
  Rpc.make("host.worktreeHooks.run", {
    payload: WorktreeHookRun.fields,
    success: WorktreeHookOutcome,
    error: HostFailed,
  }),
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
  Rpc.make("host.worktrees.restore", {
    payload: {
      repoPath: Schema.String,
      worktreeDir: Schema.String,
      branch: Schema.String,
      fromPr: Schema.optionalKey(Schema.Int),
      untrusted: Schema.optionalKey(Schema.Boolean),
      openCheckouts,
    },
    success: HostRestoredWorktree,
    error: worktreeErrors,
  }),
  Rpc.make("host.worktrees.pendingPermissions", {
    payload: { repoPath: Schema.String, worktreeDir: Schema.String },
    success: Schema.Array(Schema.String),
    error: worktreeErrors,
  }),
  Rpc.make("host.checks.run", {
    payload: {
      id: Schema.String,
      path: Schema.String,
      repoRoot: Schema.optionalKey(Schema.String),
      head: Schema.String,
      base: Schema.String,
      command: Schema.String,
      setup: Schema.optionalKey(Schema.String),
      repositorySetup: Schema.optionalKey(HostCheckRepositorySetup),
      timeoutMs: PositiveInt,
    },
    success: HostCheckResult,
    error: HostFailed,
  }),
  Rpc.make("host.git.local", {
    payload: { cwd: Schema.String },
    success: GitState,
    error: commandErrors,
  }),
  Rpc.make("host.git.present", { payload: { cwd: Schema.String }, success: Schema.Boolean }),
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
  Rpc.make("host.terminals.close", {
    payload: { terminalId: TerminalId },
    error: Schema.Union([NotFound, HostFailed]),
  }),
  Rpc.make("host.terminals.list", {
    payload: { threadId: Schema.optionalKey(ThreadId) },
    success: Schema.Array(TerminalInfo),
  }),
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
  Rpc.make("host.terminals.roots", { success: HostTerminalRoot, stream: true }),
  Rpc.make("host.sessions.open", {
    payload: HostSessionOpen,
    success: HostSessionOpened,
    error: sessionErrors,
  }),
  Rpc.make("host.sessions.events", {
    payload: { ...session, afterSeq: Schema.Int },
    success: HostSessionEvent,
    error: NotFound,
    stream: true,
  }),
  Rpc.make("host.sessions.ack", { payload: { ...session, seq: Schema.Int } }),
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
  Rpc.make("host.appTools.open", {
    success: Schema.Struct({ url: Schema.String.check(Schema.isMaxLength(64)) }),
    error: HostFailed,
  }),
  Rpc.make("host.appTools.requests", {
    success: HostAppToolsRequest,
    error: HostFailed,
    stream: true,
  }),
  Rpc.make("host.appTools.answer", {
    payload: HostAppToolsAnswer,
    error: HostFailed,
  }),
  Rpc.make("host.sessions.retarget", {
    payload: {
      ...session,
      mcp: Schema.Struct({
        url: Schema.String,
        headers: Schema.Record(Schema.String, Schema.String),
      }),
    },
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
  Rpc.make("host.sessions.close", { payload: session }),
  Rpc.make("host.sessions.reload", {
    payload: { agent: AgentKind, reload: HostAgentReload },
  }),
  Rpc.make("host.sessions.accountScope", {
    payload: { agent: AgentKind },
    success: Schema.Struct({ scope: Schema.optionalKey(Schema.String) }),
    error: sessionErrors,
  }),
  Rpc.make("host.claude.setToken", {
    payload: { token: Schema.RedactedFromValue(Schema.String) },
    error: HostFailed,
  }),
  Rpc.make("host.claude.forgetToken", { success: Schema.Boolean, error: HostFailed }),
);
