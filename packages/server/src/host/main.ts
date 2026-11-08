// `gram-host`: this machine's worker host as its own process. The server starts it with the host
// stream on file descriptor 3 and talks the host protocol over it; nothing here listens on a
// network. When the server goes, the stream closes and the host exits.

import { Socket as NetSocket } from "node:net";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { HOST_PROTOCOL_VERSION, LOCAL_HOST_ID } from "@gram/contracts";
import { Proc, ProcLive, Worktrees, WorktreesLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { liveScan } from "../ports/scan.ts";
import { filesOn } from "./files.ts";
import { gitOn } from "./git.ts";
import { terminalsOnHost } from "./terminals.ts";
import { HOST_CAPABILITIES, serveHost } from "./protocol.ts";

// The server starts the host as plain Node under Electron; what the host runs (git, ps, an editor
// git opens) must not inherit that.
delete process.env["ELECTRON_RUN_AS_NODE"];

/** The descriptor the server hands the host stream on. */
export const HOST_STREAM_FD = 3;

const program = Effect.gen(function* () {
  const proc = yield* Proc;
  const socket = yield* NodeSocket.fromDuplex(
    Effect.sync(() => new NetSocket({ fd: HOST_STREAM_FD, readable: true, writable: true })),
  );
  yield* serveHost(socket, {
    hello: {
      protocol: HOST_PROTOCOL_VERSION,
      hostId: LOCAL_HOST_ID,
      capabilities: HOST_CAPABILITIES,
      platform: process.platform,
      pid: process.pid,
    },
    files: filesOn(proc),
    worktrees: yield* Worktrees,
    git: gitOn(proc),
    terminals: yield* terminalsOnHost,
    scan: liveScan.pipe(Effect.provideService(Proc, proc)),
  });
}).pipe(Effect.scoped, Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive))));

NodeRuntime.runMain(program);
