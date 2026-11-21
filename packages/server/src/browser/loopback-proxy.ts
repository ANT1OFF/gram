import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

import {
  LOOPBACK_CHUNK_BYTES,
  type LoopbackHost,
  type Thread,
  LOCAL_HOST_ID,
  sessionHostOf,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import type { HostLoopbackConnection } from "../host/protocol.ts";

/** The most threads that keep a listener at once; the one used longest ago closes for the next. */
export const LOOPBACK_PROXIES_MAX = 32;

const REPLY = {
  succeeded: 0x00,
  failed: 0x01,
  notAllowed: 0x02,
  refused: 0x05,
  commandNotSupported: 0x07,
  addressNotSupported: 0x08,
} as const;

const reply = (code: number) => Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);

/** What a SOCKS5 CONNECT asked for, read from the start of `buffer`; `undefined` while short. */
export type SocksRequest =
  | {
      readonly kind: "connect";
      readonly host: string;
      readonly port: number;
      readonly rest: Buffer;
    }
  | { readonly kind: "refused"; readonly code: number };

/** The greeting's length, once `buffer` holds it all; whether it offers no authentication. */
export const readGreeting = (
  buffer: Buffer,
): { readonly length: number; readonly noAuth: boolean } | "bad" | undefined => {
  if (buffer.length < 2) return undefined;
  if (buffer[0] !== 0x05) return "bad";
  const length = 2 + buffer[1]!;
  if (buffer.length < length) return undefined;
  return { length, noAuth: buffer.subarray(2, length).includes(0x00) };
};

/** The CONNECT request at the start of `buffer`, past the greeting. */
export const readRequest = (buffer: Buffer): SocksRequest | undefined => {
  if (buffer.length < 5) return undefined;
  if (buffer[0] !== 0x05) return { kind: "refused", code: REPLY.failed };
  if (buffer[1] !== 0x01) return { kind: "refused", code: REPLY.commandNotSupported };
  const type = buffer[3];
  let host: string;
  let at: number;
  if (type === 0x01) {
    if (buffer.length < 10) return undefined;
    host = Array.from(buffer.subarray(4, 8)).join(".");
    at = 8;
  } else if (type === 0x03) {
    const length = buffer[4]!;
    if (buffer.length < 5 + length + 2) return undefined;
    host = buffer.subarray(5, 5 + length).toString("latin1");
    at = 5 + length;
  } else if (type === 0x04) {
    if (buffer.length < 22) return undefined;
    const words: string[] = [];
    for (let i = 4; i < 20; i += 2) words.push(buffer.readUInt16BE(i).toString(16));
    host = words.join(":");
    at = 20;
  } else return { kind: "refused", code: REPLY.addressNotSupported };
  return { kind: "connect", host, port: buffer.readUInt16BE(at), rest: buffer.subarray(at + 2) };
};

/** The loopback address a request names, as the host takes it; `undefined` for anything else. */
export const loopbackHostOf = (host: string): LoopbackHost | undefined => {
  const name = host.toLowerCase();
  if (name === "localhost" || name === "localhost.") return "localhost";
  if (name === "127.0.0.1") return "127.0.0.1";
  if (name === "::1" || name === "0:0:0:0:0:0:0:1") return "::1";
  return undefined;
};

/** The thread's machine's tunnels now, if it runs elsewhere and its host serves them. */
/**
 * The thread's machine as its host reaches it now: its tunnels, `undefined` among them for a
 * host that serves none; `undefined` for a machine not reachable now (or no thread).
 */
export type LoopbackOf = (
  threadId: string,
) => Effect.Effect<{ readonly tunnels: HostLoopbackConnection | undefined } | undefined>;

/** Starts `effect` in the listeners' owner's scope, so nothing outlives it. */
export type RunFork = <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;

const serveSocks = (
  socket: Socket,
  tunnelsOf: Effect.Effect<HostLoopbackConnection | undefined>,
  run: RunFork,
) => {
  let buffer = Buffer.alloc(0);
  let stage: "greeting" | "request" | "tunnel" = "greeting";
  const refuse = (code: number) => {
    socket.end(reply(code));
  };
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (stage === "greeting") {
      const greeting = readGreeting(buffer);
      if (greeting === undefined) return;
      if (greeting === "bad" || !greeting.noAuth) {
        socket.end(Buffer.from([0x05, 0xff]));
        return;
      }
      socket.write(Buffer.from([0x05, 0x00]));
      buffer = buffer.subarray(greeting.length);
      stage = "request";
    }
    if (stage !== "request") return;
    const request = readRequest(buffer);
    if (request === undefined) return;
    if (request.kind === "refused") return refuse(request.code);
    const host = loopbackHostOf(request.host);
    if (host === undefined || request.port < 1024) return refuse(REPLY.notAllowed);
    stage = "tunnel";
    socket.off("data", onData);
    socket.pause();
    open(host, request.port, request.rest);
  };
  const open = (host: LoopbackHost, port: number, early: Buffer) => {
    const tunnelId = randomBytes(12).toString("base64url");
    let connected = false;
    let writes: Promise<unknown> = Promise.resolve();
    const forward = (chunk: Buffer) => {
      for (let at = 0; at < chunk.length; at += LOOPBACK_CHUNK_BYTES) {
        const data = chunk.subarray(at, at + LOOPBACK_CHUNK_BYTES).toString("base64");
        writes = writes.then(() =>
          Effect.runPromise(
            tunnels!
              .send(tunnelId, data)
              .pipe(Effect.catch(() => Effect.sync(() => socket.destroy()))),
          ),
        );
      }
      socket.pause();
      void writes.then(() => socket.resume());
    };
    let tunnels: HostLoopbackConnection | undefined;
    const fiber = run(
      Effect.gen(function* () {
        tunnels = yield* tunnelsOf;
        if (tunnels === undefined) {
          refuse(REPLY.failed);
          return;
        }
        yield* tunnels.open(tunnelId, host, port).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.type === "connected") {
                connected = true;
                socket.write(reply(REPLY.succeeded));
                if (early.length > 0) forward(early);
                socket.on("data", forward);
                socket.once("end", () => {
                  void writes.then(() => Effect.runPromise(tunnels!.end(tunnelId)));
                });
                socket.resume();
              } else socket.write(Buffer.from(event.data, "base64"));
            }),
          ),
          Effect.matchEffect({
            onFailure: () =>
              Effect.sync(() => (connected ? socket.destroy() : refuse(REPLY.refused))),
            onSuccess: () => Effect.sync(() => socket.end()),
          }),
        );
      }),
    );
    socket.once("close", () => {
      run(Fiber.interrupt(fiber));
    });
  };
  socket.on("data", onData);
  socket.on("error", () => socket.destroy());
};

const closeOne = (made: Promise<{ server: Server; sockets: Set<Socket> }>) =>
  made.then(
    ({ server, sockets }) =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
    () => {},
  );

export interface LoopbackProxies {
  /** The proxy for `thread`'s loopback, when it runs on a machine whose host serves tunnels. */
  readonly proxyFor: (thread: Thread) => Effect.Effect<string | undefined>;
  readonly close: () => Promise<void>;
}

/**
 * One listener per thread that needs one, made on first use and kept while the thread uses it; at
 * most `LOOPBACK_PROXIES_MAX`. Each connection asks `loopbackOf` afresh, so a host that dialled in
 * again is the one reached.
 */
export const loopbackProxies = (loopbackOf: LoopbackOf, run: RunFork): LoopbackProxies => {
  const listeners = new Map<
    string,
    Promise<{ server: Server; sockets: Set<Socket>; proxy: string }>
  >();
  const listen = (threadId: string) =>
    new Promise<{ server: Server; sockets: Set<Socket>; proxy: string }>((resolve, reject) => {
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        serveSocks(
          socket,
          Effect.map(loopbackOf(threadId), (reached) => reached?.tunnels),
          run,
        );
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          server.close();
          reject(new Error("The loopback proxy has no port."));
          return;
        }
        resolve({ server, sockets, proxy: `socks5://127.0.0.1:${address.port}` });
      });
    });
  return {
    proxyFor: (thread) =>
      Effect.gen(function* () {
        if (sessionHostOf(thread) === LOCAL_HOST_ID) return undefined;
        const reached = yield* loopbackOf(thread.id);
        if (reached !== undefined && reached.tunnels === undefined) return undefined;
        let made = listeners.get(thread.id);
        if (made === undefined) {
          for (const [other, old] of listeners) {
            if (listeners.size < LOOPBACK_PROXIES_MAX) break;
            listeners.delete(other);
            void closeOne(old);
          }
          made = listen(thread.id);
          listeners.set(thread.id, made);
        } else {
          listeners.delete(thread.id);
          listeners.set(thread.id, made);
        }
        const known = made;
        return yield* Effect.promise(() =>
          known.then(
            ({ proxy }) => proxy,
            () => {
              if (listeners.get(thread.id) === known) listeners.delete(thread.id);
              return undefined;
            },
          ),
        );
      }),
    close: async () => {
      const all = [...listeners.values()];
      listeners.clear();
      await Promise.all(all.map(closeOne));
    },
  };
};
