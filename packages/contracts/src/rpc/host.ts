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
import { FsFilesResult, FsResolveResult } from "../fs-files.ts";
import { FsSearchResult } from "../fs-search.ts";
import {
  AgentKind,
  Checkout,
  ModelRef,
  PermissionMode,
  ReasoningVariant,
  RequestAnswer,
  UserInput,
} from "../domain.ts";
import { FolderListing, FsFile, FsListing, HostFolderChecked } from "../fs.ts";
import { GitState } from "../git.ts";
import { ClaudeSignIn } from "../launch-checks.ts";
import { HostId, ProfileId, RequestId, TerminalId, ThreadId } from "../ids.ts";
import { TerminalEvent, TerminalInfo, TerminalOpened } from "../terminal.ts";
import { ProfileFile } from "../thread-profile.ts";
import { FileImage } from "../thread-ui.ts";
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
  /**
   * Scoping and reading a thread's files on the host for previews, file links, `send_file` and
   * dictation's vocabulary (`host.files.scope` and the rest). Optional: a host without it still
   * runs its workers, and its files are refused here rather than read on this machine.
   */
  "file-reads",
  /** Holding the files a user attaches to a session on the host (`host.attachments.*`). Optional. */
  "attachments",
  /**
   * Runs a project's check of a head merged onto its base in the host's own repository, once per
   * check id, answering a repeat with the run already under way or its result.
   */
  "checks",
  /**
   * Says what a worker's worktree is now (`host.repos.identify`): its origin's identity, whether
   * it is a worktree of the clone it was made from, and its branch. Optional: without it, the
   * control plane can't confirm a worker there owns a pull request, and asks the user.
   */
  "repo-identity",
  /**
   * Updates itself to a Gram release the control plane names (`host.update.start`), from that
   * release's own download, and says how its last update went (`host.update.check`).
   */
  "update",
  /**
   * Lists and checks folders anywhere on the machine for a one-off thread the user places there
   * (`host.folders.*`), refusing credential folders and the host's own. Optional: without it, a
   * thread on the machine runs only in a new worktree of its clone.
   */
  "folders",
  /**
   * Makes a folder of the host's own for a thread started from a profile, and lays a profile's
   * files there or in a worktree of the host's clones (`host.threadPlaces.*`). Optional: a host
   * without it takes no such thread.
   */
  "thread-places",
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

const HostModelText = Schema.String.check(Schema.isMaxLength(128));

/**
 * A model the machine's Claude Code lists, as much as resolving a recommended tier on it needs:
 * its id, the id an alias runs, its name and the efforts it takes. Nothing about the account.
 */
export const HostModel = Schema.Struct({
  id: HostModelText,
  displayName: HostModelText,
  resolvedId: Schema.optionalKey(HostModelText),
  supportsEffort: Schema.Boolean,
  efforts: Schema.optionalKey(Schema.Array(ReasoningVariant).check(Schema.isMaxLength(8))),
});
export type HostModel = typeof HostModel.Type;

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
});
export type HostStatus = typeof HostStatus.Type;

/** What keeps a host from updating now: work that a restart would cut off. */
export const HostBusy = Schema.Struct({
  /** Agent sessions in a turn, waiting on a question, or with background tasks running. */
  turns: Schema.Int,
  /** Terminals running a command, or a sign-in shell still open. */
  terminals: Schema.Int,
  /** Clones or fetches of a repository in flight. */
  clones: Schema.Int,
  /** Project checks running or waiting their turn. */
  checks: Schema.Int,
});
export type HostBusy = typeof HostBusy.Type;

/** A thread's folder on a host, whose work in progress a stop keeps (`host.stop.prepare`). */
export const HostStopCheckout = Schema.Struct({
  threadId: ThreadId,
  cwd: Schema.String.check(Schema.isMaxLength(4096)),
});
export type HostStopCheckout = typeof HostStopCheckout.Type;

/** What a stop kept of one thread's folder: the hidden ref it wrote, and whether it was pushed. */
export const HostStopKept = Schema.Struct({
  threadId: ThreadId,
  cwd: Schema.String,
  /** `refs/gram/wip/<thread>`, once the working tree was committed under it. */
  ref: Schema.optionalKey(Schema.String),
  commit: Schema.optionalKey(Schema.String),
  /** Whether the remote now has that commit under the ref. */
  pushed: Schema.Boolean,
  /** Why it wasn't committed or pushed, in the host's words. */
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
});
export type HostStopKept = typeof HostStopKept.Type;

/**
 * A host's answer to `host.stop.prepare`. `idle` says nothing is running on it and nothing new
 * will start: it can be stopped now, and takes no new work until `host.stop.cancel` or ten minutes
 * pass. Not idle and not forced, nothing was changed and `kept` is empty.
 */
export const HostStopPrepared = Schema.Struct({
  idle: Schema.Boolean,
  busy: HostBusy,
  kept: Schema.Array(HostStopKept),
  /** Why it isn't idle when `busy` doesn't say, such as an update under way. */
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
});
export type HostStopPrepared = typeof HostStopPrepared.Type;

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

/** Why a check on the host didn't pass, as the control plane records it. */
export const HostCheckFailure = Schema.Struct({
  kind: Schema.Literals(["not-found", "timed-out", "exited", "stopped", "unstartable", "conflict"]),
  command: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Number),
  tail: Schema.optionalKey(Schema.String),
});

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

/** How a check on the host ended, and what it checked. */
export const HostCheckResult = Schema.Struct({
  /** The tree of the head merged onto the base; null when they conflict. */
  tree: Schema.NullOr(Schema.String),
  /** The throwaway commit of that tree the check ran on. */
  mergedCommit: Schema.optionalKey(Schema.String),
  ok: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
  failure: Schema.optionalKey(HostCheckFailure),
  /** The end of the run's output, bounded. */
  log: Schema.optionalKey(Schema.String),
  /** The host machine's own name. */
  host: Schema.String,
});
export type HostCheckResult = typeof HostCheckResult.Type;

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
  /**
   * One more MCP server for the session, by address. A host built before it was sent drops it,
   * and the session then opens without that server, never with more than it was meant to have.
   */
  mcpServer: Schema.optionalKey(Schema.Struct({ name: Schema.String, url: Schema.String })),
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

/** A file read for a preview: where, scoped to which roots, and whether outside them is allowed. */
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
  /**
   * `path` scoped to `roots` on the host, as `resolveScopedIn` does it: a relative path against
   * the first root, an absolute one against the root that really holds it, and nothing that leaves
   * its root lexically or through a link. What `host.files.list` and the rest then read.
   */
  Rpc.make("host.files.scope", {
    payload: { path: Schema.String, roots: Schema.Array(Schema.String) },
    success: Schema.String,
    error: listErrors,
  }),
  /**
   * A file preview on the host, scoped as `host.files.scope` scopes it. A path outside every root
   * is read only when `outside` allows it, and never a credential file; what refused it reads
   * `outside.refusal`. The control plane decides `outside` from the thread's transcript.
   */
  Rpc.make("host.files.file", {
    payload: { ...fileRead, maxBytes: PositiveInt },
    success: FsFile,
    error: listErrors,
  }),
  /** An image preview on the host, scoped and gated as `host.files.file` is. */
  Rpc.make("host.files.image", {
    payload: { ...fileRead, maxBytes: PositiveInt },
    success: FileImage,
    error: listErrors,
  }),
  /**
   * Which of `paths` name one file in `roots` on the host, as `resolveFileRefs` decides it. An
   * absolute path in no root is checked only when it is in `outside`; the rest of those come back
   * in `unchecked`, for the control plane to ask the thread's transcript about.
   */
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
  /** What dictation's project vocabulary reads from a checkout on the host. */
  Rpc.make("host.files.vocabulary", {
    payload: { root: Schema.String },
    success: HostVocabulary,
    error: readErrors,
  }),
  /**
   * A file's bytes for `send_file`: `path` resolved against `cwd` on the host, a regular file of
   * at most `maxBytes`, never a credential file.
   */
  Rpc.make("host.files.fetch", {
    payload: { path: Schema.String, cwd: Schema.String, maxBytes: PositiveInt },
    success: HostFetchedFile,
    error: listErrors,
  }),
  /**
   * Folders for a one-off thread's picker, as `fs.browse` lists them, on the host: `~` is the
   * host's home, and a credential folder or the host's own is never listed, nor listed into.
   */
  Rpc.make("host.folders.browse", {
    payload: { input: Schema.String, limit: PositiveInt },
    success: FolderListing,
    error: listErrors,
  }),
  /**
   * Whether a one-off thread may run in `path` on the host: an existing folder, its links
   * resolved, that is neither a credential folder nor the host's own, with its branch if it is on one.
   */
  Rpc.make("host.folders.check", {
    payload: { path: Schema.String },
    success: HostFolderChecked,
    error: listErrors,
  }),
  /**
   * Stores a file the user attached for `threadId`'s session in the host's own attachments folder,
   * and answers where, for the agent to read it there.
   */
  Rpc.make("host.attachments.put", {
    payload: { threadId: ThreadId, name: Schema.String, data: Schema.String },
    success: Schema.Struct({ path: Schema.String }),
    error: readErrors,
  }),
  /** Deletes what the host holds of `threadId`'s attachments: the thread is gone. */
  Rpc.make("host.attachments.remove", { payload: { threadId: ThreadId } }),
  /**
   * Makes `threadId`'s own folder under the host's thread folders, new and empty, lays `files` in
   * it and answers where it is. The host checks each path itself, and refuses an id it already
   * has a folder for.
   */
  Rpc.make("host.threadPlaces.make", {
    payload: { threadId: ThreadId, files: Schema.Array(ProfileFile) },
    success: Schema.Struct({ path: Schema.String }),
    error: readErrors,
  }),
  /**
   * Lays `files` in `checkout`, a worktree of the host's clones: never over a file already there
   * nor through a link, and named in an exclude file of that worktree alone. Answers which it wrote.
   */
  Rpc.make("host.threadPlaces.lay", {
    payload: { checkout: Schema.String, files: Schema.Array(ProfileFile) },
    success: Schema.Struct({ laid: Schema.Array(Schema.String) }),
    error: readErrors,
  }),
  /** Deletes `threadId`'s own folder, made by `host.threadPlaces.make`: the thread never started. */
  Rpc.make("host.threadPlaces.remove", { payload: { threadId: ThreadId } }),
  /** One sweep of the host's listening ports and processes. */
  Rpc.make("host.ports.scan", { success: HostPortScan, error: HostFailed }),
  /**
   * What this machine can run: whether its own Claude Code is signed in to a subscription (its
   * `claude auth status`, the classification only, never the output or a credential) and whether
   * `claude` and `git` are installed there. An older host answers with an unknown-request defect,
   * which the control plane reads as unknown.
   */
  Rpc.make("host.status", { success: HostStatus }),
  /** Served with `update`: whether it could update now, and how its last update went. */
  Rpc.make("host.update.check", { success: HostUpdateCheck }),
  /**
   * Served with `update`: downloads `release` from Gram's own GitHub releases, checks it against
   * that release's `SHA256SUMS.txt`, unpacks and tests it beside the app it runs, then hands its
   * service to it. The host restarts once the stream ends; it rolls back to the app it runs now
   * unless the new one dials in and is asked `host.update.check` within two minutes.
   */
  Rpc.make("host.update.start", {
    payload: { release: Schema.String.check(Schema.isMaxLength(64)) },
    success: HostUpdateProgress,
    error: HostUpdateRefused,
    stream: true,
  }),
  /**
   * Readies the host to be stopped with its disk kept. It stops taking new work, and when nothing
   * runs on it (the test an update waits on: no turn, busy terminal, clone or check), or `force`
   * says to go on regardless (a machine about to be taken away), it commits each listed folder's
   * working tree on top of its HEAD under `refs/gram/wip/<thread>` and pushes that ref to `remote`
   * (`origin` when left out). The branch, the index and the files stay as they are. A host built
   * before this answers with an unknown-request defect.
   */
  Rpc.make("host.stop.prepare", {
    payload: {
      checkouts: Schema.Array(HostStopCheckout).check(Schema.isMaxLength(512)),
      force: Schema.optionalKey(Schema.Boolean),
      remote: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
    },
    success: HostStopPrepared,
    error: HostFailed,
  }),
  /** Takes new work again after a `host.stop.prepare` that no stop followed. */
  Rpc.make("host.stop.cancel", {}),
  /**
   * The host's own clone of the repository at `url`, in the folder it keeps clones in: cloned when
   * it has none, fetched when it has. What a worker placed on this machine makes its worktree from.
   */
  Rpc.make("host.repos.ensure", {
    payload: { url: Schema.String },
    success: Schema.Struct({ path: Schema.String }),
    error: worktreeErrors,
  }),
  /**
   * What the worktree at `path` is now, beside the clone at `repoRoot` it was made from, on a host
   * that serves `repo-identity`. Read-only: nothing is fetched or cloned.
   */
  Rpc.make("host.repos.identify", {
    payload: { repoRoot: Schema.String, path: Schema.String },
    success: HostRepoIdentity,
    error: HostFailed,
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
  /**
   * Checks `head` merged onto `base`, from the repository of the checkout at `path` (or the clone
   * at `repoRoot`), with the project's command, on a host that serves `checks`. Taken once per `id`:
   * a repeat joins the run under way, or answers with how it ended.
   */
  Rpc.make("host.checks.run", {
    payload: {
      id: Schema.String,
      path: Schema.String,
      repoRoot: Schema.optionalKey(Schema.String),
      head: Schema.String,
      base: Schema.String,
      command: Schema.String,
      setup: Schema.optionalKey(Schema.String),
      timeoutMs: PositiveInt,
    },
    success: HostCheckResult,
    error: HostFailed,
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
