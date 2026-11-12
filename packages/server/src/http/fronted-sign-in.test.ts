// The acceptance test for sign-in through a fronting proxy: a whole server over a real socket,
// with a synthetic proxy's key. Forged and missing identities are refused, two people's actions
// are told apart in the record, a viewer changes nothing, and with the hosted features setting off
// the same server takes the launch token as it always has.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, layer } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  GramRpcs,
  PROFILE_START_PATH,
  RequestId,
  WorkspaceId,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ServerConfig } from "../config.ts";
import { gitPlatformTest } from "../git/platform.ts";
import { makeRepo, removeDir } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { HttpServer, RpcClient, RpcSerialization, Socket } from "../platform/unstable.ts";
import { NO_ACTOR_REFUSAL, VIEWER_REFUSAL } from "../rpc/actor-guard.ts";
import { NOT_YOUR_MACHINE, OWNERS_DIFFER, RoutedFor } from "../host/ownership.ts";
import { Orchestration } from "../orchestration/service.ts";
import { RemoteHosts } from "../host/remote-hosts.ts";
import { ANSWER_OVER_HTTP, ASK_ANSWER_PATH } from "../embedding/ask-answer.ts";
import { ON_DEMAND_START_PATH, ON_DEMAND_STATUS_PATH } from "../embedding/on-demand.ts";
import { makeFakeAgentAdapter } from "../runtime/fake-agent.ts";
import { TurnHooks } from "../runtime/hooks.ts";
import { TEST_CONFIG, waitFor } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { ACTOR_HEADER, actorHeadersForTests } from "./actor.ts";
import { tokenCookieName } from "./auth.ts";
import { SERVICE_TYP, IDENTITY_HEADER } from "./fronted-identity.ts";
import { makeTestProxy } from "./fronted-identity.testing.ts";
import { LOCAL_APP_HEADER } from "./local-app.ts";
import { generateHostKey, HOST_MCP_PATH } from "../host/machine-keys.ts";
import { HOST_PATHS, MACHINES_LIST_PATH } from "./machine-routes.ts";
import { REMOTE_STATUS_PATH } from "./remote-access.ts";
import { WORKSPACE_TRANSFER_PATHS } from "../transfer/routes.ts";
import { LaunchToken, serverPort, ServerLayer } from "./server.ts";

const proxy = makeTestProxy();

const PROFILE_THREAD = "6b1d2a90-3c4e-4f5a-8b6c-7d8e9f0a1b2c";
const OTHER_PROFILE_THREAD = "6b1d2a90-3c4e-4f5a-8b6c-7d8e9f0a1b2d";

/** The event sink's receiver: every event the server sends it, in order. */
const sunk: Array<{ type: string; data: Record<string, unknown> }> = [];
const sinkPort = await new Promise<number>((resolve) => {
  const receiver = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    req.on("end", () => {
      const batch = JSON.parse(text) as { events: Array<{ seq: number } & (typeof sunk)[number]> };
      for (const event of batch.events) if (event.seq === sunk.length + 1) sunk.push(event);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ack: sunk.length }));
    });
  });
  receiver.unref();
  receiver.listen(0, "127.0.0.1", () => resolve((receiver.address() as { port: number }).port));
});

/** Each server's own data folder, removed when the file's tests end. */
const dataDirs: string[] = [];

/** A host provider: every start or stop the server asks of it, in order. */
const provided: Array<{ path: string; body: Record<string, unknown> }> = [];
const providerPort = await new Promise<number>((resolve) => {
  const receiver = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    req.on("end", () => {
      provided.push({ path: req.url ?? "", body: JSON.parse(text) as Record<string, unknown> });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ hostKey: "personal:ws:user-ada" }));
    });
  });
  receiver.unref();
  receiver.listen(0, "127.0.0.1", () => resolve((receiver.address() as { port: number }).port));
});

const server = (embedding: boolean, socketLifetimeMs?: number, onDemand = false) => {
  const dataDir = mkdtempSync(join(tmpdir(), "gram-fronted-data-"));
  dataDirs.push(dataDir);
  return ServerLayer.pipe(
    Layer.provideMerge(makeFakeAgentAdapter({ reply: "echo" })),
    Layer.provide(TurnHooks.layerNoop),
    Layer.provide(gitPlatformTest()),
    Layer.provide(
      ServerConfig.layer({
        ...TEST_CONFIG,
        // A start from a profile writes the thread's folder under the data folder, so it must be
        // one this user can write: the shared test path isn't on CI's runners.
        dataDir,
        frontedIdentity: {
          ...proxy.config,
          ...(socketLifetimeMs === undefined ? {} : { socketLifetimeMs }),
        },
        embedding,
        eventSink: { url: `http://127.0.0.1:${sinkPort}/events` },
        ...(onDemand
          ? {
              embed: {
                repoEvents: "poll" as const,
                inboundToken: "i".repeat(40),
                hostProvider: { url: `http://127.0.0.1:${providerPort}`, token: "p".repeat(40) },
              },
            }
          : {}),
      }),
    ),
    Layer.orDie,
  );
};

const info = Effect.gen(function* () {
  const { token } = yield* LaunchToken;
  return { port: serverPort(yield* HttpServer.HttpServer), token };
});

/** A plain request to the server, as the proxy (or anyone who reached the port) would send it. */
const get = (port: number, path: string, headers: Record<string, string> = {}) =>
  Effect.promise(
    () =>
      new Promise<{ status: number; body: string; setCookie: string }>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, path, headers, agent: false }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body,
              setCookie: res.headers["set-cookie"]?.[0] ?? "",
            }),
          );
        });
        req.on("error", reject);
        req.end();
      }),
  );

/** A POST of `body`, as the proxy would pass it on. */
const post = (port: number, path: string, body: string, headers: Record<string, string> = {}) =>
  Effect.promise(
    () =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path,
            method: "POST",
            agent: false,
            headers: {
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(body)),
              ...headers,
            },
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => (text += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
          },
        );
        req.on("error", reject);
        req.end(body);
      }),
  );

/** The status a WebSocket upgrade of `/ws` gets: 101 when accepted. */
const upgrade = (port: number, headers: Record<string, string>) =>
  Effect.promise(
    () =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest({
          host: "127.0.0.1",
          port,
          path: "/ws",
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

/** An RPC client whose connection carries `headers`, living in the caller's scope. */
const client = (port: number, headers: Record<string, string>) =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/ws`)),
        Layer.provide(
          Layer.succeed(Socket.WebSocketConstructor)(
            (url) =>
              new (globalThis.WebSocket as unknown as new (
                url: string,
                init: { headers: Record<string, string> },
              ) => globalThis.WebSocket)(url, { headers }),
          ),
        ),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
    return yield* RpcClient.make(GramRpcs).pipe(Effect.provideContext(protocol));
  });

/** The client of a person the proxy signed in. */
const as = (port: number, claims: Record<string, unknown>) =>
  client(port, { [IDENTITY_HEADER]: proxy.statement(claims) });

/** Why a call was refused outright, as the server said it. */
const refusal = <A, E, R>(call: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(call), (exit) =>
    Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "the call went through",
  );

/** A folder of its own for a thread, removed when the file's tests end. */
const lineageFolder = (dirs: Array<string>) => {
  const made = mkdtempSync(join(tmpdir(), "gram-fronted-lineage-"));
  dirs.push(made);
  return made;
};

const ada = { sub: "user-ada", name: "Ada", role: "member" };
const grace = { sub: "user-grace", name: "Grace", role: "member" };
const vera = { sub: "user-vera", name: "Vera", role: "viewer" };

describe("sign-in through a fronting proxy", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of [...dirs, ...dataDirs]) removeDir(dir);
  });

  layer(server(true), { excludeTestServices: true })("with the hosted features on", (it) => {
    it.effect("refuses a missing or forged identity, the launch token included", () =>
      Effect.gen(function* () {
        const { port, token } = yield* info;
        const signedIn = { [IDENTITY_HEADER]: proxy.statement() };
        // The proxy's statement is the way in. No web root here: 404 is the app's own answer.
        expect((yield* get(port, "/", signedIn)).status).toBe(404);
        expect(yield* upgrade(port, signedIn)).toBe(101);

        // Nothing at all, on a loopback Host as the local app would send.
        const host = { host: `127.0.0.1:${port}` };
        const missing = yield* get(port, "/", host);
        expect(missing).toMatchObject({
          status: 401,
          body: "unauthorized: signed identity required",
        });
        expect(yield* upgrade(port, host)).toBe(401);

        // The launch token signs nobody in: no cookie for the boot address, none taken either.
        const boot = yield* get(port, `/?boot=${token}`, host);
        expect(boot).toMatchObject({ status: 401, setCookie: "" });
        const cookie = { ...host, cookie: `${tokenCookieName(port)}=${token}` };
        expect((yield* get(port, "/", cookie)).status).toBe(401);
        expect(yield* upgrade(port, cookie)).toBe(401);

        // Forged: another key, another server's statement, an expired one, a made-up header, and
        // the headers this server writes for itself.
        const stranger = makeTestProxy();
        const past = Math.floor(Date.now() / 1000) - 3600;
        const forgeries = [
          stranger.statement(),
          proxy.statement({ aud: "another-gram" }),
          proxy.statement({ iat: past, exp: past + 60 }),
          proxy.statement({ role: "owner" }),
          proxy.statement().replace(/\.[^.]+$/, `.${"A".repeat(86)}`),
          "user-ada",
        ];
        for (const forged of forgeries) {
          const headers = { [IDENTITY_HEADER]: forged };
          expect((yield* get(port, "/", headers)).status).toBe(401);
          expect(yield* upgrade(port, headers)).toBe(401);
        }
        const selfMade = {
          ...actorHeadersForTests({ id: "user-ada", name: "Ada", role: "member" }),
          [LOCAL_APP_HEADER]: "0".repeat(64),
        };
        expect(yield* upgrade(port, selfMade)).toBe(401);

        // A page on another origin can't ride a signed-in browser.
        const foreign = { ...signedIn, origin: "https://elsewhere.example.test" };
        expect((yield* get(port, "/", foreign)).status).toBe(403);
        expect(yield* upgrade(port, foreign)).toBe(403);
        expect(yield* upgrade(port, { ...signedIn, origin: proxy.config.origin })).toBe(101);

        // Phone access and joining machines are the local sign-in's, which isn't here.
        for (const path of [REMOTE_STATUS_PATH, MACHINES_LIST_PATH, ...WORKSPACE_TRANSFER_PATHS])
          expect((yield* get(port, path, signedIn)).status).toBe(403);

        // The platform's own statement reaches a workspace's way in and out, and no person's
        // page or socket.
        const platform = (path: string) => ({
          ...host,
          origin: proxy.config.origin,
          [IDENTITY_HEADER]: proxy.statement(
            { sub: "platform", role: "service", path },
            { header: { typ: SERVICE_TYP } },
          ),
        });
        for (const path of WORKSPACE_TRANSFER_PATHS)
          expect(yield* get(port, path, platform(path))).toMatchObject({
            status: 405,
            body: "method not allowed",
          });
        expect(yield* get(port, "/", platform("/"))).toMatchObject({
          status: 403,
          body: "forbidden: not for a service",
        });
        expect(yield* upgrade(port, platform("/ws"))).toBe(403);
        expect((yield* get(port, "/mcp", platform("/mcp"))).status).toBe(403);
        // A statement made for one path opens no other, and none without the public origin.
        const [exportPath, importPath] = [...WORKSPACE_TRANSFER_PATHS] as [string, string];
        expect((yield* get(port, importPath, platform(exportPath))).status).toBe(403);
        const { origin: _, ...originless } = platform(exportPath);
        expect((yield* get(port, exportPath, originless)).status).toBe(403);

        // It starts a thread from a profile, once for one id however often it asks, and only
        // on a machine that is there; a person is never let through to that path.
        const startBody = (extra: Record<string, unknown> = {}) =>
          JSON.stringify({
            profile: {
              version: 1,
              agent: "claude",
              charter: "Synthetic charter.",
              model: { model: "fake-model" },
              connectors: {},
              workplace: { kind: "scratch" },
            },
            threadId: PROFILE_THREAD,
            ...extra,
          });
        const started = yield* post(
          port,
          PROFILE_START_PATH,
          startBody(),
          platform(PROFILE_START_PATH),
        );
        expect(started.status, started.body).toBe(200);
        expect(JSON.parse(started.body)).toEqual({ threadId: PROFILE_THREAD, created: true });
        const again = yield* post(
          port,
          PROFILE_START_PATH,
          startBody(),
          platform(PROFILE_START_PATH),
        );
        expect(JSON.parse(again.body)).toEqual({ threadId: PROFILE_THREAD, created: false });
        // Each call is on the record with the thread it made or found.
        const recorded = (yield* (yield* ThreadStore).listActorEvents()).filter(
          (event) => event.action === PROFILE_START_PATH,
        );
        expect(recorded.map((event) => event.data)).toEqual([
          { status: 200, threadId: PROFILE_THREAD, created: true },
          { status: 200, threadId: PROFILE_THREAD, created: false },
        ]);
        // Asked again for a machine it isn't on, it says so rather than answer as if it were.
        const moved = yield* post(
          port,
          PROFILE_START_PATH,
          startBody({ hostId: "machine-elsewhere" }),
          platform(PROFILE_START_PATH),
        );
        expect(moved.status).toBe(409);
        // An alias of the path is no way around the checks above.
        expect(
          (yield* post(port, `${PROFILE_START_PATH}/`, startBody(), { ...host, ...signedIn }))
            .status,
        ).toBeGreaterThanOrEqual(400);
        const elsewhere = yield* post(
          port,
          PROFILE_START_PATH,
          startBody({ threadId: OTHER_PROFILE_THREAD, hostId: "machine-nowhere" }),
          platform(PROFILE_START_PATH),
        );
        expect(elsewhere.status).toBe(409);
        const extraKey = yield* post(
          port,
          PROFILE_START_PATH,
          startBody({ threadId: OTHER_PROFILE_THREAD, sudo: true }),
          platform(PROFILE_START_PATH),
        );
        expect(extraKey.status).toBe(400);
        expect(
          (yield* post(port, PROFILE_START_PATH, startBody(), { ...host, ...signedIn })).status,
        ).toBe(403);
        expect(
          (yield* post(port, PROFILE_START_PATH, startBody(), platform(MACHINES_LIST_PATH))).status,
        ).toBe(403);

        // A thread's agent on this machine still needs its own token for its app tools.
        const mcp = yield* get(port, "/mcp", { ...host, authorization: "Bearer nope" });
        expect(mcp).toMatchObject({ status: 401, body: "unauthorized: invalid bearer token" });
        // And a person is never let through to them, or to a joined machine's routes.
        for (const path of ["/mcp", HOST_MCP_PATH, ...HOST_PATHS])
          expect(
            (yield* get(port, path, { ...signedIn, authorization: "Bearer nope" })).status,
          ).toBe(403);
        expect((yield* get(port, "/mcp", { [IDENTITY_HEADER]: "forged" })).status).toBe(401);
      }),
    );

    it.effect("records two people's actions apart, and lets a viewer only read", () =>
      Effect.gen(function* () {
        const { port } = yield* info;
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;
        const folder = mkdtempSync(join(tmpdir(), "gram-fronted-"));
        dirs.push(folder);
        const before = (yield* store.listActorEvents()).at(-1)?.seq ?? 0;

        const adaClient = yield* as(port, ada);
        const graceClient = yield* as(port, grace);
        const veraClient = yield* as(port, vera);

        // Ada starts a thread and sends a message.
        const thread = yield* adaClient["thread.create"]({
          projectRoot: folder,
          checkout: { kind: "current" },
        });
        const threadId = thread.id;
        yield* waitFor(
          "the session",
          runtimes.session(threadId).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        );
        yield* adaClient["thread.send"]({
          threadId,
          input: { text: "hello from Ada" },
          clientMessageId: "ada-1",
        });
        yield* waitFor(
          "Ada's turn to end",
          runtimes.status(threadId).pipe(Effect.map((status) => status === "idle")),
        );

        // Grace sends one that makes the agent ask, and Ada answers it.
        yield* graceClient["thread.send"]({
          threadId,
          input: { text: "/approve please" },
          clientMessageId: "grace-1",
        });
        const request = yield* waitFor(
          "the approval",
          Effect.map(store.listRequests(threadId), (requests) => requests[0]),
        );
        // Over the socket an answer is refused: the proxy can't sign one message on it.
        const answer = { kind: "approval", decision: "allow", scope: "once" } as const;
        expect(
          yield* refusal(adaClient["thread.respond"]({ threadId, requestId: request.id, answer })),
        ).toContain(ANSWER_OVER_HTTP);
        expect(
          yield* refusal(
            adaClient["thread.respondMany"]({
              answers: [{ threadId, requestId: request.id, answer }],
            }),
          ),
        ).toContain(ANSWER_OVER_HTTP);
        // As its own request it is taken, and what the proxy signed for it reaches the sink.
        const answerBody = JSON.stringify({ threadId, requestId: request.id, answer });
        const adaStatement = proxy.statement(ada);
        expect(
          yield* post(port, ASK_ANSWER_PATH, answerBody, { [IDENTITY_HEADER]: adaStatement }),
        ).toMatchObject({ status: 200 });
        const resolved = yield* waitFor(
          "the answer at the sink",
          Effect.sync(() =>
            sunk.find((event) => event.type === "ask.resolved" && event.data["id"] === request.id),
          ),
        );
        expect(resolved.data).toEqual({
          id: request.id,
          how: "answered",
          decision: "approve",
          answeredBy: "user-ada",
          proof: {
            statement: adaStatement,
            method: "POST",
            path: ASK_ANSWER_PATH,
            body: answerBody,
          },
        });
        // And Grace changes a setting.
        yield* graceClient["settings.set"]({ patch: { logLevel: "debug" } });
        // A change that fails on the way is on record as hers too.
        const missing = yield* post(
          port,
          ASK_ANSWER_PATH,
          JSON.stringify({
            threadId,
            requestId: RequestId.make("no-such-request"),
            answer: { kind: "approval", decision: "deny", scope: "once" },
          }),
          { [IDENTITY_HEADER]: proxy.statement(grace) },
        );
        expect(missing.status).toBe(404);

        // Vera reads what the others see, and changes nothing.
        expect((yield* veraClient["settings.get"]()).logLevel).toBe("debug");
        expect((yield* veraClient["workspace.list"]()).length).toBeGreaterThanOrEqual(0);
        const send = {
          threadId,
          input: { text: "hello from Vera" },
          clientMessageId: "vera-1",
        };
        expect(yield* refusal(veraClient["thread.send"](send))).toContain(VIEWER_REFUSAL);
        expect(
          yield* refusal(veraClient["settings.set"]({ patch: { logLevel: "info" } })),
        ).toContain(VIEWER_REFUSAL);
        expect(
          yield* refusal(
            veraClient["thread.respond"]({
              threadId,
              requestId: request.id,
              answer: { kind: "approval", decision: "deny", scope: "once" },
            }),
          ),
        ).toContain(VIEWER_REFUSAL);
        const veraAnswer = yield* post(
          port,
          ASK_ANSWER_PATH,
          JSON.stringify({
            threadId,
            requestId: request.id,
            answer: { kind: "approval", decision: "deny", scope: "once" },
          }),
          { [IDENTITY_HEADER]: proxy.statement(vera) },
        );
        expect(veraAnswer.status).toBe(403);
        // And nobody answers without a statement of their own.
        expect((yield* post(port, ASK_ANSWER_PATH, "{}")).status).toBe(401);
        expect(yield* refusal(veraClient["terminal.list"]({ threadId }))).toContain(VIEWER_REFUSAL);
        // Nor run anything in a folder of her choosing, which git's own configuration would.
        expect(yield* refusal(veraClient["worktree.status"]({ path: folder }))).toContain(
          VIEWER_REFUSAL,
        );
        expect(yield* refusal(veraClient["git.branches"]({ repoPath: folder }))).toContain(
          VIEWER_REFUSAL,
        );
        expect(yield* refusal(veraClient["thread.suggestions"]({ threadId }))).toContain(
          VIEWER_REFUSAL,
        );
        // Nor by naming herself a member on a message: a header she can write, a seal she can't.
        const [body] = actorHeadersForTests({ id: "user-vera", name: "Vera", role: "member" })[
          ACTOR_HEADER
        ]!.split(".");
        expect(
          yield* refusal(
            veraClient["thread.send"](send, {
              headers: { [ACTOR_HEADER]: `${body}.${"A".repeat(43)}` },
            }),
          ),
        ).toContain(NO_ACTOR_REFUSAL);
        expect((yield* store.getSettings).logLevel).toBe("debug");

        const events = (yield* store.listActorEvents({ afterSeq: before })).map((event) => ({
          who: event.actor.id,
          name: event.actor.name,
          action: event.action,
          threadId: event.threadId,
          data: event.data,
        }));
        expect(events).toEqual([
          { who: "user-ada", name: "Ada", action: "thread.create", threadId, data: {} },
          {
            who: "user-ada",
            name: "Ada",
            action: "thread.send",
            threadId,
            data: { clientMessageId: "ada-1" },
          },
          {
            who: "user-grace",
            name: "Grace",
            action: "thread.send",
            threadId,
            data: { clientMessageId: "grace-1" },
          },
          {
            who: "user-ada",
            name: "Ada",
            action: "thread.respond",
            threadId,
            data: {
              requestId: request.id,
              answer: { kind: "approval", decision: "allow", scope: "once" },
            },
          },
          {
            who: "user-grace",
            name: "Grace",
            action: "settings.set",
            threadId: undefined,
            data: { settings: ["logLevel"] },
          },
          {
            who: "user-grace",
            name: "Grace",
            action: "thread.respond",
            threadId,
            data: {
              requestId: "no-such-request",
              answer: { kind: "approval", decision: "deny", scope: "once" },
              failed: true,
            },
          },
        ]);
        // Nothing of Vera's reached the thread.
        const said = JSON.stringify(yield* store.listMessages(threadId));
        expect(said).toContain("hello from Ada");
        expect(said).not.toContain("hello from Vera");
      }),
    );
  });

  layer(server(true, 300), { excludeTestServices: true })("with a short socket lifetime", (it) => {
    it.effect("closes a socket after a while, so the proxy says again who it is", () =>
      Effect.gen(function* () {
        const { port } = yield* info;
        const closedAfter = yield* Effect.promise(
          () =>
            new Promise<number>((resolve, reject) => {
              const opened = Date.now();
              const socket = new (globalThis.WebSocket as unknown as new (
                url: string,
                init: { headers: Record<string, string> },
              ) => globalThis.WebSocket)(`ws://127.0.0.1:${port}/ws`, {
                headers: { [IDENTITY_HEADER]: proxy.statement() },
              });
              socket.addEventListener("close", () => resolve(Date.now() - opened), { once: true });
              socket.addEventListener("error", () => reject(new Error("socket failed")), {
                once: true,
              });
            }),
        );
        expect(closedAfter).toBeGreaterThanOrEqual(250);
        expect(closedAfter).toBeLessThan(5_000);
      }),
    );
  });

  layer(server(true, undefined, true), { excludeTestServices: true })(
    "with hosts provisioned on demand",
    (it) => {
      it.effect(
        "asks the provider for a person's machine with the proxy's proof, and never for a viewer",
        () =>
          Effect.gen(function* () {
            const { port } = yield* info;
            provided.length = 0;
            const body = JSON.stringify({ repositories: ["acme/web"] });
            const adaStatement = proxy.statement(ada);
            const started = yield* post(port, ON_DEMAND_START_PATH, body, {
              [IDENTITY_HEADER]: adaStatement,
            });
            expect(started.status).toBe(202);
            expect(provided).toEqual([
              {
                path: "/hosts/start",
                body: {
                  kind: "personal",
                  owner: "user-ada",
                  options: { repositories: ["acme/web"] },
                  proof: {
                    statement: adaStatement,
                    method: "POST",
                    path: ON_DEMAND_START_PATH,
                    body,
                  },
                },
              },
            ]);
            // Her status shows the start; Grace's shows nothing of hers.
            const mine = yield* get(port, ON_DEMAND_STATUS_PATH, {
              [IDENTITY_HEADER]: proxy.statement(ada),
            });
            expect(JSON.parse(mine.body)).toMatchObject({
              available: true,
              progress: { hostKey: "personal:ws:user-ada", phase: "starting" },
            });
            const hers = yield* get(port, ON_DEMAND_STATUS_PATH, {
              [IDENTITY_HEADER]: proxy.statement(grace),
            });
            expect(JSON.parse(hers.body)).toEqual({ available: true });
            // A viewer can't, and nobody unsigned can: the provider is asked nothing more.
            expect(
              (yield* post(port, ON_DEMAND_START_PATH, "{}", {
                [IDENTITY_HEADER]: proxy.statement(vera),
              })).status,
            ).toBe(403);
            expect((yield* post(port, ON_DEMAND_START_PATH, "{}")).status).toBe(401);
            expect(provided).toHaveLength(1);
          }),
      );

      // The review's case: Ada knows the id of Grace's machine and of a thread on it.
      it.effect("keeps every route onto a person's machine to them, and lets others read", () =>
        Effect.gen(function* () {
          const { port } = yield* info;
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          // Provided by the server layer, which doesn't name it among what it gives.
          const remote = Option.getOrThrow(yield* Effect.serviceOption(RemoteHosts));
          const folder = mkdtempSync(join(tmpdir(), "gram-fronted-own-"));
          dirs.push(folder);
          const provisioned = remote.machines.provision({
            name: "grace-box",
            platform: "linux",
            publicKey: generateHostKey().publicKey,
            owner: grace.sub,
            onDemand: "personal",
          });
          if (provisioned.kind !== "provisioned") throw new Error("not provisioned");
          const hostId = provisioned.machine.id;
          const graceClient = yield* as(port, grace);
          const adaClient = yield* as(port, ada);
          const created = yield* graceClient["thread.create"]({
            projectRoot: folder,
            checkout: { kind: "current" },
          });
          const threadId = created.id;
          yield* waitFor(
            "the session",
            runtimes.session(threadId).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            ),
          );
          // Her thread, as it is once placed on her machine.
          yield* store.updateThread(threadId, (thread) => ({
            ...thread,
            checkout: { ...thread.checkout, hostId },
          }));
          const send = { threadId, input: { text: "from Ada" }, clientMessageId: "own-1" };
          const tries = {
            send: adaClient["thread.send"](send),
            fork: adaClient["thread.fork"]({ threadId, fromMessageId: "m-0" as never }),
            restart: adaClient["thread.restartSession"]({ threadId }),
            threadTerminal: adaClient["terminal.open"]({ threadId, cols: 80, rows: 24 }),
            signIn: adaClient["terminal.open"]({ signIn: hostId, cols: 80, rows: 24 }),
          };
          for (const [name, call] of Object.entries(tries))
            expect([name, yield* refusal(call as Effect.Effect<unknown, unknown>)]).toEqual([
              name,
              expect.stringContaining(NOT_YOUR_MACHINE),
            ]);
          // What the workspace shows of it is still a read for anyone.
          expect(yield* refusal(adaClient["thread.listWaits"]({ threadId }))).toBe(
            "the call went through",
          );
          // Grace gets past the owner's check: her machine is just not online here.
          for (const call of [
            graceClient["terminal.open"]({ signIn: hostId, cols: 80, rows: 24 }),
            graceClient["thread.fork"]({ threadId, fromMessageId: "m-0" as never }),
          ] as ReadonlyArray<Effect.Effect<unknown, unknown>>)
            expect(yield* refusal(call)).not.toContain(NOT_YOUR_MACHINE);
          expect(
            yield* refusal(graceClient["thread.send"]({ ...send, clientMessageId: "own-2" })),
          ).toBe("the call went through");
        }),
      );

      // The re-review's cases: a join that would hand Ada's thread Grace's lineage, a task for
      // Grace's workspace, an answer over HTTP, and a worker on a shared machine under Grace.
      it.effect("keeps a person's orchestrator, its workers and its answers to them", () =>
        Effect.gen(function* () {
          const { port } = yield* info;
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const remote = Option.getOrThrow(yield* Effect.serviceOption(RemoteHosts));
          const orchestration = Option.getOrThrow(yield* Effect.serviceOption(Orchestration));
          const provisioned = remote.machines.provision({
            name: "grace-box-2",
            platform: "linux",
            publicKey: generateHostKey().publicKey,
            owner: grace.sub,
            onDemand: "personal",
          });
          if (provisioned.kind !== "provisioned") throw new Error("not provisioned");
          const hostId = provisioned.machine.id;
          const graceClient = yield* as(port, grace);
          const adaClient = yield* as(port, ada);
          const opened = (root: string, person: typeof graceClient, branch?: string) =>
            Effect.gen(function* () {
              const created = yield* person["thread.create"]({
                projectRoot: root,
                checkout:
                  branch === undefined ? { kind: "current" } : { kind: "newWorktree", branch },
              });
              yield* waitFor(
                "the session",
                runtimes.session(created.id).pipe(
                  Effect.as(true),
                  Effect.orElseSucceed(() => false),
                ),
              );
              return created;
            });
          // Grace's orchestrator, running on her machine, and her workspace.
          const orchestrator = yield* opened(lineageFolder(dirs), graceClient);
          const workspaceId = WorkspaceId.make("w-grace");
          yield* store.updateThread(orchestrator.id, (thread) => ({
            ...thread,
            role: "orchestrator",
            workspaceId,
            checkout: { ...thread.checkout, hostId },
          }));
          yield* store.putWorkspace({
            workspace: {
              id: workspaceId,
              name: "Grace's",
              projectIds: [orchestrator.projectId],
              homeProjectId: orchestrator.projectId,
              orchestratorThreadId: orchestrator.id,
              createdAt: 1,
            },
            charter: DEFAULT_CHARTER,
          });
          // Her worker, on her machine too: an orchestration has one owner (`host/ownership.ts`).
          const worker = yield* opened(lineageFolder(dirs), graceClient);
          yield* store.updateThread(worker.id, (thread) => ({
            ...thread,
            workspaceId,
            spawnedBy: { threadId: orchestrator.id, feature: "hers" },
            checkout: { ...thread.checkout, hostId },
          }));
          // Ada's own thread, on no one's machine, in a repository of hers: a thread that can join.
          const own = yield* opened(makeRepo(lineageFolder(dirs)), adaClient, "ada-work");
          const before = (yield* store.listMessages(orchestrator.id)).length;

          const tries = {
            join: adaClient["thread.joinWorkspace"]({
              threadId: own.id,
              workspaceId,
              feature: "ada",
              addRepos: true,
            }),
            taskByWorkspace: adaClient["workspace.startTask"]({
              target: { workspaceId },
              input: { text: "Ada's instructions" },
            }),
            taskByProject: adaClient["workspace.startTask"]({
              target: { projectId: orchestrator.projectId },
              input: { text: "Ada's instructions" },
            }),
            workerSend: adaClient["thread.send"]({
              threadId: worker.id,
              input: { text: "Ada's instructions" },
              clientMessageId: "lineage-1",
            }),
          };
          for (const [name, call] of Object.entries(tries))
            expect([name, yield* refusal(call as Effect.Effect<unknown, unknown>)]).toEqual([
              name,
              expect.stringContaining(NOT_YOUR_MACHINE),
            ]);
          // A join an agent of Ada's thread asks for, where no RPC is: a thread on no one's machine
          // never joins a person's orchestration, whoever asks.
          const joined = yield* orchestration
            .joinWorkspace(own.id, workspaceId, { feature: "ada", addRepos: true })
            .pipe(Effect.provideService(RoutedFor, { person: undefined }), Effect.flip);
          expect(joined.message).toContain(OWNERS_DIFFER);
          expect((yield* store.getThread(own.id)).spawnedBy).toBeUndefined();
          // Nothing of Ada's reached the orchestrator.
          expect((yield* store.listMessages(orchestrator.id)).length).toBe(before);

          // An answer over HTTP, of any kind, refused before the request is looked up.
          for (const answer of [
            { kind: "approval", decision: "allow", scope: "once" },
            { kind: "approval", decision: "deny", scope: "once" },
            { kind: "question", answers: { "Which?": ["Ada's"] } },
          ]) {
            const body = JSON.stringify({
              threadId: orchestrator.id,
              requestId: RequestId.make("pending-of-grace"),
              answer,
            });
            expect(
              yield* post(port, ASK_ANSWER_PATH, body, { [IDENTITY_HEADER]: proxy.statement(ada) }),
            ).toMatchObject({ status: 403, body: expect.stringContaining(NOT_YOUR_MACHINE) });
          }
          // Grace gets past it: there is just no such request.
          const hers = JSON.stringify({
            threadId: orchestrator.id,
            requestId: RequestId.make("pending-of-grace"),
            answer: { kind: "approval", decision: "allow", scope: "once" },
          });
          expect(
            (yield* post(port, ASK_ANSWER_PATH, hers, {
              [IDENTITY_HEADER]: proxy.statement(grace),
            })).status,
          ).toBe(404);
          // And her worker still takes her word.
          expect(
            yield* refusal(
              graceClient["thread.send"]({
                threadId: worker.id,
                input: { text: "from Grace" },
                clientMessageId: "lineage-2",
              }),
            ),
          ).toBe("the call went through");
        }),
      );
    },
  );

  layer(server(false), { excludeTestServices: true })("with the hosted features off", (it) => {
    it.effect("takes the launch token as before, and no proxy's word", () =>
      Effect.gen(function* () {
        const { port, token } = yield* info;
        const store = yield* ThreadStore;
        const host = { host: `127.0.0.1:${port}` };
        const signedIn = { ...host, [IDENTITY_HEADER]: proxy.statement() };
        expect(yield* get(port, "/", signedIn)).toMatchObject({
          status: 401,
          body: "unauthorized: launch token required",
        });
        expect(yield* upgrade(port, signedIn)).toBe(401);

        const boot = yield* get(port, `/?boot=${token}`, host);
        expect(boot.status).toBe(302);
        const cookie = boot.setCookie.split(";")[0] ?? "";
        const app = yield* client(port, { ...host, cookie });
        yield* app["settings.set"]({ patch: { logLevel: "debug" } });
        expect((yield* app["settings.get"]()).logLevel).toBe("debug");
        // Nobody is named, so nothing is recorded.
        expect(yield* store.listActorEvents()).toEqual([]);
        // Starting a thread from a profile is a hosted feature: here, a path that isn't there.
        const local = { ...host, cookie, origin: `http://127.0.0.1:${port}` };
        expect((yield* post(port, PROFILE_START_PATH, "{}", local)).status).toBe(404);
      }),
    );
  });
});
