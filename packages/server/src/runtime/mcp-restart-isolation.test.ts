import { describe, expect, it } from "@effect/vitest";
import { CodexHost, CodexHostLayer, CodexServers, CodexServersLive } from "@gram/agents/codex";
import { ClaudeHost, ClaudeHostLive } from "@gram/agents/claude";
import { GatewayKeyProvider } from "@gram/agents";
import { captureLogs, type CapturedLogs } from "@gram/agents/testing/logs";
import { AgentUnavailable, ProfileId, type ThreadId } from "@gram/contracts";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { AgentHosts } from "./agent-hosts.ts";
import { FakeAgentAdapter, FakeAgentControl } from "./fake-agent.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { makeRuntimeTestLayer, TEST_CONFIG } from "./test-harness.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { CheckoutService, TurnHooks } from "./hooks.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

/** `logs` takes the runtime's log lines; by default it keeps them, printing only warnings. */
const fixture = (logs: CapturedLogs) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gram-mcp-restart-")));
  const binary = join(root, "codex"),
    shell = join(root, "shell"),
    log = join(root, "protocol.jsonl");
  writeFileSync(
    binary,
    `#!${process.execPath}\n${readFileSync(new URL("../../../agents/fixtures/mcp-restart/codex-cli.cjs", import.meta.url), "utf8")}`,
  );
  writeFileSync(log, "");
  writeFileSync(
    join(root, "invented-config.json"),
    JSON.stringify({ alpha: { command: "invented" } }),
  );
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: root,
    CODEX_HOME: root,
    GRAM_RESTART_LOG: log,
  };
  writeFileSync(
    shell,
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(
      `\0__SB_PROBE__\0${binary}\n\0__SB_ENV__\0${Object.entries(env)
        .map(([k, v]) => `${k}=${v}\0`)
        .join("")}`,
    )});`,
  );
  chmodSync(binary, 0o755);
  chmodSync(shell, 0o755);
  const profile = ProfileId.make("invented-gateway");
  const userProfile = ProfileId.make("invented-user-profile");
  const keys = Layer.succeed(GatewayKeyProvider)({
    credentials: (id) =>
      id === profile || id === userProfile
        ? Effect.succeed({
            profile: {
              id,
              name: "Invented",
              baseURL: "http://127.0.0.1:9/v1",
              keyRef: "invented",
              models: [],
            },
            key: Redacted.make("invented-key"),
          })
        : Effect.fail(
            new AgentUnavailable({
              agent: "codex",
              message: "No such invented gateway in owned restart fixture",
            }),
          ),
  });
  const claudeRoot = join(root, "claude");
  mkdirSync(claudeRoot);
  const claudeBinary = join(claudeRoot, "claude"),
    claudeShell = join(claudeRoot, "shell");
  writeFileSync(
    claudeBinary,
    `#!${process.execPath}\n${readFileSync(new URL("../../../agents/fixtures/subscriptions/claude-cli.cjs", import.meta.url), "utf8")}`,
  );
  const claudeEnv = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: claudeRoot,
    CLAUDE_CONFIG_DIR: claudeRoot,
    GRAM_FIXTURE_SUBSCRIPTION_ONLY: "0",
    GRAM_FIXTURE_AUTH: join(claudeRoot, "invented-auth"),
    GRAM_FIXTURE_LOG: join(claudeRoot, "protocol.jsonl"),
    GRAM_FIXTURE_SIGNED_OUT: join(claudeRoot, "absent"),
    GRAM_FIXTURE_FAIL_START: join(claudeRoot, "absent"),
    GRAM_FIXTURE_RELEASE_REPLY: join(claudeRoot, "absent"),
  };
  writeFileSync(claudeEnv.GRAM_FIXTURE_AUTH, "invented");
  writeFileSync(
    claudeShell,
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(
      `\0__SB_PROBE__\0${claudeBinary}\n\0__SB_ENV__\0${Object.entries(claudeEnv)
        .map(([k, v]) => `${k}=${v}\0`)
        .join("")}`,
    )});`,
  );
  chmodSync(claudeBinary, 0o755);
  chmodSync(claudeShell, 0o755);
  const claude = ClaudeHostLive({
    settingSources: [],
    startupTimeoutMs: 2000,
    environment: { shell: claudeShell },
  }).pipe(Layer.provide(keys));
  const codex = CodexHostLayer().pipe(
    Layer.provideMerge(
      CodexServersLive({
        binaryPath: binary,
        shell,
        startupTimeoutMs: 2000,
        threadCloseTimeoutMs: 50,
        gatewayHome: () =>
          Effect.sync(() => {
            const home = join(root, "gateway");
            mkdirSync(home, { recursive: true });
            writeFileSync(
              join(home, "invented-config.json"),
              readFileSync(join(root, "invented-config.json")),
            );
            writeFileSync(join(home, "config.toml"), "# Owned invented gateway config\n");
            return home;
          }),
      }),
    ),
    Layer.provide(keys),
  );
  let finalizerFailure: ThreadId | undefined;
  let pauseOpen: { id: ThreadId; wait: Effect.Effect<void> } | undefined;
  const agents = Layer.effectContext(
    Effect.gen(function* () {
      const claudeHost = yield* ClaudeHost;
      const originalHost = yield* CodexHost;
      const host = {
        ...originalHost,
        open: (options: Parameters<typeof originalHost.open>[0]) =>
          Effect.addFinalizer(() =>
            finalizerFailure === options.threadId
              ? Effect.die("Invented session finalizer failure")
              : Effect.void,
          ).pipe(
            Effect.andThen(originalHost.open(options)),
            Effect.tap(() => (pauseOpen?.id === options.threadId ? pauseOpen.wait : Effect.void)),
          ),
      };
      const hosts = yield* AgentHosts,
        control = yield* FakeAgentControl,
        servers = yield* CodexServers;
      // Finish CLI discovery and the initialize handshake during fixture setup. The status
      // poll below bounds turn progress, not the shell/version probes' separate startup bounds.
      yield* servers.acquire(undefined, "user").pipe(Effect.orDie);
      return Context.make(AgentHosts, {
        get: (agent) =>
          agent === "codex"
            ? Effect.succeed(host)
            : agent === "claude"
              ? Effect.succeed(claudeHost)
              : hosts.get(agent),
      }).pipe(
        Context.add(FakeAgentControl, control),
        Context.add(CodexServers, servers),
        Context.add(CodexHost, host),
      );
    }),
  ).pipe(Layer.provide(codex), Layer.provide(claude), Layer.provide(FakeAgentAdapter));
  return {
    root,
    profile,
    userProfile,
    pauseOpen: (value: typeof pauseOpen) => {
      pauseOpen = value;
    },
    failFinalizer: (id: ThreadId | undefined) => {
      finalizerFailure = id;
    },
    layerAt: (file: string) =>
      AppToolRegistry.layer.pipe(
        Layer.provideMerge(ThreadRuntimes.layer),
        Layer.provideMerge(EventHub.layer),
        Layer.provideMerge(ThreadStore.layerSqlite(file)),
        Layer.provideMerge(agents),
        Layer.provideMerge(TurnHooks.layerNoop),
        Layer.provideMerge(CheckoutService.layerNoGit),
        Layer.provideMerge(
          ServerConfig.layer({ ...TEST_CONFIG, dataDir: root, databaseFile: file }),
        ),
        Layer.orDie,
        Layer.provideMerge(logs.layer),
      ),
    layer: makeRuntimeTestLayer(undefined, undefined, undefined, agents).pipe(
      Layer.provideMerge(agents),
      Layer.provideMerge(logs.layer),
    ),
    log: () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              pid: number;
              msg: {
                method?: string;
                opened?: string;
                backgroundPid?: number;
                threadId?: string;
                exited?: boolean;
                boot?: { home: string; gatewayKeyPresent: boolean };
                liveRefresh?: string[];
                heldRpc?: string;
                servers?: string[];
                params?: { threadId?: string; developerInstructions?: string };
              };
            },
        ),
  };
};
const withFixture = <A, E, R>(
  body: (f: ReturnType<typeof fixture>) => Effect.Effect<A, E, R>,
  logs: CapturedLogs = captureLogs({ printWarnings: true }),
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => fixture(logs)),
    (f) => body(f).pipe(Effect.provide(f.layer)),
    (f) => Effect.sync(() => rmSync(f.root, { recursive: true, force: true })),
  );
const waitFor = <A, E, R>(label: string, check: Effect.Effect<A | false | undefined, E, R>) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const v = yield* check;
      if (v !== false && v !== undefined) return v;
      yield* Effect.sleep(10);
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${label}`));
  });
const status = (id: ThreadId, value: string) =>
  Effect.flatMap(ThreadRuntimes, (r) =>
    waitFor(value, r.status(id).pipe(Effect.map((s) => s === value))),
  );
const create = (text: string, cwd: string) =>
  Effect.flatMap(ThreadRuntimes, (r) =>
    r.create({
      projectRoot: cwd,
      checkout: { kind: "main", path: cwd },
      model: { agent: "codex", model: "default" },
      input: { text },
    }),
  );

describe.skipIf(process.platform === "win32")("MCP restart across a shared owned child", () => {
  it.live.each([
    { kind: "config", method: "config/read" },
    { kind: "models", method: "model/list" },
    { kind: "history", method: "thread/list" },
    { kind: "write", method: "config/batchWrite" },
  ] as const)(
    "ordinary eviction preserves an in-flight $kind operation's child until completion",
    ({ kind, method }) =>
      withFixture((f) =>
        Effect.gen(function* () {
          const r = yield* ThreadRuntimes,
            host = yield* CodexHost,
            servers = yield* CodexServers,
            store = yield* ThreadStore;
          const first = yield* create("finish before metadata overlap", f.root);
          yield* status(first.id, "idle");
          const old = yield* servers.acquire(undefined, "user");
          const saved = (yield* store.getThread(first.id)).agentSessionId!;
          const ownerPid = f.log().find((v) => v.msg.opened === saved)!.pid;
          writeFileSync(join(f.root, "invented-hold-rpc"), "");
          const operation =
            kind === "config"
              ? host.mcpConfig!.list({ cwd: f.root, checkSignIn: false })
              : kind === "models"
                ? host.listModels()
                : kind === "history"
                  ? host.listSessions!({ cwd: f.root })
                  : host.mcpConfig!.remove({ name: "alpha", scope: "user", cwd: f.root });
          const pending = yield* Effect.forkScoped(operation);
          yield* waitFor(
            "metadata request is pending on owned child",
            Effect.sync(() => f.log().some((v) => v.pid === ownerPid && v.msg.heldRpc === method)),
          );
          yield* r.updateThread(first.id, (t) => ({ ...t, parked: true }));
          yield* status(first.id, "cold");
          expect(yield* old.configCurrent).toBe(false);
          expect(f.log().some((v) => v.pid === ownerPid && v.msg.exited)).toBe(false);
          // A protocol barrier proves this is a live child, without relying on a delay.
          yield* old.rpc.request("thread/read", { threadId: "release-rpc" });
          const result = yield* Fiber.join(pending);
          if (kind === "config") expect(result).toMatchObject([{ name: "alpha" }]);
          else if (kind === "write") expect(result).toBeUndefined();
          else expect(result).toEqual([]);
          yield* waitFor(
            "metadata releases retired owner after completion",
            Effect.sync(() => f.log().some((v) => v.pid === ownerPid && v.msg.exited)),
          );
        }),
      ),
  );

  it.live("cancelling an in-flight metadata operation permits only its retired owner to exit", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const r = yield* ThreadRuntimes,
          host = yield* CodexHost,
          servers = yield* CodexServers;
        const first = yield* create("finish before cancelled metadata", f.root);
        yield* status(first.id, "idle");
        const old = yield* servers.acquire(undefined, "user");
        writeFileSync(join(f.root, "invented-hold-rpc"), "");
        const pending = yield* Effect.forkScoped(
          host.mcpConfig!.list({ cwd: f.root, checkSignIn: false }),
        );
        yield* waitFor(
          "config read is pending",
          Effect.sync(() => f.log().some((v) => v.msg.heldRpc === "config/read")),
        );
        yield* r.updateThread(first.id, (t) => ({ ...t, parked: true }));
        yield* status(first.id, "cold");
        expect(yield* old.configCurrent).toBe(false);
        expect(f.log().some((v) => v.msg.exited)).toBe(false);
        yield* Fiber.interrupt(pending);
        yield* waitFor(
          "cancelled metadata releases owning child",
          Effect.sync(() => f.log().some((v) => v.msg.exited)),
        );
      }),
    ),
  );

  it.live(
    "ordinary eviction releases an unused owning child before saved conversation resume",
    () =>
      withFixture((f) =>
        Effect.gen(function* () {
          const r = yield* ThreadRuntimes,
            store = yield* ThreadStore;
          const first = yield* create("finish before eviction", f.root);
          yield* status(first.id, "idle");
          const saved = (yield* store.getThread(first.id)).agentSessionId!;
          const ownerPid = f.log().find((v) => v.msg.opened === saved)!.pid;
          // Parking an idle thread uses the same ordinary eviction path as the idle timer.
          yield* r.updateThread(first.id, (t) => ({ ...t, parked: true }));
          yield* status(first.id, "cold");
          yield* r.updateThread(first.id, (t) => ({ ...t, parked: false }));
          yield* r.send(first.id, { text: "resume saved conversation" });
          yield* waitFor(
            "saved conversation follow-up completes",
            store
              .listTurns(first.id)
              .pipe(Effect.map((turns) => turns.length === 2 && turns[1]?.endedAt !== undefined)),
          );
          expect(yield* r.status(first.id)).toBe("idle");
          expect((yield* store.getThread(first.id)).agentSessionId).toBe(saved);
          expect((yield* store.getThread(first.id)).lastError).toBeUndefined();
          expect(f.log().some((v) => v.pid === ownerPid && v.msg.exited)).toBe(true);
          const resumed = f.log().filter((v) => v.msg.method === "thread/resume");
          expect(resumed).toHaveLength(1);
          expect(resumed[0]!.pid).not.toBe(ownerPid);
          expect(resumed[0]!.msg.params?.threadId).toBe(saved);
        }),
      ),
  );

  it.live(
    "ordinary eviction keeps held siblings and refuses resume until their exact child exits",
    () =>
      withFixture((f) =>
        Effect.gen(function* () {
          const r = yield* ThreadRuntimes,
            store = yield* ThreadStore,
            host = yield* CodexHost,
            servers = yield* CodexServers;
          const first = yield* create("finish target", f.root),
            sibling = yield* create("hold active sibling", f.root);
          yield* status(first.id, "idle");
          yield* status(sibling.id, "running");
          const old = yield* servers.acquire(undefined, "user");
          const saved = (yield* store.getThread(first.id)).agentSessionId!,
            siblingSaved = (yield* store.getThread(sibling.id)).agentSessionId!;
          const ownerPid = f.log().find((v) => v.msg.opened === saved)!.pid;
          yield* r.updateThread(first.id, (t) => ({ ...t, parked: true }));
          yield* status(first.id, "cold");
          const fresh = yield* create("replacement child stays held", f.root);
          yield* status(fresh.id, "idle");
          const freshId = (yield* store.getThread(fresh.id)).agentSessionId!;
          const freshPid = f.log().find((v) => v.msg.opened === freshId)!.pid;
          expect(freshPid).not.toBe(ownerPid);
          expect(yield* old.configCurrent).toBe(false);
          expect(f.log().some((v) => v.pid === ownerPid && v.msg.exited)).toBe(false);
          const refusal = yield* host
            .open({ threadId: first.id, cwd: f.root, resumeId: saved })
            .pipe(Effect.scoped, Effect.flip);
          expect(refusal.message).toContain("Resume was refused");
          expect(refusal.message).toContain("thread/closed does not prove writer release");
          expect(f.log().filter((v) => v.msg.method === "thread/resume")).toHaveLength(0);
          yield* old.rpc.request("thread/read", { threadId: `stream:${siblingSaved}` });
          yield* waitFor(
            "held sibling stream persists",
            store
              .listMessages(sibling.id)
              .pipe(
                Effect.map((messages) =>
                  messages.some((m) =>
                    m.parts.some((p) => p.type === "text" && p.text.includes("still streaming")),
                  ),
                ),
              ),
          );
          yield* old.rpc.request("thread/read", { threadId: `complete:${siblingSaved}` });
          yield* status(sibling.id, "idle");
          yield* r.updateThread(sibling.id, (t) => ({ ...t, parked: true }));
          yield* status(sibling.id, "cold");
          yield* waitFor(
            "exact old owning child exits",
            Effect.sync(() => f.log().some((v) => v.pid === ownerPid && v.msg.exited)),
          );
          // An old finalizer must neither retire nor stop the newer cache entry.
          expect(f.log().some((v) => v.pid === freshPid && v.msg.exited)).toBe(false);
          expect(yield* (yield* servers.acquire(undefined, "user")).configCurrent).toBe(true);
          yield* r.updateThread(first.id, (t) => ({ ...t, parked: false }));
          yield* r.send(first.id, { text: "resume after exact owning exit" });
          yield* waitFor(
            "resumed target completes",
            store
              .listTurns(first.id)
              .pipe(Effect.map((turns) => turns.length === 2 && turns[1]?.endedAt !== undefined)),
          );
          expect((yield* store.getThread(first.id)).agentSessionId).toBe(saved);
          expect((yield* store.getThread(first.id)).lastError).toBeUndefined();
          yield* r.send(fresh.id, { text: "replacement sibling still usable" });
          yield* waitFor(
            "replacement sibling completes",
            store
              .listTurns(fresh.id)
              .pipe(Effect.map((turns) => turns.length === 2 && turns[1]?.endedAt !== undefined)),
          );
          expect(
            f
              .log()
              .filter((v) => v.msg.method === "thread/resume" && v.msg.params?.threadId === saved),
          ).toMatchObject([{ pid: freshPid }]);
        }),
      ),
  );

  it.live.each(["error", "cancel"] as const)(
    "invalidates future config after a persisted write's %s exit without losing held sessions",
    (outcome) =>
      withFixture((f) =>
        Effect.gen(function* () {
          const r = yield* ThreadRuntimes,
            store = yield* ThreadStore,
            host = yield* CodexHost,
            servers = yield* CodexServers;
          const held = yield* create("hold ongoing", f.root),
            approval = yield* create("approval", f.root);
          yield* status(held.id, "running");
          yield* status(approval.id, "needsApproval");
          const old = yield* servers.acquire(undefined, "user"),
            saved = (yield* store.getThread(held.id)).agentSessionId!,
            requests = yield* store.listRequests(approval.id);
          writeFileSync(join(f.root, "invented-write-outcome"), outcome);
          const edit = host.mcpConfig!.remove({ name: "alpha", scope: "user", cwd: f.root });
          if (outcome === "error") {
            const failed = yield* edit.pipe(Effect.flip);
            expect(failed.message).toContain("Invented failure after persisted config write");
          } else {
            const request = yield* Effect.forkScoped(edit);
            yield* waitFor(
              "persisted unanswered write",
              Effect.sync(
                () =>
                  Object.keys(
                    JSON.parse(readFileSync(join(f.root, "invented-config.json"), "utf8")),
                  ).length === 0,
              ),
            );
            yield* Fiber.interrupt(request);
          }
          rmSync(join(f.root, "invented-write-outcome"));
          expect(yield* old.configCurrent).toBe(false);
          expect(f.log().filter((v) => v.msg.liveRefresh)).toEqual([]);
          expect(yield* r.status(held.id)).toBe("running");
          expect(yield* store.listRequests(approval.id)).toEqual(requests);
          expect((yield* store.getThread(held.id)).agentSessionId).toBe(saved);
          const future = yield* create("fresh after failed write", f.root);
          yield* status(future.id, "idle");
          expect(
            f
              .log()
              .filter((v) => v.msg.opened)
              .at(-1)!.msg.servers,
          ).toEqual([]);
          expect(f.log().filter((v) => v.msg.exited)).toEqual([]);
          yield* old.rpc.request("thread/read", { threadId: `stream:${saved}` });
          yield* waitFor(
            "continued held stream",
            store
              .listMessages(held.id)
              .pipe(
                Effect.map((messages) =>
                  messages.some((m) =>
                    m.parts.some((p) => p.type === "text" && p.text.includes("still streaming")),
                  ),
                ),
              ),
          );
          yield* r.respond(approval.id, requests[0]!.id, {
            kind: "approval",
            decision: "allow",
            scope: "once",
          });
          yield* status(approval.id, "idle");
          expect(yield* r.status(held.id)).toBe("running");
          expect((yield* r.snapshot).map((summary) => summary.status)).not.toContain("error");
        }),
      ),
    15000,
  );

  it.live(
    "persists MCP removal without refreshing any held child, and fresh sessions read it when automatic restart is off",
    () =>
      withFixture((f) =>
        Effect.gen(function* () {
          const r = yield* ThreadRuntimes,
            store = yield* ThreadStore,
            host = yield* CodexHost,
            servers = yield* CodexServers;
          const shared = yield* create("hold shared", f.root),
            approval = yield* create("approval", f.root);
          const otherUser = yield* r.create({
            projectRoot: f.root,
            checkout: { kind: "main", path: f.root },
            model: { agent: "codex", model: "default", profileId: f.userProfile },
            deferOpen: true,
          });
          yield* r.updateThread(otherUser.id, (thread) => ({ ...thread, codexHome: "user" }));
          yield* r.send(otherUser.id, { text: "hold unrelated user profile" });
          const gateway = yield* r.create({
            projectRoot: f.root,
            checkout: { kind: "main", path: f.root },
            model: { agent: "codex", model: "default", profileId: f.profile },
            input: { text: "hold gateway" },
          });
          const claude = yield* r.create({
            projectRoot: f.root,
            checkout: { kind: "main", path: f.root },
            model: { agent: "claude", model: "default" },
            input: { text: "wait" },
          });
          for (const t of [shared, otherUser, gateway, claude]) yield* status(t.id, "running");
          yield* status(approval.id, "needsApproval");
          const requests = yield* store.listRequests(approval.id);
          const ids = yield* Effect.forEach([shared, approval, otherUser, gateway], (t) =>
            store.getThread(t.id).pipe(Effect.map((v) => v.agentSessionId!)),
          );
          const oldServers = [
            yield* servers.acquire(undefined, "user"),
            yield* servers.acquire(f.userProfile, "user"),
            yield* servers.acquire(f.profile, "gateway"),
          ];
          const opened = f.log().filter((v) => v.msg.opened);
          expect(new Set(opened.map((v) => v.pid)).size).toBe(3);
          expect(opened[0]!.pid).toBe(opened[1]!.pid);
          const boot = f.log().filter((v) => v.msg.boot);
          expect(
            boot.filter((v) => v.msg.boot?.home === "user" && !v.msg.boot.gatewayKeyPresent),
          ).toHaveLength(1);
          expect(boot.filter((v) => v.msg.boot?.gatewayKeyPresent)).toHaveLength(2);
          yield* store.updateSettings((settings) => ({
            ...settings,
            agents: { ...settings.agents, restartOnMcpChange: false },
          }));
          yield* host.mcpConfig!.remove({ name: "alpha", scope: "user", cwd: f.root });
          expect(JSON.parse(readFileSync(join(f.root, "invented-config.json"), "utf8"))).toEqual(
            {},
          );
          expect(yield* r.mcpConfigChanged({ agent: "codex" })).toEqual([]);
          // These oracles fail against the previous writer: its initial reload refreshes shared
          // threads, then a second user-home child reloads and the gateway child writes/reloads too.
          expect(f.log().filter((v) => v.msg.liveRefresh)).toEqual([]);
          expect(f.log().filter((v) => v.msg.method === "config/batchWrite")).toHaveLength(1);
          expect(f.log().filter((v) => v.msg.method === "config/mcpServer/reload")).toHaveLength(0);
          for (const t of [shared, otherUser, gateway, claude])
            expect(yield* r.status(t.id)).toBe("running");
          expect(yield* store.listRequests(approval.id)).toEqual(requests);
          for (const child of f.log().filter((v) => v.msg.backgroundPid))
            expect(() => process.kill(child.msg.backgroundPid!, 0)).not.toThrow();
          for (const server of oldServers) expect(yield* server.configCurrent).toBe(false);
          expect(
            (yield* host.mcpConfig!.list({ cwd: f.root, checkSignIn: false })).map((v) => v.name),
          ).toEqual([]);
          const future = yield* create("fresh user", f.root);
          const futureGateway = yield* r.create({
            projectRoot: f.root,
            checkout: { kind: "main", path: f.root },
            model: { agent: "codex", model: "default", profileId: f.profile },
            input: { text: "fresh gateway" },
          });
          yield* status(future.id, "idle");
          yield* status(futureGateway.id, "idle");
          const later = f
            .log()
            .filter((v) => v.msg.opened)
            .slice(4);
          expect(later).toHaveLength(2);
          for (const v of later) expect(v.msg.servers).toEqual([]);
          expect(
            f.log().filter((v) => v.msg.exited && opened.some((o) => o.pid === v.pid)),
          ).toEqual([]);
          yield* oldServers[0]!.rpc.request("thread/read", { threadId: `stream:${ids[0]}` });
          yield* waitFor(
            "held stream persists",
            store
              .listMessages(shared.id)
              .pipe(
                Effect.map((messages) =>
                  messages.some((m) =>
                    m.parts.some((p) => p.type === "text" && p.text.includes("still streaming")),
                  ),
                ),
              ),
          );
          yield* r.respond(approval.id, requests[0]!.id, {
            kind: "approval",
            decision: "allow",
            scope: "once",
          });
          yield* status(approval.id, "idle");
          for (const [i, server] of oldServers.entries())
            yield* server.rpc.request("thread/read", {
              threadId: `complete:${ids[i === 0 ? 0 : i + 1]}`,
            });
          for (const t of [shared, otherUser, gateway]) yield* status(t.id, "idle");
          yield* r.interrupt(claude.id);
          yield* status(claude.id, "idle");
          yield* r.send(claude.id, { text: "still usable after write" });
          yield* waitFor(
            "Claude follow-up",
            store
              .listTurns(claude.id)
              .pipe(Effect.map((turns) => turns.length === 2 && turns[1]?.endedAt !== undefined)),
          );
          // A target-only supported restart reads removal, but stays behind its old approval sibling's
          // hold. No competing resume/writer or server-wide cancellation can make it look successful.
          yield* r.restartSession(shared.id);
          yield* Effect.sleep(200);
          expect(yield* r.status(shared.id)).toBe("starting");
          expect((yield* store.getThread(shared.id)).lastError).toBeUndefined();
          expect(yield* r.status(approval.id)).toBe("idle");
          const refused = yield* host
            .open({ threadId: shared.id, cwd: f.root, resumeId: ids[0]! })
            .pipe(Effect.scoped, Effect.flip);
          expect(refused.message).toContain("Resume was refused");
          expect(
            f
              .log()
              .filter((v) => v.msg.method === "thread/resume" && v.msg.params?.threadId === ids[0]),
          ).toHaveLength(0);
          yield* r.send(otherUser.id, { text: "hold survives local refusal" });
          yield* status(otherUser.id, "running");
          yield* r.send(gateway.id, { text: "gateway still usable after local refusal" });
          yield* waitFor(
            "held gateway follow-up",
            store
              .listTurns(gateway.id)
              .pipe(Effect.map((turns) => turns.length === 2 && turns[1]?.endedAt !== undefined)),
          );
          yield* r.send(claude.id, { text: "Claude still usable after local refusal" });
          yield* waitFor(
            "Claude after refusal",
            store
              .listTurns(claude.id)
              .pipe(Effect.map((turns) => turns.length === 3 && turns[2]?.endedAt !== undefined)),
          );
          yield* r.close(approval.id);
          yield* status(shared.id, "idle");
          expect((yield* store.getThread(shared.id)).agentSessionId).toBe(ids[0]);
          const log = f.log();
          const reopened = log.filter((v) => v.msg.opened === ids[0]).at(-1)!;
          expect(reopened.msg.servers).toEqual([]);
          expect(log.indexOf(reopened)).toBeGreaterThan(
            log.findIndex((v) => v.msg.exited && v.pid === opened[0]!.pid),
          );
          for (const id of ids.slice(2)) {
            const pid = opened.find((v) => v.msg.opened === id)!.pid;
            expect(log.some((v) => v.pid === pid && v.msg.exited)).toBe(false);
            expect(() => process.kill(pid, 0)).not.toThrow();
          }
          expect(yield* r.status(otherUser.id)).toBe("running");
          yield* oldServers[1]!.rpc.request("thread/read", { threadId: `complete:${ids[2]}` });
          yield* status(otherUser.id, "idle");
          expect((yield* r.snapshot).map((summary) => summary.status)).not.toContain("error");
        }),
      ),
    15000,
  );

  it.live(
    "recovers saved provider identity and queued work after an owned server scope stops during the wait",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => fixture(captureLogs({ printWarnings: true }))),
        (f) =>
          Effect.gen(function* () {
            const file = join(f.root, "owned-gram.db");
            const saved = yield* Effect.gen(function* () {
              const r = yield* ThreadRuntimes,
                store = yield* ThreadStore;
              const first = yield* create("saved exchange", f.root),
                held = yield* create("hold sibling", f.root);
              yield* status(first.id, "idle");
              yield* status(held.id, "running");
              const providerId = (yield* store.getThread(first.id)).agentSessionId!,
                history = (yield* store.listMessages(first.id)).map((m) => m.id);
              yield* r.restartSession(first.id);
              yield* waitFor(
                "replacement initialization",
                Effect.sync(
                  () => f.log().filter((v) => v.msg.method === "initialize").length === 2,
                ),
              );
              yield* r.send(first.id, { text: "persisted while waiting" });
              expect(yield* r.status(first.id)).toBe("starting");
              return { id: first.id, providerId, history };
            }).pipe(Effect.provide(f.layerAt(file)));
            yield* Effect.gen(function* () {
              const r = yield* ThreadRuntimes,
                store = yield* ThreadStore;
              expect((yield* store.getThread(saved.id)).agentSessionId).toBe(saved.providerId);
              expect((yield* store.getThread(saved.id)).lastError).toBeUndefined();
              yield* r.sendQueuedAtBoot;
              yield* waitFor(
                "restored queued completion",
                store
                  .listTurns(saved.id)
                  .pipe(
                    Effect.map((turns) => turns.length === 2 && turns[1]?.endedAt !== undefined),
                  ),
              );
              expect(
                (yield* store.listMessages(saved.id))
                  .slice(0, saved.history.length)
                  .map((m) => m.id),
              ).toEqual(saved.history);
              expect((yield* store.getThread(saved.id)).agentSessionId).toBe(saved.providerId);
              const log = f.log(),
                resume = log.findIndex(
                  (v) =>
                    v.msg.method === "thread/resume" && v.msg.params?.threadId === saved.providerId,
                );
              expect(resume).toBeGreaterThan(log.findIndex((v) => v.msg.exited));
            }).pipe(Effect.provide(f.layerAt(file)));
          }),
        (f) => Effect.sync(() => rmSync(f.root, { recursive: true, force: true })),
      ),
    15000,
  );

  it.live(
    "keeps a workspace policy edit that arrives while a resumed session is opening",
    () =>
      withFixture((f) =>
        Effect.gen(function* () {
          const r = yield* ThreadRuntimes,
            store = yield* ThreadStore,
            servers = yield* CodexServers;
          let instructions = "initial invented instructions";
          yield* r.setSessionPolicy({
            forThread: () =>
              Effect.succeed({ audience: "plain", outwardGate: undefined, instructions }),
          });
          const first = yield* create("saved exchange", f.root),
            held = yield* create("hold sibling", f.root);
          yield* status(first.id, "idle");
          yield* status(held.id, "running");
          const saved = (yield* store.getThread(first.id)).agentSessionId!,
            heldId = (yield* store.getThread(held.id)).agentSessionId!;
          const old = yield* servers.acquire(undefined, "user");
          const ready = yield* Deferred.make<void>();
          f.pauseOpen({ id: first.id, wait: Deferred.await(ready) });
          yield* r.restartSession(first.id);
          yield* waitFor(
            "replacement initialization",
            Effect.sync(() => f.log().filter((v) => v.msg.method === "initialize").length === 2),
          );
          instructions = "changed invented instructions";
          yield* r.mcpConfigChanged({ agent: "codex" });
          yield* old.rpc.request("thread/read", { threadId: `complete:${heldId}` });
          yield* waitFor(
            "replacement resume",
            Effect.sync(() =>
              f
                .log()
                .some((v) => v.msg.method === "thread/resume" && v.msg.params?.threadId === saved),
            ),
          );
          // This sibling already consumed the edit on the fresh child before the paused open installs.
          yield* status(held.id, "idle");
          f.pauseOpen(undefined);
          yield* Deferred.succeed(ready, undefined);
          yield* status(first.id, "idle");

          const resumed = f
            .log()
            .filter((v) => v.msg.method === "thread/resume" && v.msg.params?.threadId === saved);
          expect(resumed).toHaveLength(2);
          expect(resumed[0]!.msg.params?.developerInstructions).toBe(
            "initial invented instructions",
          );
          expect(resumed[1]!.msg.params?.developerInstructions).toBe(
            "changed invented instructions",
          );
        }),
      ),
    15000,
  );

  it.live(
    "reads the latest config when another MCP edit arrives during the owner wait",
    () =>
      withFixture((f) =>
        Effect.gen(function* () {
          const r = yield* ThreadRuntimes,
            store = yield* ThreadStore,
            servers = yield* CodexServers,
            host = yield* CodexHost;
          const first = yield* create("saved exchange", f.root),
            held = yield* create("hold sibling", f.root);
          yield* status(first.id, "idle");
          yield* status(held.id, "running");
          const saved = (yield* store.getThread(first.id)).agentSessionId!,
            heldId = (yield* store.getThread(held.id)).agentSessionId!;
          const old = yield* servers.acquire(undefined, "user");
          yield* host.mcpConfig!.remove({ name: "alpha", scope: "user", cwd: f.root });
          yield* r.mcpConfigChanged({ agent: "codex" });
          yield* waitFor(
            "replacement initialization",
            Effect.sync(() => f.log().filter((v) => v.msg.method === "initialize").length === 2),
          );
          yield* host.mcpConfig!.add(
            { name: "beta", scope: "user", cwd: f.root },
            { type: "stdio", command: "invented-beta", args: [] },
          );
          yield* r.mcpConfigChanged({ agent: "codex" });
          yield* old.rpc.request("thread/read", { threadId: `complete:${heldId}` });
          yield* status(first.id, "idle");
          yield* status(held.id, "idle");
          // Let any pending restart after installation settle; none may strand itself on an unretired child.
          yield* Effect.sleep(200);
          expect(yield* r.status(first.id)).toBe("idle");
          expect((yield* store.getThread(first.id)).agentSessionId).toBe(saved);
          const opened = f.log().filter((v) => v.msg.opened === saved);
          expect(opened.length).toBeGreaterThan(1);
          for (const v of opened.slice(1)) expect(v.msg.servers).toEqual(["beta"]);
        }),
      ),
    15000,
  );

  it.live(
    "can cancel a waiting restart without releasing its writer, then resume saved history after owner exit",
    () =>
      withFixture((f) =>
        Effect.gen(function* () {
          const r = yield* ThreadRuntimes,
            store = yield* ThreadStore,
            servers = yield* CodexServers;
          const first = yield* create("saved exchange", f.root),
            held = yield* create("hold sibling", f.root);
          yield* status(first.id, "idle");
          yield* status(held.id, "running");
          const saved = yield* store.getThread(first.id),
            before = yield* store.listMessages(first.id);
          const old = yield* servers.acquire(undefined, "user");
          const request = yield* Effect.forkScoped(r.restartSession(first.id));
          expect(yield* Fiber.join(request)).toBe("restarting");
          yield* Fiber.interrupt(request);
          yield* waitFor(
            "replacement initialization",
            Effect.sync(() => f.log().filter((v) => v.msg.method === "initialize").length === 2),
          );
          yield* Effect.sleep(200);
          expect(yield* r.status(first.id)).toBe("starting");
          yield* r.close(first.id);
          expect(yield* r.status(held.id)).toBe("running");
          const refused = yield* (yield* CodexHost)
            .open({ threadId: first.id, cwd: f.root, resumeId: saved.agentSessionId! })
            .pipe(Effect.scoped, Effect.flip);
          expect(refused.message).toContain("Resume was refused");
          expect(f.log().filter((v) => v.msg.method === "thread/resume")).toHaveLength(0);
          const heldId = (yield* store.getThread(held.id)).agentSessionId!;
          yield* old.rpc.request("thread/read", { threadId: `stream:${heldId}` });
          yield* r.close(held.id);
          yield* r.create({
            id: first.id,
            projectRoot: f.root,
            checkout: { kind: "main", path: f.root },
            model: saved.model,
            restoreClosedHistory: true,
            resumeSessionId: saved.agentSessionId!,
            input: { text: "continue saved work" },
          });
          yield* status(first.id, "idle");
          expect((yield* store.getThread(first.id)).agentSessionId).toBe(saved.agentSessionId);
          const after = yield* store.listMessages(first.id);
          expect(after.slice(0, before.length).map((m) => m.id)).toEqual(before.map((m) => m.id));
          const log = f.log(),
            resume = log.findIndex((v) => v.msg.method === "thread/resume");
          expect(resume).toBeGreaterThan(log.findIndex((v) => v.msg.exited));
        }),
      ),
    15000,
  );

  it.live(
    "contains restart initialization and session-finalizer failures to the requested session",
    () => {
      const logs = captureLogs();
      return withFixture(
        (f) =>
          Effect.gen(function* () {
            const r = yield* ThreadRuntimes,
              store = yield* ThreadStore,
              servers = yield* CodexServers;
            const first = yield* create("saved exchange", f.root),
              held = yield* create("hold sibling", f.root);
            yield* status(first.id, "idle");
            yield* status(held.id, "running");
            const saved = (yield* store.getThread(first.id)).agentSessionId!;
            const old = yield* servers.acquire(undefined, "user");
            f.failFinalizer(first.id);
            writeFileSync(join(f.root, "invented-refuse-start"), "invented");
            yield* r.restartSession(first.id);
            yield* status(first.id, "error");
            expect(yield* r.status(held.id)).toBe("running");
            expect(f.log().filter((v) => v.msg.method === "thread/resume")).toHaveLength(0);
            rmSync(join(f.root, "invented-refuse-start"));
            f.failFinalizer(undefined);
            const heldId = (yield* store.getThread(held.id)).agentSessionId!;
            yield* old.rpc.request("thread/read", { threadId: `stream:${heldId}` });
            // The failed replacement child's exit does not release the previous child's writer.
            const refused = yield* (yield* CodexHost)
              .open({ threadId: first.id, cwd: f.root, resumeId: saved })
              .pipe(Effect.scoped, Effect.flip);
            expect(refused.message).toContain("Resume was refused");
            yield* r.close(held.id);
            yield* r.restartSession(first.id);
            yield* status(first.id, "idle");
            expect((yield* store.getThread(first.id)).agentSessionId).toBe(saved);
            // The refused start is the one warning, and only for the restarted thread.
            expect(logs.warnings()).toMatchObject([
              {
                message: "agent unavailable",
                annotations: {
                  threadId: first.id,
                  agent: "codex",
                  reason: "startup-failed",
                  unavailable: expect.stringContaining("Invented initialization failure"),
                },
              },
            ]);
          }),
        logs,
      );
    },
    15000,
  );

  it.live(
    "waits for owning-child exit instead of failing every idle session while a sibling runs",
    () =>
      withFixture((f) =>
        Effect.gen(function* () {
          const r = yield* ThreadRuntimes,
            store = yield* ThreadStore,
            servers = yield* CodexServers;
          const first = yield* create("first", f.root),
            second = yield* create("second", f.root),
            held = yield* create("hold sibling", f.root),
            approval = yield* create("approval", f.root);
          yield* status(first.id, "idle");
          yield* status(second.id, "idle");
          yield* status(held.id, "running");
          yield* status(approval.id, "needsApproval");
          const ids = yield* Effect.forEach([first, second, held, approval], (t) =>
            store.getThread(t.id).pipe(Effect.map((v) => v.agentSessionId!)),
          );
          const old = yield* servers.acquire(undefined, "user");
          const original = f.log().filter((v) => v.msg.opened);
          expect(new Set(original.map((v) => v.pid)).size).toBe(1);

          const other = yield* r.create({
            projectRoot: f.root,
            checkout: { kind: "main", path: f.root },
            model: { agent: "claude", model: "default" },
            input: { text: "wait" },
          });
          yield* status(other.id, "running");
          yield* (yield* CodexHost).mcpConfig!.remove({
            name: "alpha",
            scope: "user",
            cwd: "/invented/repo",
          });
          const requests = yield* store.listRequests(approval.id);
          expect(requests).toHaveLength(1);
          yield* r.mcpConfigChanged({ agent: "codex" });
          yield* waitFor(
            "both unsubscribes",
            Effect.sync(() =>
              ids
                .slice(0, 2)
                .every((id) =>
                  f
                    .log()
                    .some(
                      (v) => v.msg.method === "thread/unsubscribe" && v.msg.params?.threadId === id,
                    ),
                ),
            ),
          );
          yield* waitFor(
            "replacement child initialization",
            Effect.sync(() => f.log().filter((v) => v.msg.method === "initialize").length === 2),
          );
          yield* Effect.sleep(200);
          expect(yield* r.status(first.id)).toBe("starting");
          expect(yield* r.status(second.id)).toBe("starting");
          expect(yield* r.status(held.id)).toBe("running");
          expect(yield* r.status(other.id)).toBe("running");
          expect((yield* store.getThread(first.id)).lastError).toBeUndefined();
          expect(yield* store.listRequests(approval.id)).toEqual(requests);
          const child = f.log().find((v) => v.msg.backgroundPid)?.msg.backgroundPid;
          expect(child).toBeDefined();
          expect(() => process.kill(child!, 0)).not.toThrow();
          yield* r.send(first.id, { text: "queued while restarting" });
          expect(f.log().filter((v) => v.msg.method === "thread/resume")).toHaveLength(0);
          yield* old.rpc.request("thread/read", { threadId: `stream:${ids[2]}` });
          yield* waitFor(
            "persisted sibling stream",
            store
              .listMessages(held.id)
              .pipe(
                Effect.map((messages) =>
                  messages.some((m) =>
                    m.parts.some((p) => p.type === "text" && p.text.includes("still streaming")),
                  ),
                ),
              ),
          );
          yield* r.respond(approval.id, requests[0]!.id, {
            kind: "approval",
            decision: "allow",
            scope: "once",
          });
          yield* old.rpc.request("thread/read", { threadId: `complete:${ids[2]}` });
          yield* status(first.id, "idle");
          yield* status(second.id, "idle");
          yield* status(held.id, "idle");
          yield* status(approval.id, "idle");
          yield* waitFor(
            "queued restart turn",
            store
              .listTurns(first.id)
              .pipe(Effect.map((turns) => turns.length === 2 && turns[1]?.endedAt !== undefined)),
          );
          const log = f.log(),
            oldExit = log.findIndex((v) => v.pid === original[0]!.pid && v.msg.exited);
          expect(oldExit).toBeGreaterThan(-1);
          const reopened = log.filter((v) => v.msg.opened && ids.includes(v.msg.opened));
          expect(reopened).toHaveLength(8);
          for (const v of reopened.slice(4)) {
            expect(v.msg.servers).toEqual([]);
            expect(log.indexOf(v)).toBeGreaterThan(oldExit);
          }
          for (const [i, t] of [first, second, held, approval].entries())
            expect((yield* store.getThread(t.id)).agentSessionId).toBe(ids[i]);
          yield* r.interrupt(other.id);
          yield* status(other.id, "idle");
          yield* r.send(other.id, { text: "still usable" });
          yield* waitFor(
            "Claude completion",
            store
              .listTurns(other.id)
              .pipe(Effect.map((turns) => turns.length === 2 && turns[1]?.endedAt !== undefined)),
          );
          expect(yield* r.status(other.id)).toBe("idle");
        }),
      ),
    15000,
  );
});
