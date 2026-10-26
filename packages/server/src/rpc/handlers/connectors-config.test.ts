import { describe, expect, it } from "@effect/vitest";
import type { ConnectorStatus } from "@gram/agents";
import {
  type AgentConfiguredServers,
  type ConfiguredServer,
  type SeenConnector,
  type ThreadId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { homedir } from "node:os";
import { ClaudeAiSeen, mergeSeen, SEEN_REWRITE_MS } from "../../connectors/claude-ai-seen.ts";
import {
  connectorLoginArgs,
  connectorSignInPage,
  McpCli,
  type McpCliOutput,
} from "../../connectors/mcp-cli.ts";
import { FakeAgentControl } from "../../runtime/fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "../../runtime/test-harness.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import {
  AGENT_LIST_TIMEOUT_MS,
  CONFIGURED_REFRESH_MS,
  CONNECTOR_RECONNECT_EVERY_MS,
  connectorHandlers,
  LIVE_STATUS_TIMEOUT_MS,
  presentable,
} from "./connectors.ts";

/**
 * A `claude mcp` stand-in that records each call and answers with `output`; `configured` is what
 * Claude Code's config files hold.
 */
const recordingCli = (configured: ReadonlyArray<ConfiguredServer> = []) => {
  const calls: Array<{ args: ReadonlyArray<string>; cwd: string }> = [];
  let output: McpCliOutput = { status: 0, stdout: "Added", stderr: "" };
  return {
    calls,
    answer: (next: McpCliOutput) => {
      output = next;
    },
    cli: {
      configured: () => Effect.succeed(configured),
      run: (args: ReadonlyArray<string>, cwd: string) =>
        Effect.sync(() => {
          calls.push({ args: [...args], cwd });
          return output;
        }),
    },
  };
};

/** A plain remote server Claude Code has at the `user` scope. */
const server = (name: string): ConfiguredServer => ({
  name,
  transport: "http",
  url: `https://organization.example.invalid/${name}`,
  scope: "user",
  carriesValues: false,
});

const remote = (url: string) =>
  presentable({ name: "y", transport: "http", url, scope: "project", carriesValues: false });

/** Claude Code's claude.ai rows: name, signed in, used before, and whether as last seen. */
const hosted = (agent: AgentConfiguredServers) =>
  agent.servers
    .filter((s) => s.scope === "claudeai")
    .map((s) => [s.name, s.signedIn, s.everConnected, s.seenAt !== undefined]);

/** The test runtime, with what Claude threads report of their connectors kept in memory. */
const SeenTestLayer = Layer.unwrap(
  Effect.sync(() => {
    let kept: ReadonlyArray<SeenConnector> = [];
    return RuntimeTestLayer.pipe(
      Layer.provideMerge(
        Layer.succeed(ClaudeAiSeen, {
          record: (seen) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => {
                kept = mergeSeen(kept, seen, now) ?? kept;
              }),
            ),
          read: Effect.sync(() => kept),
        }),
      ),
    );
  }),
);

const liveThreadOn = (agent: "claude" | "codex") =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const thread = yield* runtimes.create({
      projectRoot: "/work/repo",
      checkout: { kind: "main", path: "/work/repo" },
      model: { agent, model: "default" },
    });
    yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
    return thread;
  });

const liveThread = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;
  const thread = yield* runtimes.create({
    projectRoot: "/work/repo",
    checkout: { kind: "main", path: "/work/repo" },
  });
  yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
  return thread;
});

describe("connectors.add / connectors.remove", () => {
  it.effect(
    "add-json in the thread's checkout, then the live Claude session reloads it in place",
    () =>
      Effect.gen(function* () {
        const cli = recordingCli();
        const handlers = yield* connectorHandlers.pipe(Effect.provideService(McpCli, cli.cli));
        const fake = yield* FakeAgentControl;
        const thread = yield* liveThread;

        const result = yield* handlers["connectors.add"]({
          threadId: thread.id,
          scope: "project",
          name: "sentry",
          config: {
            type: "http",
            url: "https://mcp.sentry.dev/mcp",
            headers: { Authorization: "Bearer sekrit-token" },
          },
        });

        expect(result).toEqual({ name: "sentry", session: "applied" });
        expect(cli.calls).toHaveLength(1);
        const [call] = cli.calls;
        expect(call!.cwd).toBe("/work/repo");
        expect(call!.args.slice(0, 5)).toEqual(["mcp", "add-json", "--scope", "project", "sentry"]);
        expect(JSON.parse(call!.args[5]!)).toEqual({
          type: "http",
          url: "https://mcp.sentry.dev/mcp",
          headers: { Authorization: "Bearer sekrit-token" },
        });
        // Claude Code's reconnect reads the new entry, so the session needs no restart.
        expect((yield* fake.latest(thread.id)).connectorCalls).toEqual(["reconnect:sentry"]);
        expect(fake.sessions.filter((s) => s.options.threadId === thread.id)).toHaveLength(1);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("configures a folder without a thread, and removes from a scope or any", () =>
    Effect.gen(function* () {
      const cli = recordingCli();
      const handlers = yield* connectorHandlers.pipe(Effect.provideService(McpCli, cli.cli));

      expect(
        yield* handlers["connectors.add"]({
          cwd: "/work/other",
          scope: "user",
          name: "fs",
          config: { type: "stdio", command: "npx", args: ["-y", "fs"], env: { ROOT: "/tmp" } },
        }),
      ).toEqual({ name: "fs", session: "noSession" });
      expect(JSON.parse(cli.calls[0]!.args[5]!)).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", "fs"],
        env: { ROOT: "/tmp" },
      });
      expect(cli.calls[0]!.cwd).toBe("/work/other");

      yield* handlers["connectors.remove"]({ cwd: "/work/other", name: "fs", scope: "user" });
      yield* handlers["connectors.remove"]({ cwd: "/work/other", name: "fs" });
      expect(cli.calls.slice(1).map((c) => c.args)).toEqual([
        ["mcp", "remove", "--scope", "user", "fs"],
        ["mcp", "remove", "fs"],
      ]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("refuses bad names and a missing folder, and never echoes a secret", () =>
    Effect.gen(function* () {
      const cli = recordingCli();
      const handlers = yield* connectorHandlers.pipe(Effect.provideService(McpCli, cli.cli));
      const config = {
        type: "stdio" as const,
        command: "run",
        env: { TOKEN: "sekrit-token" },
      };

      const badName = yield* Effect.flip(
        handlers["connectors.add"]({ cwd: "/work", scope: "local", name: "my server", config }),
      );
      expect(badName._tag).toBe("InvalidState");
      const noFolder = yield* Effect.flip(
        handlers["connectors.add"]({ scope: "local", name: "ok", config }),
      );
      expect(noFolder._tag).toBe("InvalidState");
      expect(cli.calls).toEqual([]);

      cli.answer({ status: 1, stdout: "", stderr: "Invalid env TOKEN=sekrit-token\nmore" });
      const failed = yield* Effect.flip(
        handlers["connectors.add"]({ cwd: "/work", scope: "local", name: "ok", config }),
      );
      expect(failed._tag).toBe("InvalidState");
      expect(failed.message).toBe("Couldn't add ok: Invalid env TOKEN=•••• more");
      expect(failed.message).not.toContain("sekrit-token");

      const unknown = yield* Effect.flip(
        handlers["connectors.add"]({
          threadId: "t-missing" as ThreadId,
          scope: "local",
          name: "ok",
          config,
        }),
      );
      expect(unknown._tag).toBe("ThreadNotFound");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("without a runner, the server refuses instead of writing a real config", () =>
    Effect.gen(function* () {
      const handlers = yield* connectorHandlers;
      const error = yield* Effect.flip(
        handlers["connectors.add"]({
          cwd: "/work",
          scope: "local",
          name: "ok",
          config: { type: "http", url: "https://x.example/mcp" },
        }),
      );
      expect(error.message).toBe("Couldn't add ok: Claude Code's CLI isn't available here");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "writes the thread's own agent by default, never Claude Code's config for a Codex thread",
    () =>
      Effect.gen(function* () {
        const cli = recordingCli();
        const handlers = yield* connectorHandlers.pipe(Effect.provideService(McpCli, cli.cli));
        const fake = yield* FakeAgentControl;
        const thread = yield* liveThreadOn("codex");
        const config = {
          type: "http" as const,
          url: "https://organization.example.invalid/example",
        };

        expect(
          yield* handlers["connectors.add"]({
            threadId: thread.id,
            scope: "project",
            name: "example",
            config,
          }),
        ).toEqual({ name: "example", session: "reopening" });
        // Codex has one scope, so `project` lands in its user config.
        expect(fake.mcpConfigCalls).toEqual(["codex:add:user:example"]);
        expect(cli.calls).toEqual([]);

        yield* handlers["connectors.remove"]({
          threadId: thread.id,
          name: "example",
          scope: "user",
        });
        expect(fake.mcpConfigCalls.at(-1)).toBe("codex:remove:user:example");
        expect(cli.calls).toEqual([]);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("writes one server for several agents, each at the nearest scope it has", () =>
    Effect.gen(function* () {
      const cli = recordingCli();
      const handlers = yield* connectorHandlers.pipe(Effect.provideService(McpCli, cli.cli));
      const fake = yield* FakeAgentControl;
      const add = {
        cwd: "/work/other",
        scope: "local" as const,
        name: "example",
        config: {
          type: "http" as const,
          url: "https://organization.example.invalid/example",
          headers: { Authorization: "Bearer sekrit-token" },
        },
      };

      yield* handlers["connectors.add"]({ ...add, targets: ["claude", "codex"] });
      expect(cli.calls.map((c) => c.args.slice(0, 5))).toEqual([
        ["mcp", "add-json", "--scope", "local", "example"],
      ]);
      expect(fake.mcpConfigCalls).toEqual(["codex:add:user:example"]);

      yield* handlers["connectors.add"]({ ...add, scope: "project", targets: ["codex"] });
      expect(fake.mcpConfigCalls.at(-1)).toBe("codex:add:user:example");

      // A failure names the agent, says who already has it, and masks the server's secrets.
      yield* fake.setMcpConfigFailure("/home/.codex/config.toml: bad header Bearer sekrit-token");
      const failed = yield* Effect.flip(
        handlers["connectors.add"]({ ...add, targets: ["claude", "codex"] }),
      );
      expect(failed.message).toBe(
        "Couldn't add example to Codex: /home/.codex/config.toml: bad header •••• (Claude Code already has it)",
      );
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("restarts each live session that reads the change, and after a sign-in", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const handlers = yield* connectorHandlers.pipe(
        Effect.provideService(McpCli, recordingCli().cli),
      );
      const fake = yield* FakeAgentControl;
      const here = yield* liveThreadOn("claude");
      const elsewhere = yield* runtimes.create({
        projectRoot: "/work/other",
        checkout: { kind: "main", path: "/work/other" },
      });
      yield* waitFor("idle", runtimes.status(elsewhere.id).pipe(Effect.map((s) => s === "idle")));
      const codex = yield* liveThreadOn("codex");
      const opened = (threadId: ThreadId) =>
        fake.sessions.filter((s) => s.options.threadId === threadId).length;
      const config = { type: "http" as const, url: "https://organization.example.invalid/example" };

      // A project's server reaches the Claude sessions in its folder, which reload it in place.
      yield* handlers["connectors.add"]({ cwd: "/work/repo", scope: "project", name: "a", config });
      expect((yield* fake.latest(here.id)).connectorCalls).toEqual(["reconnect:a"]);
      expect((yield* fake.latest(elsewhere.id)).connectorCalls).toEqual([]);
      // A removal can't be reloaded in place, so the session restarts once idle.
      yield* handlers["connectors.remove"]({ cwd: "/work/repo", scope: "project", name: "a" });
      yield* waitFor(
        "the folder's restart",
        Effect.sync(() => opened(here.id) === 2),
      );
      expect([opened(elsewhere.id), opened(codex.id)]).toEqual([1, 1]);

      // A user server reaches every one of the agent's; Codex's server is retired once for it.
      yield* handlers["connectors.add"]({ scope: "user", name: "b", config, targets: ["codex"] });
      yield* waitFor(
        "the Codex restart",
        Effect.sync(() => opened(codex.id) === 2),
      );
      expect(fake.configReloads).toEqual(["claude:", "codex:*"]);

      // Codex's sign-in from Settings finishing reaches its sessions as a change does.
      yield* waitFor("idle", runtimes.status(codex.id).pipe(Effect.map((s) => s === "idle")));
      yield* handlers["connectors.signIn"]({ target: "codex", name: "b" });
      yield* waitFor(
        "the restart after signing in",
        Effect.sync(() => opened(codex.id) === 3),
      );
      expect([opened(here.id), opened(elsewhere.id)]).toEqual([2, 1]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("lists every agent's configured servers with no thread, and no connection", () =>
    Effect.gen(function* () {
      const cli = recordingCli([
        {
          name: "github",
          transport: "http",
          url: "https://gh.example/mcp",
          scope: "user",
          carriesValues: true,
        },
        {
          name: "files",
          transport: "stdio",
          command: "npx",
          args: ["-y", "fs"],
          scope: "local",
          carriesValues: false,
        },
      ]);
      const handlers = yield* connectorHandlers.pipe(Effect.provideService(McpCli, cli.cli));
      const fake = yield* FakeAgentControl;
      yield* handlers["connectors.add"]({
        cwd: "/work/repo",
        scope: "user",
        name: "example",
        config: {
          type: "http",
          url: "https://organization.example.invalid/example",
          headers: { Authorization: "Bearer sekrit-token" },
        },
        targets: ["codex"],
      });

      const cold = yield* handlers["connectors.configured"]({ fresh: true });
      expect(cold.agents.map((a) => [a.target, a.signIn, a.servers.map((s) => s.name)])).toEqual([
        ["claude", "liveOnly", ["github", "files"]],
        ["codex", "onRequest", ["example"]],
      ]);
      // With no Claude thread running, nothing says whether Claude Code is signed in.
      expect(cold.agents[0]!.servers.every((s) => s.signedIn === undefined)).toBe(true);
      expect(JSON.stringify(cold)).not.toContain("sekrit");
      expect(cold.agents[1]!.servers[0]).toMatchObject({ carriesValues: true, signedIn: false });
      expect(cli.calls.filter((c) => c.args[1] !== "add-json")).toEqual([]);

      // A running Claude thread adds its sign-ins and the account's claude.ai connectors.
      yield* liveThreadOn("claude");
      const [claude] = (yield* handlers["connectors.configured"]({
        cwd: "/work/repo",
        fresh: true,
      })).agents;
      expect(claude!.servers.map((s) => [s.name, s.scope, s.signedIn])).toEqual([
        ["github", "user", true],
        ["files", "local", undefined],
        ["linear", "claudeai", false],
      ]);
      // A claude.ai connector keeps its upstream address, which another agent can be given.
      expect(claude!.servers[2]).toMatchObject({
        url: "https://mcp.linear.app/mcp",
        claudeAi: { id: "mcpsrv_linear" },
      });
      expect(claude).not.toHaveProperty("claudeAiUnavailable");

      // One agent's unreadable config is its own error; the others' lists stand.
      yield* fake.setMcpConfigFailure("mcp.json: token=sekrit-token-value isn't JSON");
      const broken = yield* handlers["connectors.configured"]({ fresh: true });
      expect(broken.agents[0]!.servers).toHaveLength(3);
      expect(broken.agents[1]).toEqual({
        target: "codex",
        signIn: "onRequest",
        servers: [],
        error: "mcp.json: token=[redacted] isn't JSON",
      });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("says why no claude.ai connector shows when every Claude thread is on a gateway", () =>
    Effect.gen(function* () {
      const handlers = yield* connectorHandlers.pipe(
        Effect.provideService(McpCli, recordingCli().cli),
      );
      const runtimes = yield* ThreadRuntimes;
      const gateway = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        model: { agent: "claude", model: "default", profileId: "litellm" as never },
      });
      yield* waitFor("idle", runtimes.status(gateway.id).pipe(Effect.map((s) => s === "idle")));
      const list = yield* handlers["connectors.list"]({ threadId: gateway.id });
      expect(list).toMatchObject({
        live: true,
        claudeAiUnavailable: "claude.ai connectors need your Claude sign-in.",
      });
      const [onGateway] = (yield* handlers["connectors.configured"]({ fresh: true })).agents;
      expect(onGateway!.claudeAiUnavailable).toBe("claude.ai connectors need your Claude sign-in.");
      expect(onGateway!.servers.map((s) => s.name)).toEqual([]);

      // One Claude thread on the subscription is enough to list them, and the note goes.
      yield* liveThreadOn("claude");
      const [both] = (yield* handlers["connectors.configured"]({ fresh: true })).agents;
      expect(both).not.toHaveProperty("claudeAiUnavailable");
      expect(both!.servers.map((s) => s.name)).toEqual(["linear"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("answers with the last read at once, and reads again behind it", () =>
    Effect.gen(function* () {
      let servers = [server("github")];
      /** Holds the reads back while set, so the one behind an answer is still running. */
      let gate: Deferred.Deferred<void> | undefined;
      const cli = {
        ...recordingCli().cli,
        configured: () =>
          (gate === undefined ? Effect.void : Deferred.await(gate)).pipe(
            Effect.andThen(Effect.sync(() => servers)),
          ),
      };
      const handlers = yield* connectorHandlers.pipe(Effect.provideService(McpCli, cli));
      const configured = (fresh?: boolean) =>
        handlers["connectors.configured"](fresh === undefined ? {} : { fresh });
      const claudeNames = (fresh?: boolean) =>
        configured(fresh).pipe(
          Effect.map((listed) => listed.agents[0]!.servers.map((s) => s.name)),
        );
      expect(yield* claudeNames()).toEqual(["github"]);
      // Changed behind Gram's back: within a few seconds the last read stands.
      servers = [server("github"), server("linear")];
      expect(yield* configured()).not.toHaveProperty("refreshing");
      yield* TestClock.adjust(CONFIGURED_REFRESH_MS + 1);
      // Older than that, the reader still isn't kept waiting, and a newer read starts behind it,
      // which the answer says, so the page asks again for it.
      const held = yield* Deferred.make<void>();
      gate = held;
      const stale = yield* configured();
      expect(stale.agents[0]!.servers.map((s) => s.name)).toEqual(["github"]);
      expect(stale.refreshing).toBe(true);
      gate = undefined;
      yield* Deferred.succeed(held, undefined);
      const landed = yield* waitFor(
        "the read behind it",
        configured().pipe(Effect.map((listed) => listed.refreshing !== true)),
      ).pipe(Effect.andThen(claudeNames()));
      expect(landed).toEqual(["github", "linear"]);
      // A refresh the user asks for reads now.
      servers = [server("github")];
      expect(yield* claudeNames(true)).toEqual(["github"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("never keeps, or hands on, a read that began before a configure", () =>
    Effect.gen(function* () {
      let servers = [server("github")];
      /** Holds a read back after it has read the config, as a slow live status does. */
      let gate: Deferred.Deferred<void> | undefined;
      let reads = 0;
      const recording = recordingCli();
      const cli = {
        ...recording.cli,
        configured: () =>
          Effect.sync(() => (reads++, servers)).pipe(
            Effect.tap(() => (gate === undefined ? Effect.void : Deferred.await(gate))),
          ),
        run: (args: ReadonlyArray<string>, cwd: string) =>
          recording.cli.run(args, cwd).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                servers = [server("github"), server("linear")];
              }),
            ),
          ),
      };
      const handlers = yield* connectorHandlers.pipe(Effect.provideService(McpCli, cli));
      const claudeNames = (fresh?: boolean) =>
        handlers["connectors.configured"](fresh === undefined ? {} : { fresh }).pipe(
          Effect.map((listed) => listed.agents[0]!.servers.map((s) => s.name)),
        );
      const held = yield* Deferred.make<void>();
      gate = held;
      const before = yield* Effect.forkScoped(claudeNames(true));
      yield* waitFor(
        "the read before the write",
        Effect.sync(() => reads === 1),
      );
      yield* handlers["connectors.add"]({
        cwd: "/work",
        scope: "user",
        name: "linear",
        config: { type: "http", url: "https://organization.example.invalid/linear" },
      });
      gate = undefined;
      // Asked after the write, the answer is read after it, not the one still running from before.
      const after = yield* Effect.forkScoped(claudeNames());
      yield* waitFor(
        "a read after the write",
        Effect.sync(() => reads === 2),
      );
      expect(yield* Fiber.join(after)).toEqual(["github", "linear"]);
      yield* Deferred.succeed(held, undefined);
      expect(yield* Fiber.join(before)).toEqual(["github"]);
      // The read from before landing later doesn't become the last read.
      expect(yield* claudeNames()).toEqual(["github", "linear"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("answers on time when a thread or an agent is slow to say", () =>
    Effect.gen(function* () {
      const cli = recordingCli([
        {
          name: "github",
          transport: "http",
          url: "https://x/github",
          scope: "user",
          carriesValues: false,
        },
      ]);
      const handlers = yield* connectorHandlers.pipe(Effect.provideService(McpCli, cli.cli));
      const fake = yield* FakeAgentControl;
      yield* liveThreadOn("claude");
      yield* liveThreadOn("claude");

      // Every thread and every agent stalls; the list comes back within the agents' own bound,
      // Claude Code's from its config with its sign-ins unknown, the others' as not answering.
      yield* fake.setMcpReadDelay("1 hour");
      const reading = yield* Effect.forkScoped(handlers["connectors.configured"]({ fresh: true }));
      yield* TestClock.adjust(LIVE_STATUS_TIMEOUT_MS);
      yield* TestClock.adjust(AGENT_LIST_TIMEOUT_MS);
      const listed = yield* Fiber.join(reading);
      expect(listed.agents[0]!.servers.map((s) => [s.name, s.signedIn])).toEqual([
        ["github", undefined],
      ]);
      expect(listed.agents.slice(1).map((a) => a.error)).toEqual([
        "Codex didn't answer in time; refresh to ask again.",
      ]);

      // A list the page stopped waiting for goes on, so Codex's app-server isn't left half-started,
      // and the next read joins it rather than starting another.
      expect(fake.mcpLists).toEqual(["codex"]);
      const again = yield* Effect.forkScoped(handlers["connectors.configured"]({ fresh: true }));
      yield* TestClock.adjust(AGENT_LIST_TIMEOUT_MS);
      expect((yield* Fiber.join(again)).agents[1]!.error).toContain("didn't answer in time");
      expect(fake.mcpLists).toEqual(["codex"]);
      yield* TestClock.adjust("1 hour");
      yield* fake.setMcpReadDelay(undefined);
      const done = yield* handlers["connectors.configured"]({ fresh: true });
      expect(done.agents.map((a) => a.error)).toEqual([undefined, undefined]);
      expect(fake.mcpLists).toEqual(["codex", "codex"]);

      // The threads are asked together, so two slow ones cost one wait, not two. The hour just
      // passed left the first two idle long enough to go cold, so two more start.
      yield* liveThreadOn("claude");
      yield* liveThreadOn("claude");
      yield* fake.setMcpReadDelay("1 second");
      const both = yield* Effect.forkScoped(handlers["connectors.configured"]({ fresh: true }));
      yield* TestClock.adjust("1 second");
      const answered = yield* Fiber.join(both);
      expect(answered.agents[0]!.servers.find((s) => s.name === "github")?.signedIn).toBe(true);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("signs in without a thread, Claude Code through a running Claude thread", () =>
    Effect.gen(function* () {
      const handlers = yield* connectorHandlers.pipe(
        Effect.provideService(McpCli, recordingCli().cli),
      );
      const fake = yield* FakeAgentControl;
      yield* handlers["connectors.add"]({
        cwd: "/work/repo",
        scope: "user",
        name: "example",
        config: { type: "http", url: "https://organization.example.invalid/example" },
        targets: ["codex"],
      });

      // Settings has no folder: the `user` scope needs none, a narrower one still does.
      yield* handlers["connectors.remove"]({ name: "example", scope: "user", target: "codex" });
      const nowhere = yield* Effect.flip(
        handlers["connectors.remove"]({ name: "example", scope: "local", target: "claude" }),
      );
      expect(nowhere.message).toBe("Pick a thread or a folder to configure the server for.");
      yield* handlers["connectors.add"]({
        scope: "user",
        name: "example",
        config: { type: "http", url: "https://organization.example.invalid/example" },
        targets: ["codex"],
      });

      expect(yield* handlers["connectors.signIn"]({ target: "codex", name: "example" })).toEqual({
        kind: "started",
      });
      expect(fake.mcpConfigCalls.at(-1)).toBe("codex:signIn:example");
      const listed = yield* handlers["connectors.configured"]({ checkSignIn: ["codex"] });
      expect(listed.agents[1]!.servers[0]!.signedIn).toBe(true);

      const claude = yield* Effect.flip(
        handlers["connectors.signIn"]({ target: "claude", name: "example" }),
      );
      expect(claude.message).toContain("/mcp");
      // Claude Code signs in from a session, so a running Claude thread takes it.
      const thread = yield* liveThreadOn("claude");
      const started = yield* handlers["connectors.signIn"]({
        target: "claude",
        name: "linear",
        cwd: "/work/repo",
        scope: "claudeai",
      });
      expect(started).toEqual({
        kind: "open",
        authorizationUrl: "https://idp.example/authorize?server=linear",
      });
      expect((yield* fake.latest(thread.id)).connectorCalls).toEqual(["authenticate:linear"]);
      // A row is the server of the session that lists it under that scope; this one has none.
      const shadowed = yield* Effect.flip(
        handlers["connectors.signIn"]({ target: "claude", name: "linear", scope: "user" }),
      );
      expect(shadowed.message).toContain("where this server is configured");
      expect((yield* fake.latest(thread.id)).connectorCalls).toEqual(["authenticate:linear"]);
      const missing = yield* Effect.flip(
        handlers["connectors.signIn"]({ target: "codex", name: "nope" }),
      );
      expect(missing._tag).toBe("AgentUnavailable");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("signs Claude Code in with claude mcp login when no Claude thread has the server", () =>
    Effect.gen(function* () {
      const logins: Array<{ name: string; cwd: string }> = [];
      const finishes: Array<Deferred.Deferred<McpCliOutput>> = [];
      const cli = recordingCli([
        {
          name: "example",
          transport: "http",
          url: "https://organization.example.invalid/example",
          scope: "user",
          carriesValues: false,
        },
        {
          name: "team",
          transport: "http",
          url: "https://organization.example.invalid/team",
          scope: "project",
          carriesValues: false,
        },
      ]);
      /** Holds `claude mcp` back while set, as a slow CLI would. */
      let gate: Deferred.Deferred<void> | undefined;
      let held = 0;
      const handlers = yield* connectorHandlers.pipe(
        Effect.provideService(McpCli, {
          ...cli.cli,
          run: (args, cwd) =>
            (gate === undefined
              ? Effect.void
              : Effect.sync(() => held++).pipe(Effect.andThen(Deferred.await(gate)))
            ).pipe(Effect.andThen(cli.cli.run(args, cwd))),
          login: (name, cwd) =>
            Deferred.make<McpCliOutput>().pipe(
              Effect.tap((finish) =>
                Effect.sync(() => {
                  logins.push({ name, cwd });
                  finishes.push(finish);
                }),
              ),
              Effect.flatMap(Deferred.await),
            ),
        }),
      );

      const listed = yield* handlers["connectors.configured"]({ fresh: true });
      expect(listed.agents[0]).toMatchObject({ target: "claude", threadlessSignIn: true });
      expect(
        yield* handlers["connectors.signIn"]({ target: "claude", name: "example", scope: "user" }),
      ).toEqual({ kind: "started" });
      // A `user` server is signed in to from the home folder, where no project's can shadow it.
      yield* waitFor(
        "login",
        Effect.sync(() => logins.length === 1),
      );
      expect(logins).toEqual([{ name: "example", cwd: homedir() }]);
      const waiting = (yield* handlers["connectors.configured"]({ fresh: true })).agents[0]!
        .servers[0]!;
      expect(waiting.signedIn).toBeUndefined();

      const done = { status: 0, stdout: "", stderr: "" };
      yield* Deferred.succeed(finishes[0]!, done);
      yield* waitFor(
        "signed in",
        handlers["connectors.configured"]({ fresh: true }).pipe(
          Effect.map(({ agents }) => agents[0]!.servers[0]!.signedIn === true),
        ),
      );

      // Removing or adding a server of the name forgets it: a new one there isn't signed in.
      yield* handlers["connectors.remove"]({ name: "example", scope: "user", target: "claude" });
      const forgotten = (yield* handlers["connectors.configured"]({ fresh: true })).agents[0]!
        .servers[0]!;
      expect(forgotten.signedIn).toBeUndefined();
      // A login still running then is stopped, so finishing can't bring its outcome back.
      yield* handlers["connectors.signIn"]({ target: "claude", name: "example", scope: "user" });
      yield* waitFor(
        "second login",
        Effect.sync(() => finishes.length === 2),
      );
      yield* handlers["connectors.remove"]({ name: "example", scope: "user", target: "claude" });
      yield* Deferred.succeed(finishes[1]!, done);
      yield* Effect.yieldNow;
      const stopped = (yield* handlers["connectors.configured"]({ fresh: true })).agents[0]!
        .servers[0]!;
      expect(stopped.signedIn).toBeUndefined();
      // So is one started while the removal's command is still running.
      gate = yield* Deferred.make<void>();
      const removing = yield* Effect.forkScoped(
        handlers["connectors.remove"]({ name: "example", scope: "user", target: "claude" }),
      );
      yield* waitFor(
        "removal running",
        Effect.sync(() => held === 1),
      );
      yield* handlers["connectors.signIn"]({ target: "claude", name: "example", scope: "user" });
      yield* waitFor(
        "third login",
        Effect.sync(() => finishes.length === 3),
      );
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(removing);
      gate = undefined;
      yield* Deferred.succeed(finishes[2]!, done);
      yield* Effect.yieldNow;
      const raced = (yield* handlers["connectors.configured"]({ fresh: true })).agents[0]!
        .servers[0]!;
      expect(raced.signedIn).toBeUndefined();

      // A project's server signs in from that project, and a failure says why without the page.
      const failing = yield* connectorHandlers.pipe(
        Effect.provideService(McpCli, {
          ...cli.cli,
          login: () =>
            Effect.succeed({
              status: 1,
              stdout:
                "If the browser didn't open, visit:\n  https://idp.example/authorize?state=abc\n" +
                '\u001b[31mCouldn\'t complete authentication for "team": Authentication timeout\u001b[0m',
              stderr: "",
            }),
        }),
      );
      yield* failing["connectors.signIn"]({
        target: "claude",
        name: "team",
        cwd: "/work/repo",
        scope: "project",
      });
      yield* waitFor(
        "failed",
        failing["connectors.configured"]({ cwd: "/work/repo" }).pipe(
          Effect.map(({ agents }) => agents[0]!.servers[1]!.signInFailed !== undefined),
        ),
      );
      const team = (yield* failing["connectors.configured"]({ cwd: "/work/repo" })).agents[0]!
        .servers[1]!;
      expect(team.signInFailed).toBe(
        'Couldn\'t complete authentication for "team": Authentication timeout',
      );
      expect(team.signedIn).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("lists the claude.ai connectors last seen, or those used before, with no thread", () =>
    Effect.gen(function* () {
      const handlers = yield* connectorHandlers.pipe(
        Effect.provideService(McpCli, {
          ...recordingCli([server("github")]).cli,
          everConnected: Effect.succeed(["linear", "Atlassian"]),
        }),
      );
      const claude = Effect.map(
        handlers["connectors.configured"]({ fresh: true }),
        ({ agents }) => agents[0]!,
      );

      // Before any Claude thread has said, the ones Claude Code connected before, state unknown.
      const before = yield* claude;
      expect(before.claudeAiFrom).toBe("history");
      expect(hosted(before)).toEqual([
        ["linear", undefined, true, false],
        ["Atlassian", undefined, true, false],
      ]);
      // A running thread's are live, and its report is kept.
      const thread = yield* liveThreadOn("claude");
      const live = yield* claude;
      expect(live.claudeAiFrom).toBe("thread");
      expect(hosted(live)).toEqual([["linear", false, true, false]]);
      // Once it has stopped, the page shows what it last said, as of then.
      const runtimes = yield* ThreadRuntimes;
      yield* runtimes.close(thread.id);
      const after = yield* claude;
      expect(after.claudeAiFrom).toBe("lastSeen");
      expect(hosted(after)).toEqual([["linear", false, true, true]]);
      expect(after.servers.map((s) => s.name)).toEqual(["github", "linear"]);
    }).pipe(Effect.provide(SeenTestLayer)),
  );

  it.effect("signs in to a claude.ai connector with no thread through claude.ai's page", () =>
    Effect.gen(function* () {
      const logins: Array<ReadonlyArray<string>> = [];
      let output: McpCliOutput = {
        status: 0,
        stdout:
          "If the browser didn't open, visit:\n  \u001b]8;;https://claude.ai/api/organizations/o/mcp/start-auth/s?product_surface=cli\u0007https://claude.ai/api/organizations/o/mcp/start-auth/s?product_surface=cli\u001b]8;;\u0007\nOnce authorized on claude.ai, the connector will be available the next time you start Claude Code.\n",
        stderr: "",
      };
      const cli = {
        ...recordingCli().cli,
        connectorLogin: (name: string) =>
          Effect.sync(() => {
            logins.push(connectorLoginArgs(name));
            return output;
          }),
      };
      const handlers = yield* connectorHandlers.pipe(Effect.provideService(McpCli, cli));
      const runtimes = yield* ThreadRuntimes;
      const signIn = handlers["connectors.signIn"]({
        target: "claude",
        name: "claude.ai Atlassian",
        scope: "claudeai",
      });

      expect(yield* signIn).toEqual({
        kind: "onClaudeAi",
        authorizationUrl:
          "https://claude.ai/api/organizations/o/mcp/start-auth/s?product_surface=cli",
      });
      expect(logins).toEqual([["mcp", "login", "--no-browser", "claude.ai Atlassian"]]);

      // A Claude thread started before the user finishes is reconnected now and then.
      yield* handlers["connectors.signIn"]({ target: "claude", name: "linear", scope: "claudeai" });
      const fake = yield* FakeAgentControl;
      const thread = yield* liveThreadOn("claude");
      yield* TestClock.adjust(CONNECTOR_RECONNECT_EVERY_MS);
      yield* waitFor(
        "a reconnect",
        fake
          .latest(thread.id)
          .pipe(Effect.map((session) => session.connectorCalls.includes("reconnect:linear"))),
      );
      yield* runtimes.close(thread.id);

      output = {
        status: 1,
        stdout: "",
        stderr:
          "Couldn't build the claude.ai authorization link for \"claude.ai Atlassian\". Make sure you're signed in (`claude login`).",
      };
      expect((yield* Effect.flip(signIn)).message).toBe(
        "Couldn't start signing in to claude.ai Atlassian: Couldn't build the claude.ai authorization link for \"claude.ai Atlassian\". Make sure you're signed in (`claude login`).",
      );
      expect(logins).toHaveLength(3);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it("masks a credential left in a URL or a command's arguments", () => {
    expect(
      presentable({
        name: "x",
        transport: "stdio",
        command: "npx",
        args: ["-y", "server", "--api-key", "abc123", "--token=hunter2hunter2", "--port", "80"],
        scope: "user",
        carriesValues: false,
      }),
    ).toMatchObject({
      args: ["-y", "server", "--api-key", "••••", "--token=[redacted]", "--port", "80"],
      carriesValues: true,
    });
    // A repo's config can name a credential anything, so every query value and the userinfo go,
    // and the server counts as carrying values: the UI's copy of it isn't the whole address.
    expect(
      remote("https://user:hunter2@organization.example.invalid/mcp?auth=hunter2&v=1#frag"),
    ).toMatchObject({
      url: "https://organization.example.invalid/mcp?auth=••••&v=••••",
      carriesValues: true,
    });
    expect(remote("https://organization.example.invalid/sk-abcdefghijklmnopqrstu/mcp").url).toBe(
      "https://organization.example.invalid/[redacted]/mcp",
    );
    expect(remote("https://organization.example.invalid:8443/example")).toEqual({
      name: "y",
      transport: "http",
      url: "https://organization.example.invalid:8443/example",
      scope: "project",
      carriesValues: false,
    });
    expect(remote("//user:hunter2@not a url?token=hunter2").url).not.toContain("hunter2");
  });
});

const seenStatus = (name: string, state: SeenConnector["status"], scope = "claudeai") => ({
  name,
  status: state,
  scope,
});

const printed = (stdout: string) => ({ status: 0, stdout, stderr: "" });

const report = (
  connectors: ReadonlyArray<ConnectorStatus>,
  over: { detailed?: boolean; whole?: boolean } = {},
) => ({ detailed: true, whole: true, ...over, connectors });

describe("claude.ai connectors seen", () => {
  it("keeps a whole report's connectors, and lays a partial one over what it has", () => {
    const first = mergeSeen(
      [],
      report([
        seenStatus("A", "connected"),
        seenStatus("B", "needs-auth"),
        seenStatus("files", "connected", "user"),
      ]),
      1_000,
    );
    expect(first).toEqual([
      { name: "A", status: "connected", seenAt: 1_000 },
      { name: "B", status: "needs-auth", seenAt: 1_000 },
    ]);
    // A turn's init, or an orchestrator given only some, updates what it names and drops nothing.
    const partial = mergeSeen(
      first!,
      report([seenStatus("B", "connected")], { detailed: false }),
      2_000,
    );
    expect(partial).toEqual([
      { name: "A", status: "connected", seenAt: 1_000 },
      { name: "B", status: "connected", seenAt: 2_000 },
    ]);
    expect(
      mergeSeen(first!, report([seenStatus("C", "pending")], { whole: false }), 2_000),
    ).toEqual([...first!, { name: "C", status: "pending", seenAt: 2_000 }]);
    // A whole, detailed report is the catalogue: a connector it lacks is gone.
    expect(mergeSeen(partial!, report([seenStatus("B", "connected")]), 3_000)).toEqual([
      { name: "B", status: "connected", seenAt: 3_000 },
    ]);
  });

  it("keeps a connector's address, id and tools across a report that doesn't say them", () => {
    const detailed = {
      ...seenStatus("A", "connected"),
      url: "https://mcp.example.invalid/a",
      claudeAi: { id: "mcpsrv_a", claudeSignInRejected: true },
      tools: [{ name: "search", readOnly: true }],
    };
    const first = mergeSeen([], report([detailed]), 1_000);
    // Only what describes the connector is kept, never a passing state like a rejected sign-in.
    expect(first).toEqual([
      {
        name: "A",
        status: "connected",
        seenAt: 1_000,
        url: "https://mcp.example.invalid/a",
        id: "mcpsrv_a",
        tools: [{ name: "search", readOnly: true }],
      },
    ]);
    // A turn's init names only the state; the rest stays from the earlier report.
    const lapsed = mergeSeen(
      first!,
      report([seenStatus("A", "needs-auth")], { detailed: false }),
      2_000,
    );
    expect(lapsed).toEqual([{ ...first![0], status: "needs-auth", seenAt: 2_000 }]);
    // A new address is a change worth writing at once.
    expect(
      mergeSeen(first!, report([{ ...detailed, url: "https://mcp.example.invalid/b" }]), 1_500),
    ).toMatchObject([{ url: "https://mcp.example.invalid/b" }]);
  });

  it("writes nothing for a report that names no connector, or changes nothing for a while", () => {
    const kept = [{ name: "A", status: "connected" as const, seenAt: 1_000 }];
    expect(mergeSeen(kept, report([]), 2_000)).toBeUndefined();
    expect(
      mergeSeen(kept, report([seenStatus("files", "connected", "user")]), 2_000),
    ).toBeUndefined();
    expect(mergeSeen(kept, report([seenStatus("A", "connected")]), 1_000 + 60_000)).toBeUndefined();
    expect(
      mergeSeen(kept, report([seenStatus("A", "connected")]), 1_000 + SEEN_REWRITE_MS),
    ).toEqual([{ name: "A", status: "connected", seenAt: 1_000 + SEEN_REWRITE_MS }]);
  });

  it("finds claude.ai's page in what claude mcp login printed, terminal link or not", () => {
    const page = "https://claude.ai/api/organizations/o/mcp/start-auth/s?product_surface=cli";
    expect(connectorSignInPage(printed(`Visit this URL to authorize:\n  ${page}\n`))).toBe(page);
    expect(
      connectorSignInPage(printed(`Visit:\n  \u001b]8;;${page}\u0007${page}\u001b]8;;\u0007\n`)),
    ).toBe(page);
    expect(connectorSignInPage(printed("Opening browser to authorize…\n"))).toBeUndefined();
  });
});
