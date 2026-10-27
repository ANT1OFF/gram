import { describe, expect, it } from "@effect/vitest";
import {
  AgentUnavailable,
  ProfileId,
  ThreadId,
  type AgentEvent,
  type RequestId,
} from "@gram/contracts";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { AgentHost, AgentSession } from "./host.ts";
import { GatewayKeyProvider } from "./gateway.ts";
import { ClaudeHostLive } from "./claude/live.ts";
import { ClaudeHost } from "./claude/session.ts";
import { CodexHostLive } from "./codex/live.ts";
import { CodexHost } from "./codex/session.ts";
import { captureLogs } from "./testing/logs.ts";

interface Fixture {
  readonly root: string;
  readonly cwd: string;
  readonly worktree: string;
  readonly signedOut: string;
  readonly failStart: string;
  readonly releaseReply: string;
  readonly keyRequests: Array<ProfileId>;
  readonly shell: string;
  readonly binary: string;
  readonly keys: Layer.Layer<GatewayKeyProvider>;
  readonly log: () => Array<{ pid: number; msg: Record<string, unknown> }>;
}

const profile = {
  id: ProfileId.make("synthetic-gateway"),
  name: "Synthetic gateway",
  baseURL: "https://gateway.example.invalid/v1",
  keyRef: "synthetic",
  models: [{ id: "fixture-small", name: "Synthetic model" }],
};

interface FixtureOptions {
  readonly gateway?: boolean;
  readonly inheritedOverrides?: boolean;
}

const fixture = (agent: "claude" | "codex", options: FixtureOptions = {}) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gram-subscription-protocol-")));
  const cwd = join(root, "repo");
  const worktree = join(root, "worktree");
  execFileSync("git", ["init", "--quiet", cwd]);
  execFileSync("git", [
    "-C",
    cwd,
    "-c",
    "user.name=Synthetic Developer",
    "-c",
    "user.email=developer@example.invalid",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "Synthetic root",
  ]);
  execFileSync("git", [
    "-C",
    cwd,
    "worktree",
    "add",
    "--quiet",
    "-b",
    "fixture-worktree",
    worktree,
  ]);
  const bin = join(root, "bin");
  mkdirSync(bin);
  // The child PATH contains only Node and the selected invented harness, never host CLIs.
  symlinkSync(process.execPath, join(bin, "node"));
  const binary = join(bin, agent);
  const source = readFileSync(
    new URL(`../fixtures/subscriptions/${agent}-cli.cjs`, import.meta.url),
    "utf8",
  );
  writeFileSync(binary, `#!${process.execPath}\n${source}`);
  chmodSync(binary, 0o755);
  const signedOut = join(root, "signed-out");
  const failStart = join(root, "fail-start");
  const releaseReply = join(root, "release-reply");
  const logPath = join(root, "protocol.jsonl");
  const authPath = join(root, "fixture-subscription.json");
  writeFileSync(authPath, JSON.stringify({ agent, subscription: true }));
  writeFileSync(logPath, "");
  // The real probe still runs, but sees only synthetic configuration and credentials. Do not source
  // the developer's login-shell config or let either fixture inspect their CLI account stores.
  const shell = join(root, "shell");
  const env = {
    PATH: bin,
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: root,
    CLAUDE_CONFIG_DIR: root,
    ...(options.inheritedOverrides
      ? {
          ANTHROPIC_API_KEY: "synthetic-api-key",
          ANTHROPIC_BASE_URL: "https://gateway.example.invalid",
          CLAUDE_CODE_OAUTH_TOKEN: "synthetic-subscription-token",
        }
      : {}),
    GRAM_FIXTURE_AUTH: authPath,
    GRAM_FIXTURE_SUBSCRIPTION_ONLY: options.gateway || options.inheritedOverrides ? "0" : "1",
    GRAM_FIXTURE_LOG: logPath,
    GRAM_FIXTURE_SIGNED_OUT: signedOut,
    GRAM_FIXTURE_FAIL_START: failStart,
    GRAM_FIXTURE_RELEASE_REPLY: releaseReply,
  };
  writeFileSync(
    shell,
    `#!${process.execPath}\nconst selected = process.argv.at(-1).includes("command -v ${agent}");
process.stdout.write("\\0__SB_PROBE__\\0" + (selected ? ${JSON.stringify(binary)} : "") + ${JSON.stringify(
      `\n\0__SB_ENV__\0${Object.entries(env)
        .map(([k, v]) => `${k}=${v}\0`)
        .join("")}`,
    )});`,
  );
  chmodSync(shell, 0o755);
  const keyRequests: Array<ProfileId> = [];
  const keys = Layer.succeed(GatewayKeyProvider)({
    credentials: (id) => {
      keyRequests.push(id);
      return options.gateway && id === profile.id
        ? Effect.succeed({ profile, key: Redacted.make("synthetic-gateway-key") })
        : Effect.fail(
            new AgentUnavailable({ agent, message: "No gateway in subscription-only fixture." }),
          );
    },
  });
  return {
    root,
    cwd,
    worktree,
    signedOut,
    failStart,
    releaseReply,
    binary,
    shell,
    keys,
    keyRequests,
    log: () =>
      readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { pid: number; msg: Record<string, unknown> }),
  };
};

const withHost = <A, E>(
  agent: "claude" | "codex",
  body: (host: AgentHost, fixture: Fixture) => Effect.Effect<A, E, Scope.Scope>,
  options: FixtureOptions = {},
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => fixture(agent, options)),
    (f) =>
      Effect.scoped(
        agent === "claude"
          ? Effect.flatMap(ClaudeHost, (host) => body(host, f)).pipe(
              Effect.provide(
                ClaudeHostLive({
                  settingSources: [],
                  startupTimeoutMs: 2000,
                  environment: { shell: f.shell },
                }).pipe(Layer.provide(f.keys)),
              ),
            )
          : Effect.flatMap(CodexHost, (host) => body(host, f)).pipe(
              Effect.provide(
                CodexHostLive({
                  servers: { shell: f.shell, startupTimeoutMs: 2000 },
                }).pipe(Layer.provide(f.keys)),
              ),
            ),
      ).pipe(
        // The adapters log each result as it lands; a warning would be news.
        Effect.provide(captureLogs({ printWarnings: true }).layer),
        Effect.tap(() =>
          Effect.sync(() => {
            if (options.gateway || options.inheritedOverrides) return;
            expect(f.keyRequests).toEqual([]);
            for (const { msg: launch } of f.log().filter((entry) => "launch" in entry.msg)) {
              expect(launch).toMatchObject({
                apiEnvPresent: false,
                otherHarnessPresent: false,
                subscriptionAuthPresent: true,
              });
            }
          }),
        ),
      ),
    (f) =>
      Effect.sync(() =>
        rmSync(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
      ),
  );

const collectTurn = (session: AgentSession, respond?: "allow" | "deny") =>
  session.events.pipe(
    Stream.tap((event) =>
      event.type === "request" && respond !== undefined
        ? session.respond(event.request.id, { kind: "approval", decision: respond, scope: "once" })
        : Effect.void,
    ),
    Stream.takeUntil((event) => event.type === "turnEnd"),
    Stream.runCollect,
  );
const textOf = (events: ReadonlyArray<AgentEvent>) =>
  events
    .flatMap((e) => (e.type === "chunk" && e.chunk.type === "text-delta" ? [e.chunk.delta] : []))
    .join("");
const threadId = ThreadId.make("synthetic-subscription");

// POSIX shebang fixtures exercise real process spawning. Windows' native Claude exe path remains a
// desktop acceptance check; no hand-written SDK or RPC doubles stand in for it here.
describe.skipIf(process.platform === "win32")(
  "subscription adapters over synthetic CLI protocols",
  () => {
    it.live(
      "Codex switch refuses a child held by another session",
      () =>
        withHost("codex", (host, f) =>
          Effect.gen(function* () {
            const first = yield* host.open({ threadId, cwd: f.cwd });
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* host.open({ threadId: ThreadId.make("synthetic-sibling"), cwd: f.cwd });
                expect((yield* first.prepareForSwitch!.pipe(Effect.flip)).message).toContain(
                  "another session",
                );
                const refused = yield* first.stopForSwitch!.pipe(Effect.flip);
                expect(refused.message).toContain("another session");
                expect(f.log().filter((entry) => "launch" in entry.msg)).toHaveLength(1);
                // Refusal has not terminated or retired the held child.
                const third = yield* host.open({
                  threadId: ThreadId.make("synthetic-third"),
                  cwd: f.cwd,
                });
                expect(third).toBeDefined();
                expect(f.log().filter((entry) => "launch" in entry.msg)).toHaveLength(1);
              }),
            );
            yield* first.stopForSwitch!;
          }),
        ),
      10000,
    );

    for (const agent of ["claude", "codex"] as const) {
      it.live(
        `${agent}: switch stop observes actual isolated child exit before a fresh session`,
        () =>
          withHost(agent, (host, f) =>
            Effect.gen(function* () {
              expect(host.supportsWorkspaceSwitch).toBe(true);
              const first = yield* host.open({ threadId, cwd: f.cwd, audience: "orchestrator" });
              yield* first.send({ text: "synthetic checkpoint" });
              expect(textOf(yield* collectTurn(first))).toBe("Synthetic reply.");
              expect(first.stopForSwitch).toBeDefined();
              yield* first.prepareForSwitch!;
              yield* first.stopForSwitch!;
              // Opening the same Codex partition here must pass its actual-child ownership fence.
              const next = yield* host.open({
                threadId,
                cwd: f.cwd,
                audience: "orchestrator",
                switchStartup: "synthetic-attempt",
              });
              expect(next.acceptSwitchStartup).toBeDefined();
              expect(yield* host.switchAttemptReleased!("unknown-attempt")).toBe(false);
              expect(yield* host.switchAttemptReleased!("synthetic-attempt")).toBe(false);
              expect(
                (yield* next.acceptSwitchStartup!("stale-attempt").pipe(Effect.flip)).message,
              ).toContain("Stale");
              yield* next.acceptSwitchStartup!("synthetic-attempt");
              yield* next.send({ text: "synthetic boot" });
              expect(textOf(yield* collectTurn(next))).toBe("Synthetic reply.");
              yield* next.stopForSwitch!;
              expect(yield* host.switchAttemptReleased!("synthetic-attempt")).toBe(true);
              const launches = f.log().filter((entry) => "launch" in entry.msg);
              expect(new Set(launches.map((entry) => entry.pid)).size).toBe(2);
            }),
          ),
        10000,
      );

      it.live(
        `${agent}: the other harness is absent from the same isolated CLI environment`,
        () =>
          withHost(agent, (_host, f) => {
            const absent =
              agent === "claude"
                ? Effect.flatMap(CodexHost, (host) => host.listModels()).pipe(
                    Effect.provide(
                      CodexHostLive({ servers: { shell: f.shell, startupTimeoutMs: 2000 } }).pipe(
                        Layer.provide(f.keys),
                      ),
                    ),
                  )
                : Effect.flatMap(ClaudeHost, (host) => host.listModels()).pipe(
                    Effect.provide(
                      ClaudeHostLive({
                        environment: { shell: f.shell },
                        settingSources: [],
                        startupTimeoutMs: 2000,
                      }).pipe(Layer.provide(f.keys)),
                    ),
                  );
            return Effect.gen(function* () {
              const error = yield* absent.pipe(Effect.flip);
              expect(error.agent).toBe(agent === "claude" ? "codex" : "claude");
              expect(error.message).toMatch(/No .* executable|couldn't find|not found/i);
              expect(f.log()).toEqual([]);
            });
          }),
        10000,
      );

      it.live(
        `${agent}: discovers native models, streams selected models, resumes in a real Git worktree`,
        () =>
          withHost(agent, (host, f) =>
            Effect.gen(function* () {
              const models = yield* host.listModels!();
              expect(models[0]?.isDefault).toBe(true);
              const selected = agent === "claude" ? "fixture-small" : "fixture-model";
              let sessionId = "";
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const session = yield* host.open({
                    threadId,
                    cwd: f.cwd,
                    model: { agent, model: selected, variant: "high" },
                  });
                  yield* session.send({ text: "hello" });
                  const events = yield* collectTurn(session);
                  expect(textOf(events)).toBe("Synthetic reply.");
                  expect(events.at(-1)).toEqual({ type: "turnEnd", reason: "completed" });
                  const identity = events.find((e) => e.type === "identity");
                  expect(identity?.type).toBe("identity");
                  if (identity?.type === "identity") sessionId = identity.agentSessionId;
                  yield* session.setModel({
                    agent,
                    model: agent === "claude" ? "default" : "fixture-alt",
                  });
                  yield* session.send({ text: "hello on another model" });
                  expect(textOf(yield* collectTurn(session))).toBe("Synthetic reply.");
                }),
              );
              // Pinned Codex closed is not writer-release proof; deliberate retirement observes exit.
              if (agent === "codex") yield* host.reloadConfig!(undefined);
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const resumed = yield* host.open({
                    threadId,
                    cwd: f.worktree,
                    resumeId: sessionId,
                    additionalDirectories: [f.cwd],
                  });
                  yield* resumed.send({ text: "hello again" });
                  const events = yield* collectTurn(resumed);
                  expect(textOf(events)).toBe("Synthetic reply.");
                  expect(events.find((e) => e.type === "identity")).toMatchObject({
                    agentSessionId: sessionId,
                  });
                }),
              );
              const log = f.log().map((e) => e.msg);
              expect(f.keyRequests).toEqual([]);
              expect(log.filter((m) => "launch" in m)).not.toHaveLength(0);
              for (const launch of log.filter((m) => "launch" in m)) {
                expect(launch).toMatchObject({
                  apiEnvPresent: false,
                  otherHarnessPresent: false,
                  subscriptionAuthPresent: true,
                });
              }
              if (agent === "claude") {
                const launches = log.filter((m) => "launch" in m);
                expect(launches.some((m) => m.cwd === f.worktree)).toBe(true);
                expect(
                  launches.every((m) => m.apiKeyPresent === false && m.oauthPresent === false),
                ).toBe(true);
                expect(
                  launches.some((m) =>
                    (m.launch as string[]).some(
                      (arg) => arg === selected || arg === `--model=${selected}`,
                    ),
                  ),
                ).toBe(true);
                expect(
                  log.some(
                    (m) =>
                      (m.request as { subtype?: string; model?: string } | undefined)?.subtype ===
                        "set_model" && (m.request as { model?: string }).model === "default",
                  ),
                ).toBe(true);
                expect(
                  launches.some(
                    (m) =>
                      m.cwd === f.worktree && (m.launch as string[]).some((a) => a.includes(f.cwd)),
                  ),
                ).toBe(true);
                expect(
                  launches.some((m) =>
                    (m.launch as string[]).some(
                      (a) => a === "--resume" || a.startsWith("--resume="),
                    ),
                  ),
                ).toBe(true);
              } else {
                expect(log.find((m) => m.method === "account/read")).toMatchObject({
                  params: { refreshToken: false },
                });
                const resume = log.find((m) => m.method === "thread/resume");
                expect(resume).toMatchObject({
                  params: {
                    threadId: sessionId,
                    cwd: f.worktree,
                    config: { sandbox_workspace_write: { writable_roots: [f.cwd] } },
                  },
                });
                const turns = log.filter((m) => m.method === "turn/start");
                expect(turns[0]).toMatchObject({ params: { model: selected, effort: "high" } });
                expect(turns[1]).toMatchObject({ params: { model: "fixture-alt" } });
                expect(log.find((m) => m.method === "thread/start")).toMatchObject({
                  params: { model: selected },
                });
                expect(
                  log
                    .filter((m) => "launch" in m)
                    .every((m) => JSON.stringify(m.launch) === '["app-server"]'),
                ).toBe(true);
              }
            }),
          ),
        15000,
      );

      for (const decision of ["allow", "deny"] as const) {
        it.live(
          `${agent}: ${decision === "allow" ? "allows" : "denies"} a tool through the CLI control protocol`,
          () =>
            withHost(agent, (host, f) =>
              Effect.gen(function* () {
                const session = yield* host.open({ threadId, cwd: f.cwd });
                yield* session.send({ text: decision === "allow" ? "approve" : "deny" });
                const events = yield* collectTurn(session, decision);
                expect(events.filter((e) => e.type === "request")).toHaveLength(1);
                expect(events.some((e) => e.type === "requestResolved")).toBe(true);
                expect(textOf(events)).toBe(decision === "allow" ? "Approved." : "Rejected.");
                expect(events.at(-1)).toEqual({ type: "turnEnd", reason: "completed" });
              }),
            ),
          10000,
        );
      }

      it.live(
        `${agent}: cancels a pending tool and rejects a stale approval`,
        () =>
          withHost(agent, (host, f) =>
            Effect.gen(function* () {
              const session = yield* host.open({ threadId, cwd: f.cwd });
              let cardId: RequestId | undefined;
              const events = yield* Effect.forkScoped(
                session.events.pipe(
                  Stream.tap((e) => {
                    if (e.type !== "request") return Effect.void;
                    cardId = e.request.id;
                    return session.interrupt;
                  }),
                  Stream.takeUntil((e) => e.type === "turnEnd"),
                  Stream.runCollect,
                ),
              );
              yield* session.send({ text: "pending" });
              const seen = yield* Fiber.join(events);
              expect(seen.at(-1)).toEqual({ type: "turnEnd", reason: "interrupted" });
              expect(seen.some((e) => e.type === "requestResolved")).toBe(true);
              if (agent === "codex") {
                expect(seen).toContainEqual(
                  expect.objectContaining({
                    type: "chunk",
                    chunk: expect.objectContaining({
                      type: "tool-output-error",
                      toolCallId: "synthetic-tool",
                      errorText: "Cancelled",
                    }),
                  }),
                );
              }
              expect(cardId).toBeDefined();
              const replies = f.log().filter((entry) => entry.msg.type === "control_response");
              if (agent === "claude") {
                // turnEnd must follow the SDK's cancelled canUseTool response, not race it.
                expect(replies).toHaveLength(1);
                expect(replies[0]?.msg).toMatchObject({
                  response: {
                    subtype: "success",
                    request_id: cardId,
                    response: {
                      behavior: "deny",
                      message: "The request was cancelled.",
                      toolUseID: "synthetic-tool",
                    },
                  },
                });
              }
              const before = f.log().length;
              yield* session.respond(cardId!, {
                kind: "approval",
                decision: "allow",
                scope: "once",
              });
              expect(f.log()).toHaveLength(before);
              yield* session.send({ text: "hello after cancel" });
              expect(textOf(yield* collectTurn(session))).toBe("Synthetic reply.");
              if (agent === "claude") {
                // Another turn must not reveal a late response to the stale answer.
                expect(f.log().filter((entry) => entry.msg.type === "control_response")).toEqual(
                  replies,
                );
              }
            }),
          ),
        10000,
      );

      it.live(
        `${agent}: reopens the persisted identity after child exit`,
        () =>
          withHost(agent, (host, f) =>
            Effect.gen(function* () {
              let sessionId = "";
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const session = yield* host.open({ threadId, cwd: f.cwd });
                  const events = yield* Effect.forkScoped(
                    session.events.pipe(
                      Stream.takeUntil((e) => e.type === "ended"),
                      Stream.runCollect,
                    ),
                  );
                  yield* session.send({ text: "exit" });
                  const seen = yield* Fiber.join(events);
                  expect(seen.at(-1)).toMatchObject({ type: "ended" });
                  const identity = seen.find((e) => e.type === "identity");
                  if (identity?.type === "identity") sessionId = identity.agentSessionId;
                }),
              );
              expect(sessionId).not.toBe("");
              const resumed = yield* host.open({ threadId, cwd: f.cwd, resumeId: sessionId });
              yield* resumed.send({ text: "hello" });
              expect(textOf(yield* collectTurn(resumed))).toBe("Synthetic reply.");
              expect(
                new Set(
                  f
                    .log()
                    .filter((e) => "launch" in e.msg)
                    .map((e) => e.pid),
                ).size,
              ).toBeGreaterThanOrEqual(2);
            }),
          ),
        10000,
      );

      it.live(
        `${agent}: forks a stored session into a worktree and survives a provider reconnect`,
        () =>
          withHost(agent, (host, f) =>
            Effect.gen(function* () {
              let sessionId = "";
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const session = yield* host.open({ threadId, cwd: f.cwd });
                  yield* session.send({ text: "hello" });
                  const events = yield* collectTurn(session);
                  const identity = events.find((e) => e.type === "identity");
                  if (identity?.type === "identity") sessionId = identity.agentSessionId;
                }),
              );
              const fork = yield* host.open({
                threadId,
                cwd: f.worktree,
                resumeId: sessionId,
                fork: true,
              });
              yield* fork.send({ text: "reconnect" });
              const seen = yield* collectTurn(fork);
              expect(seen.some((e) => e.type === "status" && e.status === "retrying")).toBe(true);
              expect(textOf(seen)).toBe("Synthetic reply.");
              const identity = seen.find((e) => e.type === "identity");
              expect(identity?.type === "identity" && identity.agentSessionId).not.toBe(sessionId);
              if (agent === "codex")
                expect(f.log().find((e) => e.msg.method === "thread/fork")?.msg).toMatchObject({
                  params: { threadId: sessionId, cwd: f.worktree },
                });
              else
                expect(
                  f
                    .log()
                    .some(
                      (e) => Array.isArray(e.msg.launch) && e.msg.launch.includes("--fork-session"),
                    ),
                ).toBe(true);
            }),
          ),
        10000,
      );

      it.live(
        `${agent}: recovers discovery after sign-out and startup failure`,
        () =>
          withHost(agent, (host, f) =>
            Effect.gen(function* () {
              writeFileSync(f.signedOut, "");
              const error = yield* Effect.flip(host.listModels!());
              expect(error).toMatchObject({ agent, reason: "not-logged-in" });
              rmSync(f.signedOut);
              writeFileSync(f.failStart, "");
              yield* host.invalidateRuntime!;
              expect(yield* Effect.flip(host.open({ threadId, cwd: f.cwd }))).toMatchObject({
                agent,
                reason: "startup-failed",
              });
              rmSync(f.failStart);
              yield* host.invalidateRuntime!;
              expect((yield* host.listModels!()).length).toBeGreaterThan(0);
              const session = yield* host.open({ threadId, cwd: f.cwd });
              yield* session.send({ text: "hello" });
              expect(textOf(yield* collectTurn(session))).toBe("Synthetic reply.");
            }),
          ),
        10000,
      );
    }

    it.live(
      "claude: an expired subscription login is an auth failure, not a retryable provider error",
      () =>
        withHost("claude", (host, f) =>
          Effect.gen(function* () {
            const session = yield* host.open({ threadId, cwd: f.cwd });
            yield* session.send({ text: "expired" });
            expect((yield* collectTurn(session)).at(-1)).toMatchObject({
              type: "turnEnd",
              reason: "error",
              failure: { kind: "auth", retryable: false },
            });
          }),
        ),
      10000,
    );

    it.live(
      "claude: inherited API overrides are stripped while subscription OAuth stays local",
      () =>
        withHost(
          "claude",
          (host, f) =>
            Effect.gen(function* () {
              const session = yield* host.open({ threadId, cwd: f.cwd });
              yield* session.send({ text: "hello" });
              expect(textOf(yield* collectTurn(session))).toBe("Synthetic reply.");
              expect(f.log().find(({ msg }) => "launch" in msg)?.msg).toMatchObject({
                apiKeyPresent: false,
                oauthPresent: true,
              });
              expect(f.keyRequests).toEqual([]);
            }),
          { inheritedOverrides: true },
        ),
      10000,
    );

    it.live(
      "claude: an explicit gateway receives its key without subscription OAuth",
      () =>
        withHost(
          "claude",
          (host, f) =>
            Effect.gen(function* () {
              const session = yield* host.open({
                threadId,
                cwd: f.cwd,
                model: { agent: "claude", model: "fixture-small", profileId: profile.id },
              });
              yield* session.send({ text: "hello" });
              expect(textOf(yield* collectTurn(session))).toBe("Synthetic reply.");
              expect(f.log().find((e) => "launch" in e.msg)?.msg).toMatchObject({
                apiKeyPresent: true,
                oauthPresent: false,
              });
            }),
          { gateway: true, inheritedOverrides: true },
        ),
      10000,
    );

    it.live(
      "codex: a refused turn preserves an unapplied permission change for retry",
      () =>
        withHost("codex", (host, f) =>
          Effect.gen(function* () {
            const session = yield* host.open({ threadId, cwd: f.cwd });
            yield* session.setMode("bypassPermissions");
            yield* session.send({ text: "refuse" });
            expect((yield* collectTurn(session)).at(-1)).toMatchObject({
              type: "turnEnd",
              reason: "error",
            });
            yield* session.send({ text: "hello" });
            yield* collectTurn(session);
            yield* session.send({ text: "hello again" });
            yield* collectTurn(session);
            const turns = f
              .log()
              .filter((e) => e.msg.method === "turn/start")
              .map((e) => e.msg.params);
            expect(turns[0]).toMatchObject({ approvalPolicy: "never" });
            expect(turns[1]).toMatchObject({ approvalPolicy: "never" });
            expect(turns[2]).not.toHaveProperty("approvalPolicy");
          }),
        ),
      10000,
    );

    for (const searchMode of ["cached", "indexed", "live", "disabled"] as const) {
      it.live(
        `codex: local start/resume/fork preserve configured ${searchMode} web search`,
        () =>
          withHost("codex", (host, f) =>
            Effect.gen(function* () {
              writeFileSync(join(f.root, "config.toml"), `web_search = "${searchMode}"\n`);
              let resumeId = "";
              for (const kind of ["start", "resume", "fork"] as const) {
                if (kind !== "start") {
                  expect(resumeId).not.toBe("");
                  yield* host.reloadConfig!(undefined);
                }
                yield* Effect.scoped(
                  Effect.gen(function* () {
                    const session = yield* host.open({
                      threadId,
                      cwd: f.cwd,
                      ...(kind === "start" ? {} : { resumeId }),
                      ...(kind === "fork" ? { fork: true } : {}),
                    });
                    for (const text of ["search", "open-page", "find-in-page"]) {
                      yield* session.send({ text });
                      const events = yield* collectTurn(session);
                      const identity = events.find((e) => e.type === "identity");
                      if (identity?.type === "identity") resumeId = identity.agentSessionId;
                      expect(
                        events.some(
                          (e) =>
                            e.type === "chunk" &&
                            e.chunk.type === "tool-input-available" &&
                            e.chunk.toolName === "WebSearch",
                        ),
                      ).toBe(searchMode !== "disabled");
                      expect(events).toContainEqual({ type: "turnEnd", reason: "completed" });
                    }
                  }),
                );
              }
              const log = f.log().map((e) => e.msg);
              expect(log.filter((m) => "webAction" in m)).toHaveLength(
                searchMode === "disabled" ? 0 : 9,
              );
              expect(
                log
                  .filter((m) => "launch" in m)
                  .every((m) => JSON.stringify(m.launch) === '["app-server"]'),
              ).toBe(true);
              for (const method of ["thread/start", "thread/resume", "thread/fork", "turn/start"]) {
                const calls = log.filter((m) => m.method === method);
                expect(calls.length).toBeGreaterThan(0);
                for (const call of calls) {
                  const params = call.params as Record<string, unknown>;
                  expect(params).not.toHaveProperty("webSearch");
                  expect(params).not.toHaveProperty("tools");
                  expect(params.config ?? {}).not.toHaveProperty("web_search");
                  expect(params.config ?? {}).not.toHaveProperty("features");
                }
              }
            }),
          ),
        15000,
      );
    }

    it.live(
      "codex: confinement disables configured servers and plugin loading before a turn",
      () =>
        withHost("codex", (host, f) =>
          Effect.gen(function* () {
            const session = yield* host.open({ threadId, cwd: f.cwd, confineWrites: true });
            const calls = f.log().map((e) => e.msg);
            expect(calls.find((m) => m.method === "thread/start")).toMatchObject({
              params: {
                config: {
                  mcp_servers: { alpha: { enabled: false } },
                  features: { plugins: false, apps: false },
                },
              },
            });
            expect(calls.some((m) => m.method === "mcpServerStatus/list")).toBe(true);
            expect(calls.some((m) => m.method === "turn/start")).toBe(false);
            for (const text of ["search", "open-page", "find-in-page"]) {
              yield* session.send({ text });
              const events = yield* collectTurn(session);
              expect(
                events.some(
                  (e) =>
                    e.type === "chunk" &&
                    e.chunk.type === "tool-input-available" &&
                    e.chunk.toolName === "WebSearch",
                ),
              ).toBe(true);
              expect(textOf(events)).toBe("Synthetic reply.");
            }
          }),
        ),
      10000,
    );

    it.live(
      "codex: a refused exit from plan mode keeps the collaboration change for retry",
      () =>
        withHost("codex", (host, f) =>
          Effect.gen(function* () {
            const session = yield* host.open({ threadId, cwd: f.cwd });
            yield* session.setMode("plan");
            yield* session.send({ text: "hello" });
            yield* collectTurn(session);
            yield* session.setMode("default");
            yield* session.send({ text: "refuse" });
            expect((yield* collectTurn(session)).at(-1)).toMatchObject({
              type: "turnEnd",
              reason: "error",
            });
            yield* session.send({ text: "hello after refusal" });
            yield* collectTurn(session);
            yield* session.send({ text: "hello again" });
            yield* collectTurn(session);
            const turns = f
              .log()
              .filter((e) => e.msg.method === "turn/start")
              .map((e) => e.msg.params);
            expect(turns[0]).toMatchObject({ collaborationMode: { mode: "plan" } });
            expect(turns[1]).toMatchObject({ collaborationMode: { mode: "default" } });
            expect(turns[2]).toMatchObject({ collaborationMode: { mode: "default" } });
            expect(turns[3]).not.toHaveProperty("collaborationMode");
          }),
        ),
      10000,
    );

    it("codex fixture replies when the delayed reply release already exists before watching", () => {
      const f = fixture("codex");
      try {
        const releaseReply = join(mkdtempSync(join(f.root, "release-")), "ready");
        writeFileSync(releaseReply, "");
        // No discovery/background RPC can cause an unrelated directory event to mask the lost
        // release. Exercise the actual CLI child with completion preceding its delayed reply.
        const out = spawnSync(process.execPath, [f.binary], {
          cwd: f.cwd,
          env: {
            CODEX_HOME: f.root,
            GRAM_FIXTURE_LOG: join(f.root, "protocol.jsonl"),
            GRAM_FIXTURE_RELEASE_REPLY: releaseReply,
          },
          input: [
            { id: 1, method: "thread/start", params: { cwd: f.cwd } },
            { id: 2, method: "turn/start", params: { input: [{ text: "late" }] } },
          ]
            .map((msg) => JSON.stringify(msg) + "\n")
            .join(""),
          encoding: "utf8",
          timeout: 1500,
        });
        expect(out.error).toBeUndefined();
        expect(out.status).toBe(0);
        const replies = out.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const completed = replies.findIndex((msg) => msg.method === "turn/completed");
        const delayed = replies.findIndex((msg) => msg.id === 2);
        expect(completed).toBeGreaterThanOrEqual(0);
        expect(delayed).toBeGreaterThan(completed);
        expect(replies[delayed]).toMatchObject({ result: { turn: { status: "inProgress" } } });
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    });

    it.live(
      "codex: completion before the turn/start reply cannot restore a stale running turn",
      () =>
        withHost("codex", (host, f) =>
          Effect.gen(function* () {
            const session = yield* host.open({ threadId, cwd: f.cwd });
            const sending = yield* Effect.forkScoped(session.send({ text: "late" }));
            expect((yield* collectTurn(session)).at(-1)).toEqual({
              type: "turnEnd",
              reason: "completed",
            });
            yield* session.setMode("bypassPermissions");
            writeFileSync(f.releaseReply, "");
            yield* Fiber.join(sending);
            yield* session.interrupt;
            // No stale turn to join: the steer is refused (the runtime queues it) and never becomes
            // a turn of its own. The next turn the runtime starts carries the changed policy.
            const steered = yield* session.steer({ text: "hello" }).pipe(
              Effect.as("taken"),
              Effect.catchDefect((defect) => Effect.succeed(String(defect))),
            );
            expect(steered).toContain("no running turn");
            yield* session.send({ text: "hello" });
            const calls = f.log().map((e) => e.msg.method);
            expect(calls).not.toContain("turn/interrupt");
            expect(calls).not.toContain("turn/steer");
            expect(calls.filter((method) => method === "turn/start")).toHaveLength(2);
            expect(f.log().filter((e) => e.msg.method === "turn/start")[1]?.msg).toMatchObject({
              params: { approvalPolicy: "never" },
            });
          }),
        ),
      10000,
    );
  },
);

for (const agent of ["claude", "codex"] as const) {
  it.live(
    `${agent}: exact pre-spawn refusal is not actual EXIT and uses a fresh retry token`,
    () =>
      withHost(agent, (host, f) =>
        Effect.gen(function* () {
          yield* host.listModels();
          const launches = f.log().filter((e) => "launch" in e.msg).length;
          // Claude checks auth before spawn; Codex's capability refusal also precedes acquisition.
          // Codex account/read is covered by readiness controls, not assumed to run in open.
          if (agent === "claude")
            writeFileSync(f.signedOut, "Synthetic auth revoked after discovery");
          const attempt = `synthetic-${agent}-no-child`;
          yield* Effect.scoped(
            host.open({
              threadId,
              cwd: f.cwd,
              audience: "orchestrator",
              switchStartup: attempt,
              ...(agent === "codex" ? { dreamFilesOnly: true } : {}),
            }),
          ).pipe(Effect.flip);
          expect(f.log().filter((e) => "launch" in e.msg)).toHaveLength(launches);
          expect(yield* host.switchAttemptReceipt!(attempt)).toBe("notStarted");
          expect(yield* host.switchAttemptReceipt!("unknown-attempt")).toBeUndefined();
          if (agent === "claude") rmSync(f.signedOut);
          expect(
            (yield* host
              .open({ threadId, cwd: f.cwd, audience: "orchestrator", switchStartup: attempt })
              .pipe(Effect.flip)).message,
          ).toContain("already used");
          const fresh = `${attempt}-new`;
          const session = yield* host.open({
            threadId,
            cwd: f.cwd,
            audience: "orchestrator",
            switchStartup: fresh,
          });
          expect(yield* host.switchAttemptReceipt!(fresh)).toBeUndefined();
          yield* session.acceptSwitchStartup!(fresh);
          yield* session.stopForSwitch!;
          expect(yield* host.switchAttemptReceipt!(fresh)).toBe("exited");
          expect(yield* host.switchAttemptReceipt!(attempt)).toBe("notStarted");
        }),
      ),
    10000,
  );
}

for (const agent of ["claude", "codex"] as const) {
  it.live(
    `${agent}: switch readiness rechecks auth behind a warm catalog without invalidation`,
    () =>
      withHost(agent, (host, f) =>
        Effect.gen(function* () {
          yield* host.listModels();
          writeFileSync(f.signedOut, "Synthetic revoke behind warmed catalog");
          expect((yield* host.checkWorkspaceSwitch!.pipe(Effect.flip)).reason).toBe(
            "not-logged-in",
          );
          expect(yield* host.switchAttemptReceipt!("no-startup-attempt")).toBeUndefined();
          rmSync(f.signedOut);
          yield* host.checkWorkspaceSwitch!;
          expect(f.keyRequests).toEqual([]);
        }),
      ),
    10000,
  );
}
