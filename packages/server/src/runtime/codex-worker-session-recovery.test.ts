import { describe, expect, it } from "@effect/vitest";
import {
  CodexHost,
  CodexHostLayer,
  CodexServers,
  CodexServersLive,
  type CodexServer,
} from "@gram/agents/codex";
import { GatewayKeyProvider } from "@gram/agents";
import { captureLogs } from "@gram/agents/testing/logs";
import { AgentUnavailable, ProfileId, ThreadId } from "@gram/contracts";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { AgentHosts } from "./agent-hosts.ts";
import { FakeAgentAdapter, FakeAgentControl } from "./fake-agent.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { makeRuntimeTestLayer } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

type Record = {
  pid: number;
  msg: {
    method?: string;
    opened?: string;
    exited?: boolean;
    observedExit?: boolean;
    heldRpc?: string;
    params?: { threadId?: string };
  };
};

/** Invented keyless stdio children: no host auth, paid inference, GitHub login or persistent store. */
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gram-worker-recovery-")));
  const binary = join(root, "codex"),
    shell = join(root, "shell"),
    logPath = join(root, "protocol.jsonl");
  const log = (): Record[] =>
    readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record);
  writeFileSync(
    binary,
    `#!${process.execPath}\n${readFileSync(new URL("../../../agents/fixtures/mcp-restart/codex-cli.cjs", import.meta.url), "utf8")}`,
  );
  writeFileSync(logPath, "");
  writeFileSync(join(root, "invented-config.json"), "{}");
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: root,
    CODEX_HOME: root,
    GRAM_RESTART_LOG: logPath,
    GRAM_RESTART_EXACT_MARKERS: "1",
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
  const profile = ProfileId.make("invented-profile"),
    otherProfile = ProfileId.make("invented-other-profile");
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
            writeFileSync(join(home, "invented-config.json"), "{}");
            writeFileSync(join(home, "config.toml"), "# Invented owned config\n");
            return home;
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(GatewayKeyProvider)({
        credentials: (id) =>
          id === profile || id === otherProfile
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
                new AgentUnavailable({ agent: "codex", message: "No gateways in keyless fixture" }),
              ),
      }),
    ),
  );
  const sessionServers = new Map<ThreadId, CodexServer>();
  const agents = Layer.effectContext(
    Effect.gen(function* () {
      const original = yield* CodexHost,
        hosts = yield* AgentHosts,
        control = yield* FakeAgentControl,
        servers = yield* CodexServers,
        lifetime = yield* Effect.scope;
      const observed = new Set<CodexServer>();
      const host = {
        ...original,
        open: (options: Parameters<typeof original.open>[0]) =>
          original.open(options).pipe(
            Effect.tap((session) =>
              Effect.gen(function* () {
                const server = session.configOwner as CodexServer;
                sessionServers.set(options.threadId, server);
                if (observed.has(server)) return;
                observed.add(server);
                const pid = log().findLast((v) => v.msg.opened)!.pid;
                // Layer-lifetime listener has no retain: records the adapter's actual child EXIT callback.
                yield* server
                  .subscribe("invented-exit-observer", {
                    message: () => {},
                    exit: () =>
                      appendFileSync(
                        logPath,
                        JSON.stringify({ pid, msg: { observedExit: true } }) + "\n",
                      ),
                  })
                  .pipe(Effect.provideService(Scope.Scope, lifetime));
              }),
            ),
          ),
      };
      return Context.make(AgentHosts, {
        get: (agent) => (agent === "codex" ? Effect.succeed(host) : hosts.get(agent)),
      }).pipe(
        Context.add(FakeAgentControl, control),
        Context.add(CodexServers, servers),
        Context.add(CodexHost, host),
      );
    }),
  ).pipe(Layer.provide(codex), Layer.provide(FakeAgentAdapter));
  return {
    root,
    profile,
    otherProfile,
    log,
    layer: makeRuntimeTestLayer(undefined, undefined, undefined, agents).pipe(
      Layer.provideMerge(agents),
    ),
    sessionServers,
  };
};
const withFixture = <A, E, R>(body: (f: ReturnType<typeof fixture>) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(fixture),
    (f) =>
      body(f).pipe(
        Effect.provide(f.layer),
        Effect.tap(() =>
          Effect.sync(() => {
            const started = new Set(
              f
                .log()
                .filter((v) => v.msg.method === "initialize")
                .map((v) => v.pid),
            );
            const exited = new Set(
              f
                .log()
                .filter((v) => v.msg.exited)
                .map((v) => v.pid),
            );
            expect(exited).toEqual(started);
          }),
        ),
      ),
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
const ownedScope = Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void));
const pidFor = (f: ReturnType<typeof fixture>, saved: string) =>
  f.log().findLast((v) => v.msg.opened === saved)!.pid;
const openedId = (f: ReturnType<typeof fixture>) =>
  f.log().findLast((v) => v.msg.opened)!.msg.opened!;
const resumesFor = (f: ReturnType<typeof fixture>, saved: string) =>
  f.log().filter((v) => v.msg.method === "thread/resume" && v.msg.params?.threadId === saved);
const alive = (f: ReturnType<typeof fixture>) =>
  new Set(
    f
      .log()
      .filter(
        (v) =>
          v.msg.method === "initialize" && !f.log().some((e) => e.pid === v.pid && e.msg.exited),
      )
      .map((v) => v.pid),
  );

describe.skipIf(process.platform === "win32")("ordinary worker saved-session recovery", () => {
  it.live("resumes once after eviction with an active sibling and metadata operation", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const r = yield* ThreadRuntimes,
          store = yield* ThreadStore,
          servers = yield* CodexServers,
          host = yield* CodexHost;
        yield* r.setSessionPolicy({
          forThread: () => Effect.succeed({ audience: "worker", outwardGate: undefined }),
        });
        const target = yield* create("finish target", f.root);
        yield* status(target.id, "idle");
        const sibling = yield* create("hold active sibling", f.root);
        yield* status(sibling.id, "running");
        const saved = (yield* store.getThread(target.id)).agentSessionId!,
          siblingSaved = (yield* store.getThread(sibling.id)).agentSessionId!;
        const targetPid = pidFor(f, saved),
          siblingPid = pidFor(f, siblingSaved);
        const siblingServer = f.sessionServers.get(sibling.id)!,
          metadataServer = yield* servers.acquire(undefined, "user");
        writeFileSync(join(f.root, "invented-hold-rpc"), "1");
        const metadata = yield* host.listModels().pipe(Effect.forkScoped);
        yield* waitFor(
          "metadata RPC held",
          Effect.sync(() => f.log().some((v) => v.msg.heldRpc === "model/list")),
        );
        const metadataPid = f.log().findLast((v) => v.msg.heldRpc === "model/list")!.pid;
        yield* r.updateThread(target.id, (t) => ({ ...t, parked: true }));
        yield* status(target.id, "cold");
        yield* r.updateThread(target.id, (t) => ({ ...t, parked: false }));
        yield* r.send(target.id, { text: "resume saved worker" });
        yield* waitFor(
          "worker resume settles",
          r.status(target.id).pipe(Effect.map((s) => s === "idle" || s === "error")),
        );
        expect((yield* store.getThread(target.id)).lastError).toBeUndefined();
        expect(yield* r.status(target.id)).toBe("idle");
        expect((yield* store.getThread(target.id)).agentSessionId).toBe(saved);
        const resumes = resumesFor(f, saved);
        expect(resumes).toHaveLength(1);
        expect(resumes[0]!.pid).not.toBe(targetPid);
        expect(
          f.log().findIndex((v) => v.pid === targetPid && v.msg.observedExit),
        ).toBeGreaterThanOrEqual(0);
        expect(f.log().findIndex((v) => v.pid === targetPid && v.msg.observedExit)).toBeLessThan(
          f
            .log()
            .findIndex((v) => v.msg.method === "thread/resume" && v.msg.params?.threadId === saved),
        );
        expect(f.log().some((v) => v.pid === siblingPid && v.msg.exited)).toBe(false);
        expect(f.log().some((v) => v.pid === metadataPid && v.msg.exited)).toBe(false);
        expect(yield* r.status(sibling.id)).toBe("running");
        yield* siblingServer.rpc.request("thread/read", { threadId: `stream:${siblingSaved}` });
        yield* waitFor(
          "sibling streams",
          store
            .listMessages(sibling.id)
            .pipe(
              Effect.map((ms) =>
                ms.some((m) =>
                  m.parts.some((p) => p.type === "text" && p.text.includes("still streaming")),
                ),
              ),
            ),
        );
        yield* metadataServer.rpc.request("thread/read", { threadId: "release-rpc:" });
        expect(yield* Fiber.join(metadata)).toEqual([]);
        rmSync(join(f.root, "invented-hold-rpc"));
        expect(yield* store.listTurns(target.id)).toHaveLength(2);
        expect(new Set([siblingPid, metadataPid, resumes[0]!.pid]).size).toBe(3);
        expect(alive(f).size).toBe(3);
        // Repeated eviction replaces only the target child, never accumulating live children or starts.
        for (let n = 0; n < 2; n++) {
          const oldPid = pidFor(f, saved);
          yield* r.updateThread(target.id, (t) => ({ ...t, parked: true }));
          yield* status(target.id, "cold");
          yield* metadataServer.rpc.request("thread/read", { threadId: "barrier:" });
          expect(resumesFor(f, saved)).toHaveLength(n + 1); // manual park does not auto-wake
          yield* r.updateThread(target.id, (t) => ({ ...t, parked: false }));
          yield* r.send(target.id, { text: "another saved worker follow-up" });
          yield* status(target.id, "idle");
          expect(resumesFor(f, saved)).toHaveLength(n + 2);
          expect(f.log().findIndex((v) => v.pid === oldPid && v.msg.observedExit)).toBeLessThan(
            f
              .log()
              .findIndex(
                (v) =>
                  v.msg.method === "thread/resume" &&
                  v.msg.params?.threadId === saved &&
                  v.pid !== oldPid &&
                  v.pid === pidFor(f, saved),
              ),
          );
          expect((yield* store.getThread(target.id)).agentSessionId).toBe(saved);
          expect(alive(f).size).toBe(3);
        }
        // Cancel affects only the target turn; it neither starts a replacement nor wakes parked work.
        const opens = f.log().filter((v) => v.msg.opened === saved).length;
        yield* r.send(target.id, { text: "hold cancellable worker" });
        yield* status(target.id, "running");
        yield* r.interrupt(target.id);
        yield* status(target.id, "idle");
        expect(f.log().filter((v) => v.msg.opened === saved)).toHaveLength(opens);
        expect(yield* r.status(sibling.id)).toBe("running");
        expect(yield* store.listTurns(target.id)).toHaveLength(5);
        expect(f.log().filter((v) => v.msg.method === "thread/start")).toHaveLength(2);
      }),
    ),
  );
});

describe.skipIf(process.platform === "win32")("worker partition ownership boundaries", () => {
  it.live(
    "shares same-thread scopes, refuses a competing writer, and recovers after exact child EXIT",
    () =>
      withFixture((f) =>
        Effect.gen(function* () {
          const host = yield* CodexHost,
            servers = yield* CodexServers;
          const a = yield* ownedScope,
            a2 = yield* ownedScope,
            replacement = yield* ownedScope;
          const id = ThreadId.make("invented-worker-owner"),
            options = { threadId: id, cwd: f.root, audience: "worker" as const };
          const first = yield* host.open(options).pipe(Effect.provideService(Scope.Scope, a));
          const saved = openedId(f),
            pid = pidFor(f, saved);
          const second = yield* host
            .open({ ...options, resumeId: saved })
            .pipe(Effect.provideService(Scope.Scope, a2));
          expect(first.configOwner).toBe(second.configOwner);
          expect(yield* servers.acquire(undefined, "user", id)).toBe(first.configOwner);
          const before = resumesFor(f, saved).length;
          const refusal = yield* host
            .open({
              ...options,
              threadId: ThreadId.make("invented-competing-worker"),
              resumeId: saved,
            })
            .pipe(Effect.scoped, Effect.flip);
          expect(refusal.message).toContain("Gram scope(s) still open");
          expect(resumesFor(f, saved)).toHaveLength(before);
          yield* Scope.close(a, Exit.void);
          expect(
            f
              .log()
              .filter(
                (v) => v.msg.method === "thread/unsubscribe" && v.msg.params?.threadId === saved,
              ),
          ).toHaveLength(0);
          expect(yield* first.configCurrent!).toBe(true);
          // Owned process exits unexpectedly while its other Gram scope is still held.
          yield* f.sessionServers
            .get(id)!
            .rpc.request("thread/read", { threadId: `exit:${saved}` });
          yield* waitFor(
            "adapter observes exact dead owner",
            Effect.sync(() => f.log().some((v) => v.pid === pid && v.msg.observedExit)),
          );
          const resumed = yield* host
            .open({ ...options, resumeId: saved })
            .pipe(Effect.provideService(Scope.Scope, replacement));
          expect(pidFor(f, saved)).not.toBe(pid);
          expect(resumed.configOwner).not.toBe(first.configOwner);
          expect(resumesFor(f, saved)).toHaveLength(before + 1);
          // Old retained scope's finalizer cannot evict the replacement.
          yield* Scope.close(a2, Exit.void);
          expect(yield* resumed.configCurrent!).toBe(true);
          yield* resumed.send({ text: "still usable after old finalizer" });
        }),
      ),
  );

  it.live(
    "a closed shared writer fences worker partitions and cancelled deliberate waits until original EXIT",
    () =>
      withFixture((f) =>
        Effect.gen(function* () {
          const host = yield* CodexHost,
            servers = yield* CodexServers;
          const target = yield* ownedScope,
            sibling = yield* ownedScope;
          const id = ThreadId.make("invented-shared-worker");
          yield* host
            .open({ threadId: id, cwd: f.root })
            .pipe(Effect.provideService(Scope.Scope, target));
          const saved = openedId(f),
            pid = pidFor(f, saved);
          yield* host
            .open({ threadId: ThreadId.make("invented-shared-sibling"), cwd: f.root })
            .pipe(Effect.provideService(Scope.Scope, sibling));
          const old = yield* servers.acquire(undefined, "user");
          yield* Scope.close(target, Exit.void);
          const options = {
            threadId: id,
            cwd: f.root,
            audience: "worker" as const,
            resumeId: saved,
          };
          const refuse = () =>
            host.open(options).pipe(
              Effect.scoped,
              Effect.flip,
              Effect.tap((e) =>
                Effect.sync(() => {
                  expect(e.message).toContain("Resume was refused");
                  expect(e.message).toContain("thread/closed does not prove writer release");
                }),
              ),
            );
          yield* refuse();
          const waiting = yield* Deferred.make<void>();
          const pending = yield* host
            .open({
              ...options,
              waitForPreviousSession: {
                onWait: Deferred.succeed(waiting, undefined).pipe(Effect.asVoid),
              },
            })
            .pipe(Effect.scoped, Effect.forkScoped);
          yield* Deferred.await(waiting);
          yield* Fiber.interrupt(pending);
          yield* refuse();
          expect(resumesFor(f, saved)).toHaveLength(0);
          expect(f.log().some((v) => v.pid === pid && v.msg.exited)).toBe(false);
          // The retained shared sibling remains usable throughout cancellation/refusal.
          yield* old.rpc.request("thread/read", { threadId: "barrier:" });
          const acceptedScope = yield* ownedScope;
          const waitAgain = yield* Deferred.make<void>();
          const accepted = yield* host
            .open({
              ...options,
              waitForPreviousSession: {
                onWait: Deferred.succeed(waitAgain, undefined).pipe(Effect.asVoid),
              },
            })
            .pipe(Effect.provideService(Scope.Scope, acceptedScope), Effect.forkScoped);
          yield* Deferred.await(waitAgain);
          yield* Scope.close(sibling, Exit.void);
          yield* Fiber.join(accepted);
          expect(resumesFor(f, saved)).toHaveLength(1);
          expect(f.log().some((v) => v.pid === pid && v.msg.observedExit)).toBe(true);
          expect(f.log().filter((v) => v.msg.method === "initialize")).toHaveLength(2);
          expect(alive(f).size).toBe(1);
        }),
      ),
  );

  it.live.each(["invalidate", "retire", "retireAll"] as const)(
    "%s retires worker/root/shared partitions on both homes while operation holds remain usable",
    (method) =>
      withFixture((f) =>
        Effect.gen(function* () {
          const host = yield* CodexHost,
            servers = yield* CodexServers;
          const entries = [];
          for (const home of ["user", "gateway"] as const) {
            for (const audience of ["worker", "orchestrator"] as const) {
              const scope = yield* ownedScope,
                threadId = ThreadId.make(`invented-${home}-${audience}`);
              const session = yield* host
                .open({
                  threadId,
                  cwd: f.root,
                  audience,
                  codexHome: home,
                  model: { agent: "codex", model: "default", profileId: f.profile },
                })
                .pipe(Effect.provideService(Scope.Scope, scope));
              const server = yield* servers.acquire(f.profile, home, threadId),
                saved = openedId(f),
                pid = pidFor(f, saved);
              expect(session.configOwner).toBe(server);
              for (const path of server.generated) rmSync(path);
              // The next acquire writes them again, and says it did.
              const restored = captureLogs();
              expect(
                yield* servers
                  .acquire(f.profile, home, threadId)
                  .pipe(Effect.provide(restored.layer)),
              ).toBe(server);
              expect(restored.warnings().map((log) => log.message)).toEqual(
                server.generated.length === 0
                  ? []
                  : [
                      expect.stringContaining(
                        `codex gateway home lost ${server.generated.join(", ")} while`,
                      ),
                    ],
              );
              expect(server.generated.every((path) => existsSync(path))).toBe(true);
              entries.push({ home, partition: threadId, server, scope, pid });
            }
            const scope = yield* ownedScope,
              server = yield* servers.acquire(f.profile, home);
            yield* server.retain.pipe(Effect.provideService(Scope.Scope, scope));
            yield* server.rpc.request("thread/read", { threadId: "barrier:" });
            const pid = f.log().findLast((v) => v.msg.method === "thread/read")!.pid;
            entries.push({ home, partition: undefined, server, scope, pid });
          }
          const otherScope = yield* ownedScope,
            other = yield* servers.acquire(
              f.otherProfile,
              "user",
              ThreadId.make("invented-other-worker"),
            );
          yield* other.retain.pipe(Effect.provideService(Scope.Scope, otherScope));
          const homes = yield* servers.running;
          for (const entry of entries)
            expect(homes.find((v) => v.server === entry.server)?.home).toBe(entry.home);
          const metadata = entries.find((v) => v.home === "user" && v.partition === undefined)!;
          writeFileSync(join(f.root, "invented-hold-rpc"), "1");
          const pending = yield* metadata.server.retain.pipe(
            Effect.andThen(metadata.server.rpc.request("model/list", { includeHidden: false })),
            Effect.scoped,
            Effect.forkScoped,
          );
          yield* waitFor(
            "retained metadata pending",
            Effect.sync(() =>
              f.log().some((v) => v.pid === metadata.pid && v.msg.heldRpc === "model/list"),
            ),
          );
          if (method === "retireAll") yield* servers.retireAll;
          else yield* servers[method](f.profile);
          expect(yield* other.configCurrent).toBe(method !== "retireAll");
          for (const entry of entries) {
            expect(yield* entry.server.configCurrent).toBe(false);
            expect(f.log().some((v) => v.pid === entry.pid && v.msg.exited)).toBe(false);
            yield* entry.server.rpc.request("thread/read", { threadId: "barrier:" });
            const replacement = yield* servers.acquire(f.profile, entry.home, entry.partition);
            expect(replacement).not.toBe(entry.server);
            yield* Scope.close(entry.scope, Exit.void);
            if (entry !== metadata)
              yield* waitFor(
                "unused retired child exits",
                Effect.sync(() => f.log().some((v) => v.pid === entry.pid && v.msg.exited)),
              );
            expect(yield* servers.acquire(f.profile, entry.home, entry.partition)).toBe(
              replacement,
            );
            expect(yield* replacement.configCurrent).toBe(true);
          }
          expect(f.log().some((v) => v.pid === metadata.pid && v.msg.exited)).toBe(false);
          // Operation cancellation releases only its hold, not another partition's child.
          yield* Fiber.interrupt(pending);
          yield* waitFor(
            "cancelled metadata releases retired child",
            Effect.sync(() => f.log().some((v) => v.pid === metadata.pid && v.msg.exited)),
          );
          expect(alive(f).size).toBe(7); // six current replacements plus the other profile
        }),
      ),
  );
});
