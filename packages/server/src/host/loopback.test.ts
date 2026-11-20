import { createServer, type Server, type Socket } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { HOST_PROTOCOL_VERSION, LOCAL_HOST_ID, type LoopbackEvent } from "@gram/contracts";
import { ProcLive, Worktrees, WorktreesLive, Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentsOnHost, fileReadsOn } from "./file-reads.ts";
import { filesOn } from "./files.ts";
import { gitOn } from "./git.ts";
import { hostLoopback } from "./loopback.ts";
import {
  connectHost,
  HOST_FEATURES,
  HOST_SERVES,
  serveHost,
  type HostService,
} from "./protocol.ts";
import { reposOn } from "./repos.ts";
import { noAgents, sessionsOnHost } from "./sessions.ts";
import { terminalsOnHost } from "./terminals.ts";
import { streamPair } from "./test-stream.ts";

/** A TCP server on the machine's loopback that answers each line with it upper-cased. */
const upperServer = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ server: Server; port: number; sockets: Set<Socket> }>((resolve) => {
        const sockets = new Set<Socket>();
        const server = createServer((socket) => {
          sockets.add(socket);
          socket.on("close", () => sockets.delete(socket));
          socket.on("data", (chunk) => socket.write(chunk.toString().toUpperCase()));
          socket.on("end", () => socket.end("bye"));
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resolve({
            server,
            port: typeof address === "object" && address ? address.port : 0,
            sockets,
          });
        });
      }),
  ),
  ({ server, sockets }) =>
    Effect.promise(() => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
);

const connected = (features = HOST_FEATURES, loopback = hostLoopback()) =>
  Effect.gen(function* () {
    const { host, control } = yield* streamPair;
    const service: HostService = {
      hello: {
        protocol: HOST_PROTOCOL_VERSION,
        hostId: LOCAL_HOST_ID,
        capabilities: HOST_SERVES,
        features,
        platform: process.platform,
        pid: 4242,
      },
      files: filesOn(yield* Proc),
      reads: fileReadsOn(yield* Proc),
      attachments: yield* attachmentsOnHost(mkdtempSync(join(tmpdir(), "gram-host-attached-"))),
      repos: reposOn(yield* Proc, "/nonexistent/gram-host-repos"),
      worktrees: yield* Worktrees,
      git: gitOn(yield* Proc),
      terminals: yield* terminalsOnHost,
      sessions: yield* sessionsOnHost(noAgents),
      scan: Effect.die("not scanned"),
      loopback,
    };
    yield* Effect.forkScoped(
      serveHost(yield* NodeSocket.fromDuplex(Effect.succeed(host)), service),
    );
    return yield* connectHost(yield* NodeSocket.fromDuplex(Effect.succeed(control)));
  });

const text = (events: ReadonlyArray<LoopbackEvent>) =>
  events
    .map((event) => (event.type === "data" ? Buffer.from(event.data, "base64").toString() : ""))
    .join("");

const onHost = Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)));

describe("a host's loopback tunnels", () => {
  it.live("carries bytes both ways to a port on the machine, and its close back", () =>
    Effect.gen(function* () {
      const { port, sockets } = yield* upperServer;
      const host = yield* connected();
      const tunnels = host.loopback!;
      const reading = yield* tunnels
        .open("tunnel-one", "localhost", port)
        .pipe(Stream.runCollect, Effect.forkScoped);
      // Sent once the port has a connection, as a SOCKS proxy sends after its reply.
      while (sockets.size === 0) yield* Effect.sleep("10 millis");
      yield* Effect.eventually(tunnels.send("tunnel-one", Buffer.from("hello").toString("base64")));
      yield* tunnels.end("tunnel-one");
      const events = yield* Fiber.join(reading);
      expect(events[0]).toEqual({ type: "connected" });
      expect(text(events)).toBe("HELLObye");
      // The tunnel is gone once its stream ended.
      expect((yield* tunnels.send("tunnel-one", "aGk=").pipe(Effect.flip))._tag).toBe("HostFailed");
    }).pipe(Effect.scoped, onHost),
  );

  it.live("closes the machine's connection when the control plane stops reading", () =>
    Effect.gen(function* () {
      const { port, sockets } = yield* upperServer;
      const host = yield* connected();
      const reading = yield* host
        .loopback!.open("tunnel-two", "127.0.0.1", port)
        .pipe(Stream.runDrain, Effect.forkScoped);
      while (sockets.size === 0) yield* Effect.sleep("10 millis");
      yield* Fiber.interrupt(reading);
      while (sockets.size > 0) yield* Effect.sleep("10 millis");
      expect(sockets.size).toBe(0);
    }).pipe(Effect.scoped, onHost),
  );

  it.live("fails a port nothing listens on as the tunnel's own failure, not the host's", () =>
    Effect.gen(function* () {
      const { port, server } = yield* upperServer;
      yield* Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())));
      const host = yield* connected();
      const failure = yield* host
        .loopback!.open("tunnel-three", "localhost", port)
        .pipe(Stream.runDrain, Effect.flip);
      expect(failure._tag).toBe("HostFailed");
      expect(host.gone()).toBe(false);
    }).pipe(Effect.scoped, onHost),
  );

  it.live("offers no tunnels from a host that doesn't name them", () =>
    Effect.gen(function* () {
      const host = yield* connected(HOST_FEATURES.filter((f) => f !== "loopback-tunnels"));
      expect(host.loopback).toBeUndefined();
    }).pipe(Effect.scoped, onHost),
  );
});
