import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { AgentUnavailable, DEFAULT_CHARTER } from "@gram/contracts";
import { ClaudeHost, ClaudeHostLive } from "@gram/agents/claude";
import { GatewayKeyProvider, type AgentHost } from "@gram/agents";
import { captureLogs } from "@gram/agents/testing/logs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { FakeAgentAdapter, FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { Orchestration } from "./service.ts";
import {
  completeTurn,
  makeWorld,
  openProject,
  serverLayer,
  waitReal,
  waitSent,
} from "./test-harness.ts";

// Real SDK + invented CLI. All CLI/auth/environment state is synthetic, never inherited.
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gram-switch-readiness-")));
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  const binary = join(bin, "claude");
  const source = readFileSync(
    new URL("../../../agents/fixtures/subscriptions/claude-cli.cjs", import.meta.url),
    "utf8",
  );
  writeFileSync(binary, `#!${process.execPath}\n${source}`);
  chmodSync(binary, 0o755);
  const signedOut = join(root, "signed-out");
  const log = join(root, "protocol.jsonl");
  writeFileSync(log, "");
  const auth = join(root, "fixture-subscription.json");
  writeFileSync(auth, JSON.stringify({ agent: "claude", subscription: true }));
  const env = {
    PATH: bin,
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: root,
    CLAUDE_CONFIG_DIR: root,
    GRAM_FIXTURE_AUTH: auth,
    GRAM_FIXTURE_SUBSCRIPTION_ONLY: "1",
    GRAM_FIXTURE_LOG: log,
    GRAM_FIXTURE_SIGNED_OUT: signedOut,
    GRAM_FIXTURE_FAIL_START: join(root, "fail-start"),
    GRAM_FIXTURE_RELEASE_REPLY: join(root, "release-reply"),
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
    shell,
    signedOut,
    launches: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { msg: Record<string, unknown> })
        .filter((e) => "launch" in e.msg),
  };
};
type Fixture = ReturnType<typeof fixture>;
const withTarget = <A, E, R>(body: (host: AgentHost, f: Fixture) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(fixture),
    (f) =>
      Effect.scoped(
        Effect.flatMap(ClaudeHost, (host) => body(host, f)).pipe(
          Effect.provide(
            ClaudeHostLive({
              settingSources: [],
              startupTimeoutMs: 2000,
              environment: { shell: f.shell },
            }).pipe(
              Layer.provide(
                Layer.succeed(GatewayKeyProvider)({
                  credentials: () =>
                    Effect.fail(
                      new AgentUnavailable({
                        agent: "claude",
                        message: "No gateway in synthetic subscription fixture.",
                      }),
                    ),
                }),
              ),
            ),
          ),
        ),
      ),
    (f) =>
      Effect.sync(() =>
        rmSync(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
      ),
  );
const adapters = (target: AgentHost) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const fake = yield* AgentHosts,
        control = yield* FakeAgentControl;
      return Context.make(
        AgentHosts,
        AgentHosts.of({
          get: (kind) => (kind === "claude" ? Effect.succeed(target) : fake.get(kind)),
        }),
      ).pipe(Context.add(FakeAgentControl, control));
    }),
  ).pipe(Layer.provide(FakeAgentAdapter));

for (const reload of [false, true]) {
  it.live(
    `fresh auth refuses before source EXIT with ${reload ? "explicitly refreshed" : "cached"} target catalog`,
    () =>
      withTarget((real, f) =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          const logs = captureLogs();
          yield* Effect.scoped(
            Effect.gen(function* () {
              const context = yield* Layer.build(
                serverLayer(world, {}, adapters(real)).pipe(Layer.provideMerge(logs.layer)),
              );
              yield* Effect.gen(function* () {
                const project = yield* openProject(world),
                  orchestration = yield* Orchestration,
                  store = yield* ThreadStore,
                  rt = yield* ThreadRuntimes;
                const state = yield* orchestration.saveWorkspace({
                  name: "Synthetic auth readiness",
                  projectIds: [project.id],
                  homeProjectId: project.id,
                  charter: {
                    ...DEFAULT_CHARTER,
                    autonomy: "full",
                    orchestratorModel: { agent: "codex", model: "fake-opus" },
                  },
                });
                const thread = yield* orchestration.open({ workspaceId: state.workspace.id }),
                  source = yield* waitSent(thread.id, 1);
                yield* completeTurn(source);
                yield* orchestration.handoff(state.workspace.id, "user", {
                  agent: "claude",
                  model: "fixture-small",
                });
                yield* waitSent(thread.id, 2);
                const launches = f.launches().length;
                yield* rt.send(thread.id, { text: "Keep on unchanged source" });
                writeFileSync(f.signedOut, "Synthetic revoked during checkpoint");
                if (reload) yield* real.reloadConfig!(undefined);
                yield* source.completeTurn();
                // The original failing probe waited only for a failed target. Safe preflight instead abandons
                // before any target exists; retain the same source-alive assertion and prove held input returns.
                yield* waitSent(thread.id, 3);
                expect(source.closed).toBe(false);
                expect(source.sent[2]!.text).toBe("Keep on unchanged source");
                expect((yield* store.getThread(thread.id)).sessionSwitch).toBeUndefined();
                expect((yield* store.getThread(thread.id)).model).toEqual(thread.model);
                expect(
                  (yield* store.getWorkspace(state.workspace.id)).charter.orchestratorModel,
                ).toEqual(thread.model);
                expect(f.launches()).toHaveLength(launches);
              }).pipe(Effect.provide(context));
            }),
          );
          // The refused handoff is the one warning: the held input waited for the switch, not on a
          // path that forgot it.
          expect(logs.warnings().map(({ message, annotations }) => [message, annotations])).toEqual(
            [
              [
                "orchestration handoff abandoned",
                expect.objectContaining({ why: expect.stringContaining("isn't logged in") }),
              ],
            ],
          );
        }),
      ),
    30000,
  );
}

it.live(
  "a target auth failure after fresh preflight persists no-child proof and permits explicit repaired retry",
  () =>
    withTarget((real, f) =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const logs = captureLogs();
        // The repaired target starts in `bypassPermissions` with Gram's `canUseTool`, which the SDK
        // warns will never be asked: Gram gates calls in its `PreToolUse` hook, so that is meant.
        const emitWarning = process.emitWarning;
        const warned = vi
          .spyOn(process, "emitWarning")
          .mockImplementation((warning: string | Error, ...rest: Array<unknown>) => {
            const [options] = rest;
            const code =
              typeof options === "object" && options !== null && "code" in options
                ? options.code
                : undefined;
            if (code !== "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED")
              Reflect.apply(emitWarning, process, [warning, ...rest]);
          });
        yield* Effect.addFinalizer(() => Effect.sync(() => warned.mockRestore()));
        let revoke = true;
        const target: AgentHost = {
          ...real,
          open: (options) =>
            Effect.sync(() => {
              if (revoke) writeFileSync(f.signedOut, "Synthetic revoke after readiness");
            }).pipe(Effect.andThen(real.open(options))),
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(
              serverLayer(world, {}, adapters(target)).pipe(Layer.provideMerge(logs.layer)),
            );
            yield* Effect.gen(function* () {
              const project = yield* openProject(world),
                orchestration = yield* Orchestration,
                store = yield* ThreadStore,
                rt = yield* ThreadRuntimes;
              const state = yield* orchestration.saveWorkspace({
                name: "Synthetic repaired retry",
                projectIds: [project.id],
                homeProjectId: project.id,
                charter: {
                  ...DEFAULT_CHARTER,
                  autonomy: "full",
                  orchestratorModel: { agent: "codex", model: "fake-opus" },
                },
              });
              const thread = yield* orchestration.open({ workspaceId: state.workspace.id }),
                source = yield* waitSent(thread.id, 1);
              yield* completeTurn(source);
              yield* orchestration.handoff(state.workspace.id, "user", {
                agent: "claude",
                model: "fixture-small",
              });
              yield* waitSent(thread.id, 2);
              yield* rt.send(thread.id, { text: "Retain through repaired retry" });
              yield* source.completeTurn();
              const failed = yield* waitReal(
                "closed pre-spawn target",
                store
                  .getThread(thread.id)
                  .pipe(
                    Effect.map((t) =>
                      t.sessionSwitch?.phase === "failed" ? t.sessionSwitch : undefined,
                    ),
                  ),
              );
              expect(source.closed).toBe(true);
              expect(failed.oldExited).toBe(true);
              expect(failed.targetRelease).toBe("notStarted");
              expect((yield* store.listQueue(thread.id)).map((item) => item.input.text)).toEqual([
                "Retain through repaired retry",
              ]);
              revoke = false;
              rmSync(f.signedOut);
              const retry = yield* orchestration.retrySwitch(state.workspace.id);
              expect(retry.sessionSwitch!.id).not.toBe(failed.id);
              expect(retry.sessionSwitch!.targetRelease).toBeUndefined();
              expect(retry.sessionSwitch!.retryFrom).toEqual({
                id: failed.id,
                release: "notStarted",
              });
              yield* waitReal(
                "repaired target connected and booted",
                store.getThread(thread.id).pipe(Effect.map((t) => t.sessionSwitch === undefined)),
              );
              expect((yield* store.getThread(thread.id)).model).toEqual({
                agent: "claude",
                model: "fixture-small",
              });
              expect(
                (yield* store.getWorkspace(state.workspace.id)).charter.orchestratorModel,
              ).toEqual({ agent: "claude", model: "fixture-small" });
              expect(
                (yield* store.getWorkspace(state.workspace.id)).workspace.orchestratorThreadId,
              ).toBe(thread.id);
            }).pipe(Effect.provide(context));
          }),
        );
        // The revoked sign-in fails the first target, which is the warning this test is about.
        expect(logs.warnings().map(({ message, annotations }) => [message, annotations])).toEqual([
          [
            "agent unavailable",
            expect.objectContaining({ agent: "claude", reason: "not-logged-in" }),
          ],
          ["orchestrator switch did not complete", expect.anything()],
        ]);
        expect(warned).toHaveBeenCalledWith(
          expect.stringContaining("canUseTool will not be invoked"),
          expect.objectContaining({ code: "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED" }),
        );
      }),
    ),
  30000,
);
