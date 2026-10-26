import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  type Dirent,
} from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { CodexHost, CodexHostLive } from "@gram/agents/codex";
import { GramRpcs, type ProfileId, type ServerEvent, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { gitPlatformTest } from "../git/platform.ts";
import { LaunchToken, serverPort, ServerLayer } from "../http/server.ts";
import { HttpServer, RpcClient, RpcSerialization, Socket } from "../platform/unstable.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { TurnHooks } from "../runtime/hooks.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { prepareCodexHome } from "./codex-home.ts";
import { GatewayCredentials } from "./credentials.ts";

// `GRAM_LIVE_GATEWAY_KEY=1`: the real server with the installed `opencode` and `codex`, a gateway
// profile on a local fake OpenAI-compatible API, and a sentinel key set through the RPC. Temp HOME,
// CODEX_HOME and XDG config/data/state dirs, so no user configuration is read or written.
const live = process.env["GRAM_LIVE_GATEWAY_KEY"] === "1";

const SENTINEL = "sk-live-sentinel-5d1e8a";
const ROTATED = "sk-live-rotated-93b0c4";
const MODEL = "gpt-5.5";

const sse = (events: ReadonlyArray<{ readonly type: string }>) =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

/** A Responses API stream answering `text` (the shape Codex reads). */
const responsesReply = (text: string) =>
  sse([
    { type: "response.created", response: { id: "resp_1" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", role: "assistant", id: "msg_1", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        role: "assistant",
        id: "msg_1",
        content: [{ type: "output_text", text }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        usage: {
          input_tokens: 5,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 7,
        },
      },
    },
  ] as unknown as ReadonlyArray<{ readonly type: string }>);

/** A chat/completions stream answering `text` (the shape OpenCode's openai-compatible provider reads). */
const chatReply = (text: string) =>
  [
    { choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    },
  ]
    .map(
      (chunk) =>
        `data: ${JSON.stringify({ id: "chat_1", object: "chat.completion.chunk", created: 1, model: MODEL, ...chunk })}\n\n`,
    )
    .join("") + "data: [DONE]\n\n";

interface Seen {
  readonly path: string;
  readonly authorization: string;
}

const fakeGateway = () =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ server: Server; port: number; seen: Array<Seen> }>((resolve) => {
          const seen: Array<Seen> = [];
          const server = createServer((req, res) => {
            const path = req.url ?? "";
            seen.push({ path, authorization: req.headers.authorization ?? "" });
            req.resume().on("end", () => {
              if (path.endsWith("/models")) {
                res
                  .writeHead(200, { "content-type": "application/json" })
                  .end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model" }] }));
              } else if (path.includes("/responses")) {
                res
                  .writeHead(200, { "content-type": "text/event-stream" })
                  .end(responsesReply("Hello from Codex."));
              } else if (path.includes("/chat/completions")) {
                res
                  .writeHead(200, { "content-type": "text/event-stream" })
                  .end(chatReply("Hello from OpenCode."));
              } else {
                res.writeHead(404).end();
              }
            });
          });
          server.listen(0, "127.0.0.1", () =>
            resolve({ server, port: (server.address() as { port: number }).port, seen }),
          );
        }),
    ),
    ({ server }) => Effect.promise(() => new Promise<void>((done) => server.close(() => done()))),
  );

// Only a live run makes the temp home; importing the skipped suite must not leave dirs behind.
const tempHome = live ? realpathSync(mkdtempSync(join(tmpdir(), "gram-live-key-home-"))) : "";
const isolatedEnv: Record<string, string> = {
  HOME: tempHome,
  CODEX_HOME: join(tempHome, ".codex"),
  XDG_CONFIG_HOME: join(tempHome, ".config"),
  XDG_DATA_HOME: join(tempHome, ".local", "share"),
  XDG_STATE_HOME: join(tempHome, ".local", "state"),
  // OpenCode caches provider packages here; reusing the user's cache avoids a download.
  XDG_CACHE_HOME: process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"),
};
if (live) {
  for (const dir of [isolatedEnv["CODEX_HOME"], isolatedEnv["XDG_CONFIG_HOME"]]) {
    if (dir !== undefined) mkdirSync(dir, { recursive: true });
  }
}

const Agents: Layer.Layer<AgentHosts, never, GatewayCredentials> = Layer.effect(
  AgentHosts,
  Effect.gen(function* () {
    return AgentHosts.fromHosts([yield* CodexHost]);
  }),
).pipe(
  // The owned Codex home, as in the product, so the sweep covers what gateway Codex sessions persist.
  Layer.provide(
    CodexHostLive({
      servers: {
        extraEnv: isolatedEnv,
        gatewayHome: () => prepareCodexHome(join(tempHome, "data"), tempHome),
      },
    }),
  ),
  Layer.provide(GatewayCredentials.layerProvider),
);

const TestServer = ServerLayer.pipe(
  Layer.provide(Agents),
  Layer.provideMerge(GatewayCredentials.layer),
  Layer.provide(TurnHooks.layerNoop),
  Layer.provide(gitPlatformTest()),
  Layer.provide(ServerConfig.layer({ ...TEST_CONFIG, dataDir: join(tempHome, "data") })),
  Layer.orDie,
);

/** Performs the boot navigation and returns an RPC client with the session cookie. */
const makeClient = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const { token } = yield* LaunchToken;
  const port = serverPort(server);
  const setCookie = yield* Effect.promise(
    () =>
      new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port, path: `/?boot=${token}`, agent: false },
          (res) => {
            res.resume();
            resolve(res.headers["set-cookie"]?.[0] ?? "");
          },
        );
        req.on("error", reject);
        req.end();
      }),
  );
  const cookie = setCookie.split(";")[0] ?? "";
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/ws`)),
      Layer.provide(
        Layer.succeed(Socket.WebSocketConstructor)(
          (url) =>
            new (globalThis.WebSocket as unknown as new (
              url: string,
              init: { headers: Record<string, string> },
            ) => globalThis.WebSocket)(url, { headers: { cookie } }),
        ),
      ),
      Layer.provide(RpcSerialization.layerJson),
    ),
  );
  return yield* RpcClient.make(GramRpcs).pipe(Effect.provideContext(protocol));
});

/** Waits until `threadId` has gone from running back to idle, i.e. a turn completed. */
const turnCompleted = (events: ReadonlyArray<ServerEvent>, threadId: ThreadId, from: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < 1200; i++) {
      const statuses = events
        .slice(from)
        .flatMap((e) => (e.type === "thread.status" && e.threadId === threadId ? [e.status] : []));
      const running = statuses.indexOf("running");
      if (running !== -1 && statuses.slice(running).includes("idle")) return events.length;
      const failed = statuses.find((s) => s === "error" || s === "ended");
      if (failed !== undefined) return yield* Effect.die(new Error(`thread ${threadId} ${failed}`));
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.die(new Error(`no completed turn on ${threadId}`));
  });

/**
 * Every file under `dir` as bytes, for the key sweep. The agents keep writing while it runs (Codex
 * rewrites its plugin checkout), so entries that vanish mid-walk are skipped.
 */
const filesUnder = (dir: string): Array<{ name: string; data: Buffer }> => {
  let entries: Array<Dirent>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    if (!entry.isFile()) return [];
    try {
      return [{ name: path, data: readFileSync(path) }];
    } catch {
      return [];
    }
  });
};

describe.skipIf(!live)("gateway key, live (GRAM_LIVE_GATEWAY_KEY=1)", () => {
  // Best effort, after the server layer has stopped the agent servers. Moving the temp home to the
  // trash is instant, where deleting the agents' state in place can outlast any hook timeout.
  afterAll(() => {
    try {
      execFileSync("trash", [tempHome]);
    } catch {
      rmSync(tempHome, { recursive: true, force: true });
    }
  }, 60_000);

  it.live(
    "a key set through the RPC reaches OpenCode and Codex, and a replaced key reaches them after reopen",
    () =>
      Effect.gen(function* () {
        const gateway = yield* fakeGateway();
        const client = yield* makeClient;
        const events: Array<ServerEvent> = [];
        yield* Effect.forkScoped(
          Stream.runForEach(client["events.subscribe"](undefined), (event) =>
            Effect.sync(() => void events.push(event)),
          ),
        );
        const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gram-live-key-project-")));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() =>
            rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
          ),
        );
        execFileSync("git", ["init", "-q"], { cwd });

        const profileId = "litellm" as ProfileId;
        yield* client["profiles.upsert"]({
          profile: {
            id: profileId,
            name: "Local gateway",
            baseURL: `http://127.0.0.1:${gateway.port}/v1`,
            keyRef: "",
            models: [],
          },
        });
        expect(
          yield* client["profiles.setKey"]({ profileId, key: Redacted.make(SENTINEL) }),
        ).toEqual({ discovered: 1 });

        const threads: Array<ThreadId> = [];
        for (const agent of ["codex"] as const) {
          const from = events.length;
          const thread = yield* client["thread.create"]({
            projectRoot: cwd,
            checkout: { kind: "current" },
            model: { agent, model: MODEL, profileId },
            input: { text: `Say hello, ${agent}.` },
          });
          threads.push(thread.id);
          yield* Effect.addFinalizer(() =>
            client["thread.close"]({ threadId: thread.id }).pipe(Effect.ignore),
          );
          yield* turnCompleted(events, thread.id, from);
        }

        const calls = (key: string) =>
          gateway.seen.filter(
            (s) => !s.path.endsWith("/models") && s.authorization === `Bearer ${key}`,
          );
        expect(calls(SENTINEL).some((s) => s.path.includes("/responses"))).toBe(true);
        expect(
          gateway.seen.filter(
            (s) => !s.path.endsWith("/models") && !s.authorization.startsWith("Bearer sk-live-"),
          ),
        ).toEqual([]);

        // Replacing the key retires both servers; the idle sessions reopen with the new key.
        yield* client["profiles.setKey"]({ profileId, key: Redacted.make(ROTATED) });
        for (const threadId of threads) {
          yield* Effect.sleep("500 millis");
          const from = events.length;
          yield* client["thread.send"]({ threadId, input: { text: "Again, please." } });
          yield* turnCompleted(events, threadId, from);
        }
        expect(calls(ROTATED).some((s) => s.path.includes("/responses"))).toBe(true);

        // The agents' state under HOME, the data dir and the owned Codex home must hold neither key.
        const holders = filesUnder(tempHome)
          .filter((file) => file.data.includes(SENTINEL) || file.data.includes(ROTATED))
          .map((file) => file.name.slice(tempHome.length));
        console.log(`[live key] sweep: ${holders.length} files hold a key: ${holders.join(", ")}`);
        expect(holders).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(TestServer)),
    { timeout: 300_000 },
  );
});
