import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { afterAll, describe, expect, it as test, layer, vi } from "@effect/vitest";
import { DEFAULT_SETTINGS, GramRpcs, type ThreadId } from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import pino from "pino";
import { randomBytes } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  Agent,
  createServer,
  request as httpRequest,
  Server,
  type IncomingHttpHeaders,
} from "node:http";
import type { Socket as NetSocket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { ServerConfig } from "../config.ts";
import { gitPlatformTest } from "../git/platform.ts";
import { serverLogLayer } from "../logging/service.ts";
import {
  HttpRouter,
  HttpPlatform,
  HttpServer,
  HttpServerResponse,
  Rpc,
  RpcClient,
  RpcGroup,
  RpcSerialization,
  Socket,
} from "../platform/unstable.ts";
import { logDefects } from "../rpc/handlers/common.ts";
import { FakeAgentAdapter } from "../runtime/fake-agent.ts";
import { TurnHooks } from "../runtime/hooks.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { captureLogs } from "@gram/agents/testing/logs";
import { attestShutdown, stopForShutdown } from "../runtime/shutdown.ts";
import { remoteCookieName } from "./remote-access.ts";
import { tokenCookieName } from "./auth.ts";
import {
  bootLine,
  guardFileBody,
  GuardedHttpPlatform,
  LaunchToken,
  rpcRoutes,
  serverPort,
  ServerLayer,
} from "./server.ts";

interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

const raw = (
  port: number,
  options: { path?: string; method?: string; headers?: Record<string, string>; body?: string } = {},
) =>
  Effect.promise(
    () =>
      new Promise<RawResponse>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: options.path ?? "/",
            method: options.method ?? "GET",
            headers: options.headers,
            // A fresh connection per request: a rejected upgrade leaves its socket unusable.
            agent: false,
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => (body += chunk));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
            );
          },
        );
        req.on("error", reject);
        req.end(options.body);
      }),
  );

/** The status a WebSocket upgrade of `/ws` gets: 101 when accepted. */
const upgradeStatus = (port: number, headers: Record<string, string>, path = "/ws") =>
  Effect.promise(
    () =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest({
          host: "127.0.0.1",
          port,
          path,
          agent: false,
          headers: {
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": randomBytes(16).toString("base64"),
            ...headers,
          },
        });
        req.on("upgrade", (_res, socket) => {
          socket.destroy();
          resolve(101);
        });
        req.on("response", (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      }),
  );

const remoteDataDir = mkdtempSync(join(tmpdir(), "gram-remote-http-"));
afterAll(() => rmSync(remoteDataDir, { recursive: true, force: true }));
const webRoot = mkdtempSync(join(tmpdir(), "gram-web-"));
writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>Gram</title>");
writeFileSync(join(webRoot, "app.js"), "console.log('app')");
// File-level, so it runs after the layer's teardown; Windows refuses to delete a directory the live
// server or a just-exited child still holds, hence the retries.
afterAll(() => rmSync(webRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const testServer = (remoteOrigin?: string) =>
  ServerLayer.pipe(
    Layer.provide(FakeAgentAdapter),
    Layer.provide(TurnHooks.layerNoop),
    Layer.provide(gitPlatformTest()),
    Layer.provide(
      ServerConfig.layer({
        ...TEST_CONFIG,
        dataDir: remoteDataDir,
        webRoot,
        ...(remoteOrigin ? { remoteOrigin } : {}),
      }),
    ),
    Layer.orDie,
    // Shutdown logs its steps; a warning would be news.
    Layer.provideMerge(captureLogs({ printWarnings: true }).layer),
  );

const TestServer = testServer();

const serverInfo = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const { token } = yield* LaunchToken;
  return { port: serverPort(server), token };
});

/** Performs the boot navigation and returns the resulting `Cookie` header value. */
const bootCookie = Effect.gen(function* () {
  const { port, token } = yield* serverInfo;
  const response = yield* raw(port, { path: `/?boot=${token}` });
  const setCookie = response.headers["set-cookie"]?.[0] ?? "";
  return setCookie.split(";")[0] ?? "";
});

const CookieWebSocket = (cookie: string) =>
  Layer.succeed(Socket.WebSocketConstructor)(
    (url) =>
      new (globalThis.WebSocket as unknown as new (
        url: string,
        init: { headers: Record<string, string> },
      ) => globalThis.WebSocket)(url, { headers: { cookie } }),
  );

/** A client whose socket lives in the caller's scope; `Effect.provide` would close it at once. */
const makeClient = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  port: number,
  cookie: string,
) =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/ws`)),
        Layer.provide(CookieWebSocket(cookie)),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
    return yield* RpcClient.make(group).pipe(Effect.provideContext(protocol));
  });

/** A renderer connection is independent of the server's service scope during update teardown. */
test("completes shutdown with an independently held renderer WebSocket", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const context = yield* Layer.buildWithScope(TestServer, scope);
        const { port, token } = yield* serverInfo.pipe(Effect.provideContext(context));
        const response = yield* raw(port, { path: `/?boot=${token}` });
        const cookie = response.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
        const agent = new Agent({ keepAlive: true });
        yield* Effect.addFinalizer(() => Effect.sync(() => agent.destroy()));
        const httpSocket = yield* Effect.promise(
          () =>
            new Promise<NetSocket>((resolve, reject) => {
              const req = httpRequest(
                { host: "127.0.0.1", port, path: "/", agent, headers: { cookie } },
                (res) => {
                  const connection = res.socket;
                  res.resume();
                  res.on("end", () => resolve(connection));
                },
              );
              req.on("error", reject);
              req.end();
            }),
        );
        const httpClosed = new Promise<void>((resolve) =>
          httpSocket.once("close", () => resolve()),
        );
        expect(httpSocket.destroyed).toBe(false);
        const socket = new (globalThis.WebSocket as unknown as new (
          url: string,
          init: { headers: Record<string, string> },
        ) => globalThis.WebSocket)(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
        const closed = new Promise<void>((resolve) =>
          socket.addEventListener("close", () => resolve(), { once: true }),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()));
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              socket.addEventListener("open", () => resolve(), { once: true });
              socket.addEventListener(
                "error",
                () => reject(new Error("Owned renderer WebSocket failed")),
                { once: true },
              );
            }),
        );
        const exit = yield* stopForShutdown(() => {}).pipe(
          Effect.provideContext(context),
          Effect.flatMap((complete) => Scope.close(scope, Exit.void).pipe(Effect.as(complete))),
          Effect.exit,
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        const posted: unknown[] = [];
        expect(attestShutdown(exit, true, (message) => posted.push(message))).toBe(0);
        expect(posted).toEqual([{ type: "shutdownComplete", success: true }]);
        yield* Effect.promise(() => Promise.all([closed, httpClosed]));
        expect(httpSocket.destroyed).toBe(true);
        expect(socket.readyState).toBe(WebSocket.CLOSED);
      }),
    ),
  );
});

test("refuses teardown attestation on a real HTTP close callback failure", async () => {
  const originalClose = Server.prototype.close;
  Server.prototype.close = function (callback) {
    return originalClose.call(this, (error) =>
      callback?.(error ?? new Error("synthetic HTTP close failure")),
    );
  };
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const context = yield* Layer.buildWithScope(TestServer, scope);
          const exit = yield* stopForShutdown(() => {}).pipe(
            Effect.provideContext(context),
            Effect.flatMap((complete) => Scope.close(scope, Exit.void).pipe(Effect.as(complete))),
            Effect.exit,
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true);
          const posted: unknown[] = [];
          expect(attestShutdown(exit, true, (message) => posted.push(message))).toBe(1);
          expect(posted).toEqual([]);
        }),
      ),
    );
  } finally {
    Server.prototype.close = originalClose;
  }
});

test("completes shutdown when a request arrives during service teardown", async () => {
  const scope = await Effect.runPromise(Scope.make());
  const finalizing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const originalStore = ThreadStore.layerSqlite;
  const originalEmit = Server.prototype.emit;
  const received = Promise.withResolvers<void>();
  const emitted = vi.spyOn(Server.prototype, "emit").mockImplementation(function (
    this: Server,
    event: string | symbol,
    ...args: unknown[]
  ) {
    if (event === "request" && Reflect.get(args[0] as object, "url") === "/shutdown-probe")
      received.resolve();
    return originalEmit.call(this, event, ...args);
  });
  let req: ReturnType<typeof httpRequest> | undefined;
  let closing: Promise<Exit.Exit<boolean, unknown>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const response = Promise.withResolvers<{ status: number; connection: string | undefined }>();
  const closed = Promise.withResolvers<void>();
  // Cleanup may abort the request after a failed deadline assertion. That rejection must not
  // become an unrelated unhandled rejection; the normal oracle still awaits the same promise.
  void response.promise.catch(() => {});
  let completed = false;
  const storeLayer = vi.spyOn(ThreadStore, "layerSqlite").mockImplementation((file, options) =>
    originalStore(file, options).pipe(
      Layer.tap(() =>
        Effect.addFinalizer(() =>
          Effect.promise(async () => {
            finalizing.resolve();
            await release.promise;
          }),
        ),
      ),
    ),
  );
  try {
    const context = await Effect.runPromise(Layer.buildWithScope(TestServer, scope));
    const { port } = await Effect.runPromise(serverInfo.pipe(Effect.provideContext(context)));
    closing = Effect.runPromise(
      stopForShutdown(() => {}).pipe(
        Effect.provideContext(context),
        Effect.flatMap((complete) => Scope.close(scope, Exit.void).pipe(Effect.as(complete))),
        Effect.exit,
      ),
    ).then((exit) => {
      completed = true;
      return exit;
    });
    await finalizing.promise;
    req = httpRequest({ host: "127.0.0.1", port, path: "/shutdown-probe", agent: false }, (res) => {
      res.resume();
      res.on("end", () =>
        response.resolve({ status: res.statusCode ?? 0, connection: res.headers["connection"] }),
      );
    });
    req.on("error", response.reject);
    req.on("socket", (socket) => socket.once("close", () => closed.resolve()));
    req.end();
    // Wait for the actual parsed request, not connect/write callbacks: releasing the
    // finalizer before parsing lets server.close reap an idle socket and misses the race.
    await received.promise;
    expect(completed).toBe(false);
    release.resolve();
    const result = await Promise.race([
      Promise.all([closing, response.promise, closed.promise]),
      new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), 2_000))),
    ]);
    expect(result, "a late request must not strand listener closure").toBeDefined();
    if (result === undefined) return;
    const [exit, reply] = result;
    expect(reply).toEqual({ status: 503, connection: "close" });
    expect(Exit.isSuccess(exit)).toBe(true);
    const posted: unknown[] = [];
    expect(attestShutdown(exit, true, (message) => posted.push(message))).toBe(0);
    expect(posted).toEqual([{ type: "shutdownComplete", success: true }]);
  } finally {
    storeLayer.mockRestore();
    emitted.mockRestore();
    clearTimeout(timer);
    release.resolve();
    req?.destroy();
    await closing;
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

test("completes shutdown when a renderer never answers the WebSocket close frame", async () => {
  const scope = await Effect.runPromise(Scope.make());
  let socket: NetSocket | undefined;
  let closing: Promise<Exit.Exit<boolean, unknown>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const context = await Effect.runPromise(Layer.buildWithScope(TestServer, scope));
    const { port, token } = await Effect.runPromise(
      serverInfo.pipe(Effect.provideContext(context)),
    );
    const response = await Effect.runPromise(raw(port, { path: `/?boot=${token}` }));
    const cookie = response.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
    socket = await new Promise<NetSocket>((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port,
        path: "/ws",
        agent: false,
        headers: {
          cookie,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": randomBytes(16).toString("base64"),
        },
      });
      req.on("upgrade", (_res, connection) => {
        // A raw owned renderer consumes frames but deliberately sends no close acknowledgement.
        connection.on("data", () => {});
        connection.on("error", reject);
        resolve(connection);
      });
      req.on("error", reject);
      req.end();
    });
    const closed = new Promise<void>((resolve) => socket!.once("close", () => resolve()));
    closing = Effect.runPromise(
      stopForShutdown(() => {}).pipe(
        Effect.provideContext(context),
        Effect.flatMap((complete) => Scope.close(scope, Exit.void).pipe(Effect.as(complete))),
        Effect.exit,
      ),
    );
    const exit = await Promise.race([
      closing,
      new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), 2_000))),
    ]);
    expect(exit, "transport close must finish without a peer reply").toBeDefined();
    if (exit === undefined) return;
    expect(Exit.isSuccess(exit)).toBe(true);
    const posted: unknown[] = [];
    expect(attestShutdown(exit, true, (message) => posted.push(message))).toBe(0);
    expect(posted).toEqual([{ type: "shutdownComplete", success: true }]);
    await closed;
    expect(socket.destroyed).toBe(true);
  } finally {
    clearTimeout(timer);
    socket?.destroy();
    await closing;
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

layer(TestServer, { excludeTestServices: true })("server over a real socket", (it) => {
  it.effect("prints a parseable boot line", () =>
    Effect.gen(function* () {
      const { port, token } = yield* serverInfo;
      expect(port).toBeGreaterThan(0);
      expect(bootLine(port, token)).toMatch(
        /^boot http:\/\/127\.0\.0\.1:\d+\/\?boot=[0-9a-f]{64}$/,
      );
    }),
  );

  describe("auth", () => {
    it.effect("rejects a foreign Host or Origin with 403", () =>
      Effect.gen(function* () {
        const { port, token } = yield* serverInfo;
        const cookie = yield* bootCookie;
        const foreignHost = yield* raw(port, {
          path: `/?boot=${token}`,
          headers: { host: `attacker.example:${port}` },
        });
        expect(foreignHost.status).toBe(403);
        const foreignOrigin = yield* raw(port, {
          path: "/app.js",
          headers: { origin: "https://attacker.example", cookie },
        });
        expect(foreignOrigin.status).toBe(403);
        expect(yield* upgradeStatus(port, { origin: "https://attacker.example", cookie })).not.toBe(
          101,
        );
      }),
    );

    it.effect("exchanges the boot token for an HttpOnly, SameSite=Strict per-port cookie", () =>
      Effect.gen(function* () {
        const { port, token } = yield* serverInfo;
        const response = yield* raw(port, { path: `/?boot=${token}` });
        expect(response.status).toBe(302);
        expect(response.headers.location).toBe("/");
        const setCookie = response.headers["set-cookie"]?.[0] ?? "";
        expect(setCookie).toContain(`${tokenCookieName(port)}=${token}`);
        expect(setCookie).toMatch(/HttpOnly/i);
        expect(setCookie).toMatch(/SameSite=Strict/i);
        expect(setCookie).toMatch(/Path=\//i);
        expect(response.headers["content-security-policy"]).toContain(
          "script-src 'self' 'wasm-unsafe-eval';",
        );

        expect((yield* raw(port, { path: "/?boot=wrong" })).status).toBe(401);
      }),
    );

    it.effect("enforces the cookie on static assets and the WebSocket upgrade", () =>
      Effect.gen(function* () {
        const { port, token } = yield* serverInfo;
        const cookie = yield* bootCookie;
        expect((yield* raw(port, { path: "/app.js" })).status).toBe(401);
        expect((yield* raw(port, { path: "/app.js", headers: { cookie } })).status).toBe(200);

        expect(yield* upgradeStatus(port, {})).toBe(401);
        expect(
          yield* upgradeStatus(port, { cookie: `${tokenCookieName(port + 1)}=${token}` }),
        ).toBe(401);
        expect(yield* upgradeStatus(port, { cookie })).toBe(101);
      }),
    );

    it.effect("serves the SPA fallback with the CSP header", () =>
      Effect.gen(function* () {
        const { port } = yield* serverInfo;
        const cookie = yield* bootCookie;
        const response = yield* raw(port, {
          path: "/t/some-thread",
          headers: { cookie, accept: "text/html" },
        });
        expect(response.status).toBe(200);
        expect(response.body).toContain("<title>Gram</title>");
        expect(response.headers["content-security-policy"]).toContain(`ws://127.0.0.1:${port}`);
      }),
    );
  });

  describe("RPC", () => {
    it.effect("round-trips commands, typed errors and the event stream over /ws", () =>
      Effect.gen(function* () {
        const { port } = yield* serverInfo;
        const cookie = yield* bootCookie;
        const client = yield* makeClient(GramRpcs, port, cookie);

        // A fresh store reads as the defaults.
        expect(yield* client["settings.get"]()).toEqual(DEFAULT_SETTINGS);

        const thread = yield* client["thread.create"]({
          // thread.create checks the folder exists; the temp web root is a real one.
          projectRoot: webRoot,
          checkout: { kind: "current" },
          title: "over the wire",
        });
        expect(thread).toMatchObject({ title: "over the wire", userNamed: true });

        // `/add-dir`: a relative path is from the checkout, and a missing folder is refused.
        expect(yield* client["thread.addDirectory"]({ threadId: thread.id, path: "." })).toBe(
          resolvePath(webRoot),
        );
        const missing = yield* client["thread.addDirectory"]({
          threadId: thread.id,
          path: "no-such-folder",
        }).pipe(Effect.flip);
        expect(missing).toMatchObject({ _tag: "NotFound" });

        const [snapshot] = yield* client["events.subscribe"]().pipe(
          Stream.take(1),
          Stream.runCollect,
        );
        expect(snapshot).toMatchObject({ type: "threads.snapshot" });
        const ids =
          snapshot?.type === "threads.snapshot" ? snapshot.threads.map((t) => t.thread.id) : [];
        expect(ids).toContain(thread.id);

        const error = yield* client["thread.send"]({
          threadId: "missing" as ThreadId,
          input: { text: "hi" },
        }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "ThreadNotFound", threadId: "missing" });

        const feed = yield* client["thread.subscribe"]({ threadId: thread.id }).pipe(
          Stream.take(2),
          Stream.runCollect,
        );
        expect(feed).toEqual([
          { type: "messages", messages: [] },
          { type: "caughtUp", rev: 0 },
        ]);
        const resumed = yield* client["thread.subscribe"]({
          threadId: thread.id,
          afterRev: 0,
        }).pipe(Stream.take(2), Stream.runCollect);
        expect(resumed).toEqual([
          { type: "resumed", messages: [] },
          { type: "caughtUp", rev: 0 },
        ]);
      }),
    );
  });
});

/** Text a defect's message quotes, which must reach the client but never the log. */
const TRANSCRIPT = "the user's private transcript line";

const DefectRpcs = RpcGroup.make(
  Rpc.make("dies", { payload: { text: Schema.String } }),
  Rpc.make("throws", { payload: { text: Schema.String } }),
  Rpc.make("ticks", { success: Schema.Number, stream: true }),
  Rpc.make("throwsStreaming", { success: Schema.Number, stream: true }),
);

class Ticks extends Context.Service<Ticks, Queue.Queue<number>>()("test/Ticks") {
  static readonly layer = Layer.effect(Ticks, Queue.unbounded<number>());
}

const DefectHandlers = DefectRpcs.toLayer(
  Effect.gen(function* () {
    const ticks = yield* Ticks;
    return DefectRpcs.of(
      logDefects(DefectRpcs, {
        dies: ({ text }) =>
          Effect.die(Object.assign(new Error(`died on ${text}`), { name: `${text} error` })),
        throws: ({ text }): Effect.Effect<void> => {
          throw new Error(`threw on ${text}`);
        },
        ticks: () => Stream.fromQueue(ticks),
        throwsStreaming: (): Stream.Stream<number> => {
          throw new Error(`threw streaming on ${TRANSCRIPT}`);
        },
      }),
    );
  }),
);

const logLines: Array<string> = [];
const DefectServer = HttpRouter.serve(rpcRoutes(DefectRpcs, DefectHandlers), {
  disableListenLog: true,
  disableLogger: true,
}).pipe(
  Layer.provideMerge(Ticks.layer),
  Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
  Layer.provide(
    serverLogLayer({
      logger: pino(
        { level: "trace" },
        new Writable({
          write: (chunk: Buffer, _encoding, done) => {
            logLines.push(chunk.toString());
            done();
          },
        }),
      ),
      logDir: undefined,
      setLevel: () => Effect.void,
    }),
  ),
);

layer(DefectServer, { excludeTestServices: true })("a handler defect over a real socket", (it) => {
  it.effect("fails only its own request, and the socket's other streams keep flowing", () =>
    Effect.gen(function* () {
      const ticks = yield* Ticks;
      const client = yield* makeClient(DefectRpcs, serverPort(yield* HttpServer.HttpServer), "");
      const first = yield* Deferred.make<void>();
      const feed = yield* client.ticks().pipe(
        Stream.tap(() => Deferred.succeed(first, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Queue.offer(ticks, 1);
      yield* Deferred.await(first);

      const died = yield* client.dies({ text: TRANSCRIPT }).pipe(Effect.exit);
      const threw = yield* client.throws({ text: TRANSCRIPT }).pipe(Effect.exit);
      const threwStreaming = yield* client.throwsStreaming().pipe(Stream.runCollect, Effect.exit);
      yield* Queue.offer(ticks, 2);
      expect(yield* Fiber.join(feed)).toEqual([1, 2]);

      for (const [exit, verb] of [
        [died, "died"],
        [threw, "threw"],
        [threwStreaming, "threw streaming"],
      ] as ReadonlyArray<readonly [Exit.Exit<unknown, unknown>, string]>) {
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toMatchObject({ message: `${verb} on ${TRANSCRIPT}` });
        }
      }

      const log = logLines.join("");
      expect(log).toContain('"rpc":"dies"');
      expect(log).toContain('"rpc":"throws"');
      expect(log).toContain('"rpc":"throwsStreaming"');
      expect(log).not.toContain(TRANSCRIPT);
    }),
  );
});

layer(GuardedHttpPlatform)("file responses", (it) => {
  it.effect("can't kill the server when a file stream fails to open", () =>
    Effect.promise(async () => {
      // Unguarded, the stream's error has no listener and vitest fails the run as an uncaught one,
      // as Node killed the server on EMFILE.
      const missing = join(tmpdir(), `gram-missing-${randomBytes(6).toString("hex")}.js`);
      const stream = createReadStream(missing);
      expect(guardFileBody(HttpServerResponse.raw(stream)).body._tag).toBe("Raw");
      // A bare `close` listener, as `finished` or `events.once` would add an `'error'` one of their
      // own and pass without the guard.
      await new Promise<void>((done) => stream.once("close", () => done()));
      expect(stream.errored).toMatchObject({ code: "ENOENT" });
      await expect(finished(stream)).rejects.toMatchObject({ code: "ENOENT" });
    }),
  );

  it.effect("guards every file response the web root is served with", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-static-"));
      writeFileSync(join(dir, "gauge.js"), "export {};");
      const platform = yield* HttpPlatform.HttpPlatform;
      const response = yield* platform.fileResponse(join(dir, "gauge.js"));
      const stream = response.body._tag === "Raw" ? response.body.body : undefined;
      expect(stream).toBeInstanceOf(Readable);
      expect((stream as Readable).listenerCount("error")).toBeGreaterThan(0);
      (stream as Readable).destroy();
      rmSync(dir, { recursive: true, force: true });
    }),
  );
});

layer(testServer("https://device.tail123.ts.net:9443"), { excludeTestServices: true })(
  "private remote access over a real socket",
  (it) => {
    it.effect("refuses router aliases before WebSocket, MCP, pairing and boot routing", () =>
      Effect.gen(function* () {
        const { port, token } = yield* serverInfo;
        const origin = "https://device.tail123.ts.net:9443";
        const host = "device.tail123.ts.net:9443";
        const localCookie = yield* bootCookie;
        const mint = yield* raw(port, {
          path: "/remote/pair",
          method: "POST",
          headers: { cookie: localCookie, origin: `http://127.0.0.1:${port}` },
        });
        const link = new URL(JSON.parse(mint.body).url);
        const code = new URLSearchParams(link.hash.slice(1)).get("pair")!;
        const claimed = yield* raw(port, {
          path: "/remote/claim",
          method: "POST",
          body: code,
          headers: { host, origin, "content-type": "text/plain" },
        });
        const cookie = claimed.headers["set-cookie"]![0]!.split(";")[0]!;
        const nextMint = yield* raw(port, {
          path: "/remote/pair",
          method: "POST",
          headers: { cookie: localCookie, origin: `http://127.0.0.1:${port}` },
        });
        const nextCode = new URLSearchParams(
          new URL(JSON.parse(nextMint.body).url).hash.slice(1),
        ).get("pair")!;
        const observed: Record<"ws" | "mcp" | "pairing" | "boot" | "malformed", number[]> = {
          ws: [],
          mcp: [],
          pairing: [],
          boot: [],
          malformed: [],
        };
        for (const path of ["/ws/", "/WS", "/%77s", "//ws", "/ws;extra"]) {
          observed.ws.push(yield* upgradeStatus(port, { host, cookie }, path));
          observed.ws.push(
            yield* upgradeStatus(port, { host, cookie, origin: "https://evil.invalid" }, path),
          );
          observed.ws.push(yield* upgradeStatus(port, { host, cookie, origin }, path));
        }
        for (const path of ["/mcp/", "/MCP", "/%6dcp", "//mcp", "/mcp;extra"]) {
          observed.mcp.push(
            (yield* raw(port, { path, method: "POST", headers: { host, cookie, origin } })).status,
          );
          // The local launch cookie must not pass a differently spelled MCP route either.
          observed.mcp.push(
            (yield* raw(port, { path, method: "POST", headers: { cookie: localCookie } })).status,
          );
        }
        for (const endpoint of ["pair", "connect", "claim"]) {
          for (const path of [
            `/remote/${endpoint}/`,
            `/REMOTE/${endpoint.toUpperCase()}`,
            `/remote/%${endpoint.charCodeAt(0).toString(16)}${endpoint.slice(1)}`,
            `//remote/${endpoint}`,
            `/remote//${endpoint}`,
            `/remote/${endpoint};extra`,
          ]) {
            observed.pairing.push(
              (yield* raw(port, {
                path,
                method: endpoint === "connect" ? "GET" : "POST",
                ...(endpoint === "claim" ? { body: nextCode } : {}),
                headers: {
                  host,
                  origin,
                  ...(endpoint === "claim" ? {} : { cookie }),
                  "content-type": "text/plain",
                  accept: "text/html",
                },
              })).status,
            );
          }
        }
        for (const endpoint of ["pair", "connect", "claim"]) {
          for (const path of [
            `/REMOTE/${endpoint.toUpperCase()}`,
            `/remote/${endpoint}/`,
            `/remote/%${endpoint.charCodeAt(0).toString(16)}${endpoint.slice(1)}`,
          ]) {
            observed.pairing.push(
              (yield* raw(port, {
                path,
                method: "POST",
                headers: { cookie: localCookie, origin: `http://127.0.0.1:${port}` },
              })).status,
            );
          }
        }
        for (const path of ["/./", "/%2e/", "//", "/remote/../"]) {
          const response = yield* raw(port, { path: `${path}?boot=${token}` });
          observed.boot.push(response.status);
          expect(response.headers["set-cookie"]).toBeUndefined();
          const remoteBoot = yield* raw(port, {
            path: `${path}?%62oot=${token}`,
            headers: { host, cookie, origin },
          });
          observed.boot.push(remoteBoot.status);
          expect(remoteBoot.headers["set-cookie"]).toBeUndefined();
        }
        for (const path of [
          "/%",
          "/%GG",
          "/%C0%AFws",
          "/%E0%A4",
          "/app.js?x=%GG",
          "/ws?x=%C0%AF",
        ]) {
          observed.malformed.push(
            (yield* raw(port, { path, headers: { host, cookie, origin, accept: "text/html" } }))
              .status,
          );
        }
        expect(observed).toEqual(
          Object.fromEntries(
            Object.entries(observed).map(([key, statuses]) => [key, statuses.map(() => 403)]),
          ),
        );
        for (const path of [
          "/remote/pair",
          "/remote/connect",
          "/remote/claim",
          "/mcp",
          "/ws",
          "/",
        ]) {
          const response = yield* raw(port, {
            path: `${path}?%62oot=${token}`,
            headers: { host, cookie, origin },
          });
          expect(response.status).toBe(403);
          expect(response.headers["set-cookie"]).toBeUndefined();
        }
        // Aliased mint/claim requests cannot replace or consume a still-valid invitation.
        const nextClaim = yield* raw(port, {
          path: "/remote/claim",
          method: "POST",
          body: nextCode,
          headers: { host, origin, "content-type": "text/plain" },
        });
        expect(nextClaim.status).toBe(200);
        expect(nextClaim.headers["set-cookie"]?.[0]).toContain(remoteCookieName(port));
        expect(yield* upgradeStatus(port, { host, cookie })).toBe(403);
        expect(yield* upgradeStatus(port, { host, origin })).toBe(401);
        expect(yield* upgradeStatus(port, { host, cookie, origin })).toBe(101);
      }),
    );

    it.effect(
      "pairs once with a separate secure cookie and enforces static, WS, MCP and local mint boundaries",
      () =>
        Effect.gen(function* () {
          const { port, token } = yield* serverInfo;
          const localCookie = yield* bootCookie;
          const origin = "https://device.tail123.ts.net:9443";
          const host = "device.tail123.ts.net:9443";
          const localHeaders = { cookie: localCookie, origin: `http://127.0.0.1:${port}` };
          expect(
            (yield* raw(port, {
              path: "/remote/pair",
              method: "POST",
              headers: { origin: localHeaders.origin },
            })).status,
          ).toBe(401);
          expect(
            (yield* raw(port, {
              path: "/remote/pair",
              method: "POST",
              headers: { cookie: localCookie },
            })).status,
          ).toBe(403);
          expect(
            (yield* raw(port, {
              path: "/remote/pair",
              method: "POST",
              headers: { ...localHeaders, origin: "https://evil.invalid" },
            })).status,
          ).toBe(403);
          expect(
            (yield* raw(port, {
              path: "/remote/pair",
              method: "POST",
              headers: { ...localHeaders, "x-forwarded-host": `127.0.0.1:${port}` },
            })).status,
          ).toBe(403);
          expect(
            (yield* raw(port, {
              path: "/remote/connect",
              headers: { host, "tailscale-funnel-request": "?1" },
            })).status,
          ).toBe(403);
          const mint = yield* raw(port, {
            path: "/remote/pair",
            method: "POST",
            headers: localHeaders,
          });
          expect(mint.status).toBe(200);
          expect(mint.headers["cache-control"]).toBe("no-store");
          const link = new URL(JSON.parse(mint.body).url);
          expect(link.origin).toBe(origin);
          expect(link.search).toBe("");
          expect(link.href).not.toContain(token);
          const code = new URLSearchParams(link.hash.slice(1)).get("pair")!;
          const bridge = yield* raw(port, { path: link.pathname, headers: { host } });
          expect(bridge.status).toBe(200);
          expect(bridge.body).toContain("history.replaceState");
          expect(bridge.headers["referrer-policy"]).toBe("no-referrer");
          expect(bridge.headers["cache-control"]).toBe("no-store");
          expect(bridge.headers["content-security-policy"]).toContain("script-src 'sha256-");
          const claimOptions = {
            path: "/remote/claim",
            method: "POST",
            headers: { host, origin, "content-type": "text/plain" },
            body: code,
          };
          expect(
            (yield* raw(port, { ...claimOptions, headers: { host, "content-type": "text/plain" } }))
              .status,
          ).toBe(403);
          expect((yield* raw(port, { ...claimOptions, body: "x".repeat(65) })).status).toBe(403);
          const claimed = yield* raw(port, claimOptions);
          expect(claimed.status).toBe(200);
          const setCookie = claimed.headers["set-cookie"]?.[0] ?? "";
          expect(setCookie).toContain(remoteCookieName(port));
          for (const flag of [
            /Secure/i,
            /HttpOnly/i,
            /SameSite=Strict/i,
            /Path=\//i,
            /Max-Age=31536000/i,
          ])
            expect(setCookie).toMatch(flag);
          expect(setCookie).not.toContain(token);
          expect((yield* raw(port, claimOptions)).status).toBe(403);
          const cookie = setCookie.split(";")[0]!;
          expect((yield* raw(port, { headers: { host, cookie: localCookie } })).status).toBe(401);
          expect((yield* raw(port, { headers: { cookie } })).status).toBe(401);
          const app = yield* raw(port, {
            path: "/t/synthetic",
            headers: { host, cookie, accept: "text/html" },
          });
          expect(app.status).toBe(200);
          expect(app.headers["content-security-policy"]).toContain(`wss://${host}`);
          expect((yield* raw(port, { path: "/app.js", headers: { host } })).status).toBe(401);
          expect((yield* raw(port, { path: "/app.js", headers: { host, cookie } })).status).toBe(
            200,
          );
          expect(yield* upgradeStatus(port, { host, origin })).toBe(401);
          expect(yield* upgradeStatus(port, { host, cookie, origin: "https://evil.invalid" })).toBe(
            403,
          );
          expect(yield* upgradeStatus(port, { host, cookie, origin })).toBe(101);
          for (const path of ["/remote/pair", "/mcp", `/?boot=${token}`])
            expect((yield* raw(port, { path, headers: { host, cookie, origin } })).status).toBe(
              403,
            );
          expect(
            (yield* raw(port, {
              headers: {
                host: "evil.invalid",
                cookie,
                "x-forwarded-host": host,
                "x-forwarded-proto": "https",
                origin,
              },
            })).status,
          ).toBe(403);
        }),
    );
  },
);
