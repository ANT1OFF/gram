import { connect, createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_HOST_ID, type HostId, type Thread, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { hostLoopback } from "../host/loopback.ts";
import type { HostLoopbackConnection } from "../host/protocol.ts";
import { loopbackProxies, type LoopbackProxies, type RunFork } from "./loopback-proxy.ts";

/** The host's own tunnels, as a control plane's connection reaches them. */
const tunnels = (): HostLoopbackConnection => {
  const host = hostLoopback();
  return {
    open: (id, address, port) => host.open(id, address, port).pipe(Stream.mapError((e) => e)),
    send: host.send,
    end: host.end,
  };
};

const remoteThread = {
  id: "thread-1" as ThreadId,
  checkout: { hostId: "machine-1" as HostId },
} as unknown as Thread;

/** A server that answers what it is sent upper-cased, standing in for a dev server. */
const upper = () =>
  new Promise<{ server: Server; port: number }>((resolve) => {
    const server = createServer((socket) =>
      socket.on("data", (chunk) => socket.write(chunk.toString().toUpperCase())),
    );
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });

/** A SOCKS5 CONNECT to `host`:`port` through `proxy`: the reply's code, then what `send` gets back. */
const socks = (proxy: string, host: string, port: number, send = "") =>
  new Promise<{ code: number; answer: string }>((resolve, reject) => {
    const socket = connect(Number(new URL(proxy).port), "127.0.0.1");
    let stage = 0;
    let code = -1;
    let answer = "";
    socket.on("error", reject);
    socket.on("data", (chunk: Buffer) => {
      if (stage === 0) {
        stage = 1;
        const name = Buffer.from(host, "latin1");
        const request = Buffer.alloc(7 + name.length);
        request.set([0x05, 0x01, 0x00, 0x03, name.length]);
        name.copy(request, 5);
        request.writeUInt16BE(port, 5 + name.length);
        socket.write(request);
        return;
      }
      if (stage === 1) {
        stage = 2;
        code = chunk[1]!;
        answer += chunk.subarray(10).toString();
        if (code !== 0) return;
        socket.write(send);
        setTimeout(() => socket.end(), 200);
        return;
      }
      answer += chunk.toString();
    });
    socket.on("close", () => resolve({ code, answer }));
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
  });

/** Fibers the proxies start, in a scope the test keeps open. */
const run: RunFork = Effect.runSync(
  FiberSet.makeRuntime().pipe(Effect.provideService(Scope.Scope, Scope.makeUnsafe())),
);

let proxies: LoopbackProxies | undefined;
let servers: Server[] = [];
afterEach(async () => {
  await proxies?.close();
  for (const server of servers) server.close();
  servers = [];
});

describe("a remote thread's loopback proxy", () => {
  it("carries a connection to localhost to the thread's own machine's port", async () => {
    const { server, port } = await upper();
    servers.push(server);
    proxies = loopbackProxies(() => Effect.succeed({ tunnels: tunnels() }), run);
    const proxy = await Effect.runPromise(proxies.proxyFor(remoteThread));
    expect(proxy).toMatch(/^socks5:\/\/127\.0\.0\.1:\d+$/);
    // The same listener for the thread's next command.
    expect(await Effect.runPromise(proxies.proxyFor(remoteThread))).toBe(proxy);
    expect(await socks(proxy!, "localhost", port, "hello")).toEqual({ code: 0, answer: "HELLO" });
  });

  it("refuses anything but loopback ports from 1024, before the host is asked", async () => {
    let asked = 0;
    proxies = loopbackProxies(
      () =>
        Effect.sync(() => {
          asked += 1;
          return tunnels();
        }),
      run,
    );
    const proxy = (await Effect.runPromise(proxies.proxyFor(remoteThread)))!;
    asked = 0;
    expect((await socks(proxy, "example.com", 443)).code).toBe(0x02);
    expect((await socks(proxy, "10.0.0.5", 3000)).code).toBe(0x02);
    expect((await socks(proxy, "localhost", 22)).code).toBe(0x02);
    expect(asked).toBe(0);
  });

  it("answers a port nothing listens on as refused", async () => {
    const { server, port } = await upper();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    proxies = loopbackProxies(() => Effect.succeed({ tunnels: tunnels() }), run);
    const proxy = (await Effect.runPromise(proxies.proxyFor(remoteThread)))!;
    expect((await socks(proxy, "localhost", port)).code).toBe(0x05);
  });

  it("keeps a thread's proxy while its machine is away, refusing its connections", async () => {
    let away = true;
    const { server, port } = await upper();
    servers.push(server);
    proxies = loopbackProxies(() => Effect.succeed(away ? undefined : { tunnels: tunnels() }), run);
    const proxy = (await Effect.runPromise(proxies.proxyFor(remoteThread)))!;
    // Never this machine's loopback meanwhile, where the same port answers.
    expect((await socks(proxy, "localhost", port)).code).toBe(0x01);
    away = false;
    expect(await Effect.runPromise(proxies.proxyFor(remoteThread))).toBe(proxy);
    expect(await socks(proxy, "localhost", port, "back")).toEqual({ code: 0, answer: "BACK" });
  });

  it("closes with a connection still open", async () => {
    const { server, port } = await upper();
    servers.push(server);
    proxies = loopbackProxies(() => Effect.succeed({ tunnels: tunnels() }), run);
    const proxy = (await Effect.runPromise(proxies.proxyFor(remoteThread)))!;
    const idle = connect(Number(new URL(proxy).port), "127.0.0.1");
    await new Promise((resolve) => idle.once("connect", resolve));
    await proxies.close();
    proxies = undefined;
    expect(port).toBeGreaterThan(0);
  });

  it("gives no proxy to a thread on this machine, or on a host without tunnels", async () => {
    proxies = loopbackProxies(() => Effect.succeed({ tunnels: tunnels() }), run);
    const local = { ...remoteThread, checkout: { hostId: LOCAL_HOST_ID } } as unknown as Thread;
    expect(await Effect.runPromise(proxies.proxyFor(local))).toBeUndefined();
    const older = loopbackProxies(() => Effect.succeed({ tunnels: undefined }), run);
    expect(await Effect.runPromise(older.proxyFor(remoteThread))).toBeUndefined();
  });
});
