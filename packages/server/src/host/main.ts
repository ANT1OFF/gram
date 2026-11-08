// `gram-host`: this machine's worker host as its own process. The server starts it with the host
// stream on file descriptor 3 and talks the host protocol over it; nothing here listens on a
// network. When the server goes, the stream closes and the host exits.

import { Socket as NetSocket } from "node:net";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { HOST_PROTOCOL_VERSION, LOCAL_HOST_ID } from "@gram/contracts";
import { Proc, ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import { liveScan } from "../ports/scan.ts";
import { filesOn } from "./files.ts";
import { HOST_CAPABILITIES, serveHost } from "./protocol.ts";

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
    scan: liveScan.pipe(Effect.provideService(Proc, proc)),
  });
}).pipe(Effect.provide(ProcLive));

NodeRuntime.runMain(program);
