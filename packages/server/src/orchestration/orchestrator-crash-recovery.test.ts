import { describe, expect, it } from "@effect/vitest";
import { CodexHost, CodexHostLayer, CodexServers, CodexServersLive } from "@gram/agents/codex";
import { GatewayKeyProvider } from "@gram/agents";
import { AgentUnavailable, ProfileId, ThreadId, type WorkspaceId } from "@gram/contracts";
import {
  chmodSync,
  existsSync,
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
import * as Layer from "effect/Layer";
import * as Duration from "effect/Duration";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Redacted from "effect/Redacted";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { FakeAgentAdapter, FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { Orchestration } from "./service.ts";
import { makeWorld, outboxOf, serverLayer, settle, waitReal, waitStatus } from "./test-harness.ts";

/** Keyless invented CLI on owned HOME/PATH; all GitHub readiness comes from serverLayer's fixed tools. */
const fixture = Effect.gen(function* () {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gram-orchestrator-recovery-")));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(root, { recursive: true, force: true })),
  );
  const binary = join(root, "codex"),
    shell = join(root, "shell"),
    log = join(root, "protocol.jsonl");
  writeFileSync(
    binary,
    `#!${process.execPath}\n${readFileSync(new URL("../../../agents/fixtures/mcp-restart/codex-cli.cjs", import.meta.url), "utf8")}`,
  );
  writeFileSync(log, "");
  writeFileSync(join(root, "invented-config.json"), "{}");
  const env = {
    HOME: root,
    CODEX_HOME: root,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    GRAM_RESTART_LOG: log,
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
            writeFileSync(join(home, "config.toml"), "# Owned invented config\n");
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
                new AgentUnavailable({
                  agent: "codex",
                  message: "No gateways in owned keyless fixture",
                }),
              ),
      }),
    ),
  );
  const agents = Layer.effectContext(
    Effect.gen(function* () {
      const host = yield* CodexHost,
        hosts = yield* AgentHosts,
        control = yield* FakeAgentControl,
        servers = yield* CodexServers;
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
    agents,
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
                exited?: boolean;
                heldRpc?: string;
                params?: { threadId?: string };
              };
            },
        ),
  };
});

const ownedScope = Effect.gen(function* () {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  return scope;
});

const pidFor = (f: Effect.Success<typeof fixture>, saved: string) =>
  f.log().findLast((v) => v.msg.opened === saved)!.pid;

const exited = (f: Effect.Success<typeof fixture>, pid: number) =>
  waitReal(
    "exact owned child EXIT",
    Effect.sync(() => f.log().some((v) => v.pid === pid && v.msg.exited)),
  );

describe.skipIf(process.platform === "win32")("orchestrator acquisition boundaries", () => {
  it.live.each(["invalidate", "retire", "retireAll"] as const)(
    "%s covers all matching partitions on both homes and preserves other profiles and retained users",
    (method) =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* Effect.gen(function* () {
            const servers = yield* CodexServers;
            const a = ThreadId.make("invented-profile-root-a"),
              b = ThreadId.make("invented-profile-root-b");
            const entries = [];
            for (const home of ["user", "gateway"] as const) {
              for (const partition of [undefined, a, b]) {
                const server = yield* servers.acquire(f.profile, home, partition),
                  scope = yield* ownedScope;
                expect(yield* server.retain.pipe(Effect.provideService(Scope.Scope, scope))).toBe(
                  true,
                );
                expect(yield* servers.acquire(f.profile, home, partition)).toBe(server);
                for (const path of server.generated) rmSync(path);
                expect(yield* servers.acquire(f.profile, home, partition)).toBe(server);
                expect(server.generated.every((path) => existsSync(path))).toBe(true);
                entries.push({ home, partition, server, scope });
              }
            }
            const other = yield* servers.acquire(f.otherProfile, "gateway", a),
              otherScope = yield* ownedScope;
            yield* other.retain.pipe(Effect.provideService(Scope.Scope, otherScope));
            const running = yield* servers.running;
            for (const entry of entries)
              expect(running.find((v) => v.server === entry.server)?.home).toBe(entry.home);
            if (method === "retireAll") yield* servers.retireAll;
            else yield* servers[method](f.profile);
            for (const entry of entries) {
              expect(yield* entry.server.configCurrent).toBe(false);
              // Held old children still answer; invalidating a profile is never a kill of its users.
              expect(
                yield* entry.server.rpc.request("account/read", { refreshToken: false }),
              ).toMatchObject({ requiresOpenaiAuth: false });
              const replacement = yield* servers.acquire(f.profile, entry.home, entry.partition);
              expect(replacement).not.toBe(entry.server);
              yield* Scope.close(entry.scope, Exit.void);
              expect(yield* replacement.configCurrent).toBe(true);
              expect(yield* servers.acquire(f.profile, entry.home, entry.partition)).toBe(
                replacement,
              );
            }
            expect(yield* other.configCurrent).toBe(method !== "retireAll");
            expect(yield* other.rpc.request("account/read", { refreshToken: false })).toMatchObject(
              { requiresOpenaiAuth: false },
            );
            if (method !== "retireAll")
              expect(yield* servers.acquire(f.otherProfile, "gateway", a)).toBe(other);
          }).pipe(Effect.provide(f.agents));
          for (const pid of new Set(
            f
              .log()
              .filter((v) => v.msg.method === "initialize")
              .map((v) => v.pid),
          )) {
            expect(f.log().some((v) => v.pid === pid && v.msg.exited)).toBe(true);
          }
        }),
      ),
  );
  it.live(
    "keeps two roots and same-thread references distinct, retires every user partition, and protects metadata holds",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* Effect.gen(function* () {
            const host = yield* CodexHost,
              servers = yield* CodexServers;
            const a = ThreadId.make("invented-root-a"),
              b = ThreadId.make("invented-root-b");
            const scopeA = yield* ownedScope,
              scopeA2 = yield* ownedScope,
              scopeB = yield* ownedScope,
              scopeWorker = yield* ownedScope;
            const options = { threadId: a, cwd: f.root, audience: "orchestrator" as const };
            const sessionA = yield* host
              .open(options)
              .pipe(Effect.provideService(Scope.Scope, scopeA));
            const saved = f.log().findLast((v) => v.msg.opened)!.msg.opened!;
            const rootPid = pidFor(f, saved);
            const sessionA2 = yield* host
              .open({ ...options, resumeId: saved })
              .pipe(Effect.provideService(Scope.Scope, scopeA2));
            expect(sessionA2.configOwner).toBe(sessionA.configOwner);
            const sessionB = yield* host
              .open({ ...options, threadId: b })
              .pipe(Effect.provideService(Scope.Scope, scopeB));
            const savedB = f.log().findLast((v) => v.msg.opened)!.msg.opened!;
            const bPid = pidFor(f, savedB);
            expect(bPid).not.toBe(rootPid);
            const worker = yield* host
              .open({ threadId: ThreadId.make("invented-worker"), cwd: f.root })
              .pipe(Effect.provideService(Scope.Scope, scopeWorker));
            const workerSaved = f.log().findLast((v) => v.msg.opened)!.msg.opened!;
            const workerPid = pidFor(f, workerSaved);
            const oldWorker = yield* servers.acquire(undefined, "user");
            expect(worker.configOwner).toBe(oldWorker);
            expect(workerPid).not.toBe(rootPid);
            expect(workerPid).not.toBe(bPid);
            writeFileSync(join(f.root, "invented-hold-rpc"), "owned barrier");
            const pending = yield* host.listModels().pipe(Effect.forkScoped);
            yield* waitReal(
              "metadata request held",
              Effect.sync(() =>
                f.log().some((v) => v.pid === workerPid && v.msg.heldRpc === "model/list"),
              ),
            );
            yield* servers.retire(undefined);
            expect(yield* sessionA.configCurrent!).toBe(false);
            expect(yield* sessionB.configCurrent!).toBe(false);
            expect(yield* oldWorker.configCurrent).toBe(false);
            const replacement = yield* servers.acquire(undefined, "user", a);
            expect(replacement).not.toBe(sessionA.configOwner);
            yield* Scope.close(scopeA, Exit.void);
            expect(
              f
                .log()
                .filter(
                  (v) => v.msg.method === "thread/unsubscribe" && v.msg.params?.threadId === saved,
                ),
            ).toHaveLength(0);
            expect(f.log().some((v) => v.pid === rootPid && v.msg.exited)).toBe(false);
            yield* Scope.close(scopeA2, Exit.void);
            yield* exited(f, rootPid);
            expect(yield* replacement.configCurrent).toBe(true);
            expect(yield* servers.acquire(undefined, "user", a)).toBe(replacement);
            rmSync(join(f.root, "invented-hold-rpc"));
            const resumedScope = yield* ownedScope;
            const resumed = yield* host
              .open({ ...options, resumeId: saved })
              .pipe(Effect.provideService(Scope.Scope, resumedScope));
            expect(resumed.configOwner).toBe(replacement);
            yield* Scope.close(scopeWorker, Exit.void);
            expect(f.log().some((v) => v.pid === workerPid && v.msg.exited)).toBe(false);
            yield* oldWorker.rpc.request("thread/read", { threadId: "release-rpc:owned" });
            yield* Fiber.join(pending);
            yield* exited(f, workerPid);
            expect(f.log().some((v) => v.pid === bPid && v.msg.exited)).toBe(false);
            const before = f.log().filter((v) => v.msg.opened === saved).length;
            yield* resumed.send({ text: "another invented turn" });
            yield* resumed.send({ text: "one more invented turn" });
            expect(f.log().filter((v) => v.msg.opened === saved)).toHaveLength(before);
            yield* Scope.close(scopeB, Exit.void);
            yield* exited(f, bPid);
            expect(yield* replacement.configCurrent).toBe(true);
          }).pipe(Effect.provide(f.agents));
          for (const pid of new Set(
            f
              .log()
              .filter((v) => v.msg.method === "initialize")
              .map((v) => v.pid),
          )) {
            expect(f.log().some((v) => v.pid === pid && v.msg.exited)).toBe(true);
          }
        }),
      ),
  );

  it.live(
    "a new partition cannot bypass a shared owner; cancelling an EXIT wait releases no fence",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* Effect.gen(function* () {
            const host = yield* CodexHost;
            const id = ThreadId.make("invented-shared-root");
            const scopeRoot = yield* ownedScope,
              scopeSibling = yield* ownedScope;
            yield* host
              .open({ threadId: id, cwd: f.root })
              .pipe(Effect.provideService(Scope.Scope, scopeRoot));
            const saved = f.log().findLast((v) => v.msg.opened)!.msg.opened!,
              ownerPid = pidFor(f, saved);
            yield* host
              .open({ threadId: ThreadId.make("invented-shared-sibling"), cwd: f.root })
              .pipe(Effect.provideService(Scope.Scope, scopeSibling));
            yield* Scope.close(scopeRoot, Exit.void);
            const options = {
              threadId: id,
              cwd: f.root,
              resumeId: saved,
              audience: "orchestrator" as const,
            };
            const refusal = yield* host.open(options).pipe(Effect.scoped, Effect.flip);
            expect(refusal.message).toContain("Resume was refused");
            expect(refusal.message).toContain("thread/closed does not prove writer release");
            const waiting = yield* Deferred.make<void>();
            const opening = yield* host
              .open({
                ...options,
                waitForPreviousSession: {
                  onWait: Deferred.succeed(waiting, undefined).pipe(Effect.asVoid),
                },
              })
              .pipe(Effect.scoped, Effect.forkScoped);
            yield* Deferred.await(waiting);
            yield* Fiber.interrupt(opening);
            expect(
              f
                .log()
                .filter(
                  (v) => v.msg.method === "thread/resume" && v.msg.params?.threadId === saved,
                ),
            ).toHaveLength(0);
            expect(f.log().some((v) => v.pid === ownerPid && v.msg.exited)).toBe(false);
            const refusedAgain = yield* host.open(options).pipe(Effect.scoped, Effect.flip);
            expect(refusedAgain.message).toContain("Resume was refused");
            yield* Scope.close(scopeSibling, Exit.void);
            yield* exited(f, ownerPid);
            const resumedScope = yield* ownedScope;
            yield* host.open(options).pipe(Effect.provideService(Scope.Scope, resumedScope));
            const resumes = f
              .log()
              .filter((v) => v.msg.method === "thread/resume" && v.msg.params?.threadId === saved);
            expect(resumes).toHaveLength(1);
            expect(resumes[0]!.pid).not.toBe(ownerPid);
            // All refused/cancelled attempts used the same stable partition, without per-attempt children.
            expect(
              new Set(
                f
                  .log()
                  .filter((v) => v.msg.method === "initialize")
                  .map((v) => v.pid),
              ).size,
            ).toBe(2);
          }).pipe(Effect.provide(f.agents));
          for (const pid of new Set(
            f
              .log()
              .filter((v) => v.msg.method === "initialize")
              .map((v) => v.pid),
          )) {
            expect(f.log().some((v) => v.pid === pid && v.msg.exited)).toBe(true);
          }
        }),
      ),
  );
});

describe.skipIf(process.platform === "win32")("owned orchestrator child recovery", () => {
  it.live("delivers one digest after idle eviction while a shared worker remains active", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture,
          world = yield* makeWorld;
        yield* Effect.gen(function* () {
          const store = yield* ThreadStore,
            orchestration = yield* Orchestration,
            runtimes = yield* ThreadRuntimes,
            servers = yield* CodexServers;
          const project = yield* store.ensureProject({ root: world.repo, name: "Invented" });
          const root = yield* orchestration.open(
            { projectId: project.id },
            { agent: "codex", model: "default" },
          );
          const workspaceId = root.workspaceId as WorkspaceId;
          yield* waitReal(
            "boot accepted",
            outboxOf(workspaceId).pipe(Effect.map((o) => o.generation === 1)),
          );
          yield* waitStatus(root.id, "idle");
          const saved = (yield* store.getThread(root.id)).agentSessionId!;
          const rootPid = f.log().find((v) => v.msg.opened === saved)!.pid;
          const worker = yield* runtimes.create({
            projectRoot: world.repo,
            checkout: { kind: "main", path: world.repo },
            model: { agent: "codex", model: "default" },
            input: { text: "hold invented worker" },
          });
          yield* waitStatus(worker.id, "running");
          const workerSaved = (yield* store.getThread(worker.id)).agentSessionId!;
          const workerPid = f.log().find((v) => v.msg.opened === workerSaved)!.pid;
          const workerServer = yield* servers.acquire(undefined, "user");
          yield* settle;
          yield* orchestration.setPaused(workspaceId, true);
          yield* waitStatus(root.id, "cold");
          expect((yield* store.getWorkspace(workspaceId)).paused?.reason).toBe("user");
          expect((yield* outboxOf(workspaceId)).generation).toBe(1);
          // The real outbox wake rebuilds a digest, not a direct fake send.
          yield* orchestration.setPaused(workspaceId, false);
          yield* waitReal(
            "digest settles",
            runtimes.status(root.id).pipe(Effect.map((s) => s === "idle" || s === "error")),
          );
          yield* settle;
          expect((yield* store.getThread(root.id)).lastError).toBeUndefined();
          expect((yield* store.getWorkspace(workspaceId)).paused).toBeUndefined();
          expect(yield* outboxOf(workspaceId)).toMatchObject({ generation: 2, failures: 0 });
          expect((yield* store.getThread(root.id)).agentSessionId).toBe(saved);
          expect(
            f
              .log()
              .filter((v) => v.msg.method === "thread/resume" && v.msg.params?.threadId === saved),
          ).toHaveLength(1);
          expect(f.log().some((v) => v.pid === rootPid && v.msg.exited)).toBe(true);
          expect(workerPid).not.toBe(rootPid);
          expect(f.log().some((v) => v.pid === workerPid && v.msg.exited)).toBe(false);
          expect(yield* runtimes.status(worker.id)).toBe("running");
          yield* workerServer.rpc.request("thread/read", { threadId: `stream:${workerSaved}` });
          yield* waitReal(
            "worker remains usable",
            store
              .listMessages(worker.id)
              .pipe(
                Effect.map((ms) =>
                  ms.some((m) =>
                    m.parts.some((p) => p.type === "text" && p.text === "still streaming"),
                  ),
                ),
              ),
          );
        }).pipe(
          Effect.provide(
            serverLayer(
              world,
              { idleEvictAfter: Duration.millis(500), orchestrationDebounce: Duration.millis(10) },
              f.agents,
            ).pipe(Layer.provideMerge(f.agents)),
          ),
        );
      }),
    ),
  );
});
