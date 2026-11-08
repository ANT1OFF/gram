import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { InvalidState, NotFound } from "../errors.ts";
import { FsFilesResult } from "../fs-files.ts";
import { FsSearchResult } from "../fs-search.ts";
import { FsListing } from "../fs.ts";
import { HostId } from "../ids.ts";
import { PositiveInt } from "./shared.ts";

/**
 * The host protocol's version. A control plane and a host that disagree on it don't talk: the
 * hello says so, and the control plane treats the host as unavailable.
 */
export const HOST_PROTOCOL_VERSION = 1;

/** What a host can do, named so a control plane uses only what a host advertised. */
export const HostCapability = Schema.Literals(["files", "ports"]);
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

const fileErrors = Schema.Union([NotFound, InvalidState, HostFailed]);

/**
 * What a control plane asks of a worker host. The caller has already decided a path is one it may
 * read; the host only reads it. Paths are the host's own.
 */
export const HostRpcs = RpcGroup.make(
  /** The first call on a connection: the host's version, id and capabilities. */
  Rpc.make("host.hello", { success: HostHello }),
  /** A folder's entries for the Files panel. */
  Rpc.make("host.files.list", {
    payload: { path: Schema.String, showHidden: Schema.Boolean, limit: PositiveInt },
    success: FsListing,
    error: fileErrors,
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
    error: fileErrors,
  }),
  /** Every file name under `root`, capped. */
  Rpc.make("host.files.names", {
    payload: { root: Schema.String },
    success: FsFilesResult,
    error: fileErrors,
  }),
  /** One sweep of the host's listening ports and processes. */
  Rpc.make("host.ports.scan", { success: HostPortScan, error: HostFailed }),
);
