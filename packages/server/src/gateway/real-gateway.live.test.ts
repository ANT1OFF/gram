import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Dirent,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { CodexHost, CodexHostLive } from "@gram/agents/codex";
import { GramRpcs, type ServerEvent, type GramUIMessage, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import { readOpenCodeKey } from "./seed.ts";

// `GRAM_LIVE_REAL_GATEWAY=1`, approved for a run and kept short: the real gateway from the user's
// OpenCode config, its key taken only through the product's import (never printed or copied), one
// discovery and one "Reply OK." turn each for OpenCode and Codex. The user's configs are only read:
// the agents run under a temp HOME, CODEX_HOME and XDG dirs, and the data dir is temp too.
const live = process.env["GRAM_LIVE_REAL_GATEWAY"] === "1";

const tempRoot = live ? realpathSync(mkdtempSync(join(tmpdir(), "gram-real-gateway-"))) : "";
const tempHome = join(tempRoot, "home");
const dataDir = join(tempRoot, "data");
const isolatedEnv: Record<string, string> = {
  HOME: tempHome,
  CODEX_HOME: join(tempHome, ".codex"),
  XDG_CONFIG_HOME: join(tempHome, ".config"),
  XDG_DATA_HOME: join(tempHome, ".local", "share"),
  XDG_STATE_HOME: join(tempHome, ".local", "state"),
  XDG_CACHE_HOME: process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"),
};
if (live) {
  for (const dir of [isolatedEnv["CODEX_HOME"], isolatedEnv["XDG_CONFIG_HOME"], dataDir]) {
    if (dir !== undefined) mkdirSync(dir, { recursive: true });
  }
}

const Agents: Layer.Layer<AgentHosts, never, GatewayCredentials> = Layer.effect(
  AgentHosts,
  Effect.gen(function* () {
    return AgentHosts.fromHosts([yield* CodexHost]);
  }),
).pipe(
  Layer.provide(
    CodexHostLive({
      servers: { extraEnv: isolatedEnv, gatewayHome: () => prepareCodexHome(dataDir, tempHome) },
    }),
  ),
  Layer.provide(GatewayCredentials.layerProvider),
);

// A file database, so profiles are seeded from the user's configs and the key sweep can check it.
const TestServer = ServerLayer.pipe(
  Layer.provide(Agents),
  Layer.provideMerge(GatewayCredentials.layer),
  Layer.provide(TurnHooks.layerNoop),
  Layer.provide(gitPlatformTest()),
  Layer.provide(
    ServerConfig.layer({ ...TEST_CONFIG, dataDir, databaseFile: join(dataDir, "gram.db") }),
  ),
  Layer.orDie,
);

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

const turnCompleted = (events: ReadonlyArray<ServerEvent>, threadId: ThreadId, from: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < 1800; i++) {
      const statuses = events
        .slice(from)
        .flatMap((e) => (e.type === "thread.status" && e.threadId === threadId ? [e.status] : []));
      const running = statuses.indexOf("running");
      if (running !== -1 && statuses.slice(running).includes("idle")) return;
      const failed = statuses.find((s) => s === "error" || s === "ended");
      if (failed !== undefined) {
        // What the agent said went wrong: the status detail, then any notification for the thread.
        const reasons = events
          .slice(from)
          .flatMap((e) =>
            e.type === "thread.status" && e.threadId === threadId && e.detail !== undefined
              ? [e.detail]
              : e.type === "notify" && e.threadId === threadId
                ? [[e.title, e.body].filter((part) => part !== undefined).join(": ")]
                : [],
          );
        return yield* Effect.die(
          new Error(`thread ${threadId} ${failed}: ${reasons.join(" | ") || "no detail"}`),
        );
      }
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.die(new Error(`no completed turn on ${threadId}`));
  });

const assistantText = (messages: ReadonlyArray<GramUIMessage>) =>
  messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])))
    .join("")
    .trim();

const CHEAP_TIERS = ["gpt-5-nano", "gpt-5.1-nano", "nano", "gpt-5-mini", "mini", "haiku", "flash"];

/** A model's place among `CHEAP_TIERS`; unlisted models rank last. */
const cheapRank = (id: string) => {
  const lower = id.toLowerCase();
  const index = CHEAP_TIERS.findIndex((tier) => lower.includes(tier));
  return index === -1 ? CHEAP_TIERS.length : index;
};

/** Cheap models first: the smallest GPT tiers, then anything small, else the first listed. */
const cheapest = (ids: ReadonlyArray<string>): string | undefined =>
  ids.toSorted((a, b) => cheapRank(a) - cheapRank(b))[0];

/**
 * Every file under `dir` as bytes, for the key sweep. Codex rewrites its plugin checkout under
 * `codex-home/.tmp` while it runs, so entries that vanish mid-walk are skipped.
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

describe.skipIf(!live)("real gateway (GRAM_LIVE_REAL_GATEWAY=1)", () => {
  afterAll(() => {
    try {
      execFileSync("trash", [tempRoot]);
    } catch {
      // Best effort: the agents' helpers may still be writing there for a moment.
    }
  }, 60_000);

  it.live(
    "imports the key, discovers models, and gets a reply from OpenCode and Codex",
    () =>
      Effect.gen(function* () {
        const client = yield* makeClient;
        const events: Array<ServerEvent> = [];
        yield* Effect.forkScoped(
          Stream.runForEach(client["events.subscribe"](undefined), (event) =>
            Effect.sync(() => void events.push(event)),
          ),
        );
        const cwd = join(tempRoot, "project");
        mkdirSync(cwd, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd });

        // Seeded from the user's OpenCode config on first run; the key comes only through import.
        const profiles = yield* client["profiles.list"](undefined);
        const profile = profiles.find((p) => p.keyRef === "") ?? profiles[0];
        if (profile === undefined) return yield* Effect.die(new Error("no gateway profile seeded"));
        const imported = yield* client["profiles.importKey"]({
          profileId: profile.id,
          source: "opencode",
        });
        if (!imported.imported)
          return yield* Effect.die(new Error("OpenCode has no key to import"));
        const discovered = (yield* client["profiles.list"](undefined)).find(
          (p) => p.id === profile.id,
        );
        const ids = discovered?.models.map((m) => m.id) ?? [];
        if (ids.length === 0) return yield* Effect.die(new Error("discovery listed no models"));
        // `GRAM_LIVE_REAL_GATEWAY_MODEL` names the model to use instead of the cheapest listed one.
        const override = process.env["GRAM_LIVE_REAL_GATEWAY_MODEL"];
        const model = override ?? cheapest(ids);
        if (model === undefined) return yield* Effect.die(new Error("no model to use"));
        const listed =
          override === undefined
            ? ""
            : ` (${override} ${ids.includes(override) ? "is" : "isn't"} listed)`;
        console.log(
          `[real gateway] ${profile.name} at ${profile.baseURL}: ${ids.length} models discovered${listed}; using ${model}`,
        );

        const replies: Record<string, string> = {};
        // `GRAM_LIVE_REAL_GATEWAY_AGENTS=codex` limits a retry to one agent.
        const only = process.env["GRAM_LIVE_REAL_GATEWAY_AGENTS"]?.split(",");
        const agents = (["codex"] as const).filter(
          (agent) => only === undefined || only.includes(agent),
        );
        for (const agent of agents) {
          const from = events.length;
          // An explicit title, so Gram's title helper makes no extra gateway call.
          const thread = yield* client["thread.create"]({
            projectRoot: cwd,
            checkout: { kind: "current" },
            model: { agent, model, profileId: profile.id },
            title: `Real gateway check (${agent})`,
            input: { text: "Reply OK." },
          });
          yield* Effect.addFinalizer(() =>
            client["thread.close"]({ threadId: thread.id }).pipe(Effect.ignore),
          );
          yield* turnCompleted(events, thread.id, from);
          const feed = yield* client["thread.subscribe"]({ threadId: thread.id }).pipe(
            Stream.takeUntil((event) => event.type === "caughtUp"),
            Stream.runCollect,
          );
          const messages = Array.from(feed).flatMap((event) =>
            event.type === "messages"
              ? event.messages
              : event.type === "message"
                ? [event.message]
                : [],
          );
          replies[agent] = assistantText(messages);
          console.log(`[real gateway] ${agent} replied: ${replies[agent].slice(0, 40)}`);
        }
        for (const agent of agents) expect(replies[agent]).not.toBe("");

        // The key's prefix stays in memory only: it's never printed, and must appear in no file.
        const key = yield* readOpenCodeKey(homedir(), profile.baseURL);
        const prefix = Option.match(key, {
          onNone: () => "",
          onSome: (value) => Redacted.value(value).slice(0, 12),
        });
        expect(prefix.length).toBe(12);
        const leaks = filesUnder(tempRoot).filter((file) => file.data.includes(prefix));
        console.log(
          `[real gateway] key sweep: ${filesUnder(tempRoot).length} files checked, ${leaks.length} contained the key`,
        );
        expect(leaks.map((file) => file.name)).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(TestServer)),
    { timeout: 300_000 },
  );
});
