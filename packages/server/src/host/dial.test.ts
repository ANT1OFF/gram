import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Socket as NetSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { HOST_PROTOCOL_VERSION, HostId } from "@gram/contracts";
import { Proc, ProcLive, Worktrees, WorktreesLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { dialForever } from "./dial.ts";
import { attachmentsOnHost, fileReadsOn } from "./file-reads.ts";
import { filesOn } from "./files.ts";
import { gitOn } from "./git.ts";
import { generateHostKey, hostIdOf, privateKeyFrom } from "./machine-keys.ts";
import { HOST_SERVES, type HostService } from "./protocol.ts";
import { reposOn } from "./repos.ts";
import { noAgents, sessionsOnHost } from "./sessions.ts";
import { terminalsOnHost } from "./terminals.ts";

/** A main Gram that isn't there: every dial is refused at once. */
const refused = () => {
  const key = generateHostKey();
  return {
    origin: "http://127.0.0.1:9",
    hostId: hostIdOf(key.publicKey),
    key: privateKeyFrom(key.privateKeyPem),
    url: "ws://127.0.0.1:9/host/connect",
  };
};

/** A service that counts how often it was built and how often it ended. */
const counted = () => {
  const counts = { built: 0, ended: 0 };
  const service = Effect.gen(function* () {
    counts.built += 1;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        counts.ended += 1;
      }),
    );
    // Never served: no dial gets through.
    return {} as HostService;
  });
  return { counts, service };
};

describe("dialForever", () => {
  it.live("keeps what it serves across dials, so sessions outlive a dropped connection", () =>
    Effect.gen(function* () {
      const { counts, service } = counted();
      const fiber = yield* Effect.forkScoped(
        dialForever(refused(), service, { retryFirstMs: 50, detachedMs: 60_000 }),
      );
      yield* Effect.sleep("600 millis");
      // Several dials, one service: before, each dial built its own and ended it with the dial.
      expect(counts).toEqual({ built: 1, ended: 0 });
      yield* Fiber.interrupt(fiber);
      expect(counts).toEqual({ built: 1, ended: 1 });
    }).pipe(Effect.scoped),
  );

  it.live("ends what it kept once it has been without a connection for the grace", () =>
    Effect.gen(function* () {
      const { counts, service } = counted();
      const fiber = yield* Effect.forkScoped(
        dialForever(refused(), service, { retryFirstMs: 200, detachedMs: 100 }),
      );
      yield* Effect.sleep("600 millis");
      expect(counts.ended).toBeGreaterThanOrEqual(1);
      // Built afresh for the dial after it ended.
      expect(counts.built).toBeGreaterThanOrEqual(2);
      yield* Fiber.interrupt(fiber);
      expect(counts.built).toBe(counts.ended);
    }).pipe(Effect.scoped),
  );
});

/**
 * A main Gram that takes each dial's WebSocket upgrade and then, unless `pings`, never sends a
 * thing: to the host, a link that broke without a word. One that pings sends what the main Gram's
 * RPC client does every interval, as an unmasked text frame.
 */
const mainGram = (pings: number | undefined) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ port: number; dials: () => number; close: () => void }>((resolve) => {
          const sockets: Array<NetSocket> = [];
          const timers: Array<ReturnType<typeof setInterval>> = [];
          const server = createServer((socket) => {
            sockets.push(socket);
            socket.on("error", () => {});
            socket.once("data", (head) => {
              const key = /sec-websocket-key: *(.+)\r\n/i.exec(head.toString())?.[1]?.trim() ?? "";
              const accept = createHash("sha1")
                .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
                .digest("base64");
              socket.write(
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                  `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
              );
              if (pings === undefined) return;
              const ping = Buffer.from('{"_tag":"Ping"}\n');
              timers.push(
                setInterval(() => {
                  if (!socket.destroyed)
                    socket.write(Buffer.concat([Buffer.from([0x81, ping.length]), ping]));
                }, pings),
              );
            });
          });
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            resolve({
              port: typeof address === "object" && address !== null ? address.port : 0,
              dials: () => sockets.length,
              close: () => {
                for (const timer of timers) clearInterval(timer);
                for (const socket of sockets) socket.destroy();
                server.close();
              },
            });
          });
        }),
    ),
    (main) => Effect.sync(() => main.close()),
  );

/** A host that serves nothing but its hello, for a dial that gets through. */
const servedHost = (hostId: string) =>
  Effect.gen(function* () {
    const proc = yield* Proc;
    return {
      hello: {
        protocol: HOST_PROTOCOL_VERSION,
        hostId: HostId.make(hostId),
        capabilities: HOST_SERVES,
        platform: process.platform,
        pid: 1,
      },
      files: filesOn(proc),
      reads: fileReadsOn(proc),
      attachments: yield* attachmentsOnHost(mkdtempSync(join(tmpdir(), "gram-host-attached-"))),
      repos: reposOn(proc, "/nonexistent/gram-host-repos"),
      worktrees: yield* Worktrees,
      git: gitOn(proc),
      terminals: yield* terminalsOnHost,
      sessions: yield* sessionsOnHost(noAgents),
      scan: Effect.succeed({ listening: new Map(), children: new Map() }),
    } satisfies HostService;
  });

/** The host dialling `main` for good, on short timings. */
const dialling = (main: { port: number }) => {
  const key = generateHostKey();
  const hostId = hostIdOf(key.publicKey);
  return dialForever(
    {
      origin: `http://127.0.0.1:${main.port}`,
      hostId,
      key: privateKeyFrom(key.privateKeyPem),
      url: `ws://127.0.0.1:${main.port}/host/connect`,
    },
    servedHost(hostId),
    { retryFirstMs: 50, detachedMs: 60_000, idleMs: 300 },
  );
};

describe("dialForever over a link that went quiet", () => {
  it.live("dials again once the main Gram has said nothing for too long", () =>
    Effect.gen(function* () {
      const main = yield* mainGram(undefined);
      const fiber = yield* Effect.forkScoped(dialling(main));
      yield* Effect.sleep("1500 millis");
      // Before this change the host waited on the first socket for good: one dial, ever.
      expect(main.dials()).toBeGreaterThanOrEqual(2);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped, Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)))),
  );

  it.live("keeps a dial the main Gram keeps pinging", () =>
    Effect.gen(function* () {
      const main = yield* mainGram(100);
      const fiber = yield* Effect.forkScoped(dialling(main));
      yield* Effect.sleep("1500 millis");
      expect(main.dials()).toBe(1);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped, Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)))),
  );
});
