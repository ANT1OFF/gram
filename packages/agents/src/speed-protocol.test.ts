import { describe, expect, it } from "@effect/vitest";
import { AgentUnavailable, ThreadId, type AgentEvent, type ModelRef } from "@gram/contracts";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { ClaudeHostLive } from "./claude/live.ts";
import { ClaudeHost } from "./claude/session.ts";
import { CodexHostLive } from "./codex/live.ts";
import { CodexHost } from "./codex/session.ts";
import { GatewayKeyProvider } from "./gateway.ts";
import type { AgentHost, AgentSession } from "./host.ts";

interface ProtocolLog {
  launch?: string[];
  method?: string;
  params?: { serviceTier?: string | null; effort?: string };
  request?: { subtype?: string; settings?: { fastMode?: boolean } };
}

const withHost = <A, E>(
  agent: "claude" | "codex",
  body: (
    host: AgentHost,
    cwd: string,
    log: () => Array<ProtocolLog>,
  ) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const root = mkdtempSync(join(tmpdir(), "gram-speed-"));
      const binary = join(root, "agent");
      const logPath = join(root, "protocol.jsonl");
      writeFileSync(logPath, "");
      writeFileSync(
        binary,
        `#!${process.execPath}\n${readFileSync(new URL("../fixtures/subscriptions/speed-cli.cjs", import.meta.url), "utf8")}`,
      );
      chmodSync(binary, 0o755);
      const env = {
        PATH: dirname(process.execPath),
        HOME: root,
        USERPROFILE: root,
        CODEX_HOME: root,
        CLAUDE_CONFIG_DIR: root,
        GRAM_SPEED_AGENT: agent,
        GRAM_SPEED_LOG: logPath,
      };
      const shell = join(root, "shell");
      writeFileSync(
        shell,
        `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(
          `\0__SB_PROBE__\0${binary}\n\0__SB_ENV__\0${Object.entries(env)
            .map(([k, v]) => `${k}=${v}\0`)
            .join("")}`,
        )});`,
      );
      chmodSync(shell, 0o755);
      return {
        root,
        binary,
        shell,
        log: () =>
          readFileSync(logPath, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
      };
    }),
    (f) => {
      const keys = Layer.succeed(GatewayKeyProvider)({
        credentials: () =>
          Effect.fail(
            new AgentUnavailable({ agent, message: "No gateway in this synthetic test." }),
          ),
      });
      return Effect.scoped(
        agent === "claude"
          ? Effect.flatMap(ClaudeHost, (host) => body(host, f.root, f.log)).pipe(
              Effect.provide(
                ClaudeHostLive({
                  settingSources: [],
                  startupTimeoutMs: 2000,
                  environment: { binaryPath: f.binary, shell: f.shell },
                }).pipe(Layer.provide(keys)),
              ),
            )
          : Effect.flatMap(CodexHost, (host) => body(host, f.root, f.log)).pipe(
              Effect.provide(
                CodexHostLive({
                  servers: { binaryPath: f.binary, shell: f.shell, startupTimeoutMs: 2000 },
                }).pipe(Layer.provide(keys)),
              ),
            ),
      );
    },
    (f) => Effect.sync(() => rmSync(f.root, { recursive: true, force: true })),
  );
const id = ThreadId.make("synthetic-speed");
const collect = (session: AgentSession) =>
  session.events.pipe(
    Stream.takeUntil((event) => event.type === "turnEnd"),
    Stream.runCollect,
  );
const lastSpeed = (events: readonly AgentEvent[]) =>
  events.filter((event) => event.type === "speed").at(-1);

for (const agent of ["claude", "codex"] as const)
  describe(`${agent} production speed protocol`, () => {
    it.effect(
      "advertises Fast independently of effort; explicit Standard overrides CLI Fast preference",
      () =>
        withHost(agent, (host, cwd, log) =>
          Effect.gen(function* () {
            const models = yield* host.listModels();
            expect(models.find((model) => model.id === "fixture-fast")?.speeds).toEqual([
              "standard",
              "fast",
            ]);
            expect(models.find((model) => model.id === "fixture-standard")?.speeds).toEqual([
              "standard",
            ]);
            const session = yield* host.open({
              threadId: id,
              cwd,
              model: { agent, model: "fixture-fast", variant: "high", speed: "standard" },
            });
            yield* session.send({ text: "standard" });
            expect(lastSpeed(yield* collect(session))).toMatchObject({
              state: { speed: "standard" },
            });
            if (agent === "claude") {
              const launch = log()
                .filter((m) => m.launch)
                .at(-1)!.launch as string[];
              const settings =
                launch.find((arg) => arg.startsWith("--settings="))?.slice("--settings=".length) ??
                launch[launch.indexOf("--settings") + 1]!;
              expect(JSON.parse(settings)).toMatchObject({
                fastMode: false,
              });
            } else {
              expect(log().find((m) => m.method === "thread/start")?.params?.serviceTier).toBe(
                "default",
              );
              expect(log().find((m) => m.method === "turn/start")?.params).toMatchObject({
                serviceTier: "default",
                effort: "high",
              });
            }
          }),
        ),
    );
    it.effect("applies Fast and Standard on live changes without changing model or effort", () =>
      withHost(agent, (host, cwd, log) =>
        Effect.gen(function* () {
          const model: ModelRef = {
            agent,
            model: "fixture-fast",
            variant: "high",
            speed: "standard",
          };
          const session = yield* host.open({ threadId: id, cwd, model });
          yield* session.setModel({ ...model, speed: "fast" });
          yield* session.send({ text: "fast" });
          expect(lastSpeed(yield* collect(session))).toMatchObject({ state: { speed: "fast" } });
          yield* session.setModel(model);
          yield* session.send({ text: "standard" });
          expect(lastSpeed(yield* collect(session))).toMatchObject({
            state: { speed: "standard" },
          });
          if (agent === "claude")
            expect(
              log()
                .filter((m) => m.request?.subtype === "apply_flag_settings")
                .map((m) => m.request?.settings?.fastMode)
                .filter((v) => v !== undefined),
            ).toEqual([true, false]);
          else
            expect(
              log()
                .filter((m) => m.method === "turn/start")
                .map((m) => m.params?.serviceTier),
            ).toEqual(["priority", "default"]);
          expect(
            log().some(
              (m) =>
                m.request?.subtype === "update_settings" ||
                m.method?.startsWith("config/value/write"),
            ),
          ).toBe(false);
        }),
      ),
    );
    it.effect("rejects unsupported Fast before any session starts or selected model changes", () =>
      withHost(agent, (host, cwd, log) =>
        Effect.gen(function* () {
          const result = yield* host
            .open({ threadId: id, cwd, model: { agent, model: "fixture-standard", speed: "fast" } })
            .pipe(Effect.flip);
          expect(result.message).toContain("not advertised");
          expect(
            log().some(
              (m) =>
                m.method === "thread/start" ||
                m.launch?.some((arg) => arg === "--model" || arg.startsWith("--model=")),
            ),
          ).toBe(false);
        }),
      ),
    );
    it.effect(
      "preserves an absent speed selection and re-applies explicit speed on resume/fork",
      () =>
        withHost(agent, (host, cwd, log) =>
          Effect.gen(function* () {
            const unset = yield* host.open({
              threadId: id,
              cwd,
              model: { agent, model: "fixture-fast" },
            });
            yield* unset.send({ text: "unset" });
            const events = yield* collect(unset);
            expect(lastSpeed(events)).toMatchObject({ state: { speed: "fast" } });
            const identity = events.find((event) => event.type === "identity");
            expect(identity?.type).toBe("identity");
            for (const fork of [false, true]) {
              const resumed = yield* host.open({
                threadId: id,
                cwd,
                resumeId: identity!.agentSessionId,
                fork,
                model: { agent, model: "fixture-fast", speed: "standard" },
              });
              yield* resumed.send({ text: "resume" });
              expect(lastSpeed(yield* collect(resumed))).toMatchObject({
                state: { speed: "standard" },
              });
            }
            if (agent === "codex") {
              expect(log().find((m) => m.method === "thread/start")?.params).not.toHaveProperty(
                "serviceTier",
              );
              for (const method of ["thread/resume", "thread/fork"])
                expect(log().find((m) => m.method === method)?.params?.serviceTier).toBe("default");
            }
          }),
        ),
    );
  });
it.effect("reports Claude Fast cooldown as Standard without rewriting the requested choice", () =>
  withHost("claude", (host, cwd) =>
    Effect.gen(function* () {
      const session = yield* host.open({
        threadId: id,
        cwd,
        model: { agent: "claude", model: "fixture-fast", speed: "fast" },
      });
      yield* session.send({ text: "fallback" });
      expect(lastSpeed(yield* collect(session))).toMatchObject({
        state: { speed: "standard", detail: expect.stringContaining("cooling down") },
      });
    }),
  ),
);
it.effect("retains Codex speed overrides on a rejected send and its retry", () =>
  withHost("codex", (host, cwd, log) =>
    Effect.gen(function* () {
      const session = yield* host.open({
        threadId: id,
        cwd,
        model: { agent: "codex", model: "fixture-fast", speed: "standard" },
      });
      yield* session.setModel({ agent: "codex", model: "fixture-fast", speed: "fast" });
      yield* session.send({ text: "refuse" });
      yield* collect(session);
      yield* session.send({ text: "retry" });
      expect(lastSpeed(yield* collect(session))).toMatchObject({ state: { speed: "fast" } });
      expect(
        log()
          .filter((m) => m.method === "turn/start")
          .map((m) => m.params?.serviceTier),
      ).toEqual(["priority", "priority"]);
    }),
  ),
);
