import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { InvalidState, NotFound } from "../errors.ts";
import { FsFilesResult } from "../fs-files.ts";
import { FsSearchResult } from "../fs-search.ts";
import { Checkout } from "../domain.ts";
import { FsListing } from "../fs.ts";
import { GitState } from "../git.ts";
import { HostId } from "../ids.ts";
import { WorktreeList } from "../worktrees.ts";
import { PositiveInt } from "./shared.ts";

/**
 * The host protocol's version. A control plane and a host that disagree on it don't talk: the
 * hello says so, and the control plane treats the host as unavailable.
 */
export const HOST_PROTOCOL_VERSION = 1;

/** What a host can do, named so a control plane uses only what a host advertised. */
export const HostCapability = Schema.Literals(["files", "ports", "worktrees", "git"]);
export type HostCapability = typeof HostCapability.Type;

/** The host's answer to `host.hello`: who it is and what it can do. */
export const HostHello = Schema.Struct({
  protocol: Schema.Int,
  hostId: HostId,
  capabilities: Schema.Array(HostCapability),
  platform: Schema.String,
  pid: Schema.Int,
});
export type HostHello = typeof HostHello.Type;

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
);
