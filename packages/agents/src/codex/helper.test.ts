import { describe, expect, it } from "@effect/vitest";
import { existsSync, rmSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { codexHelperFixture } from "./helper-fixture.ts";
import { GatewayKeyProvider } from "../gateway.ts";
import { HelperTransportError } from "../helper.ts";
import { makeCodexHelper } from "./helper.ts";
import { CODEX_HELPER_SUBSCRIPTION_BASE_URL } from "./helper-policy.ts";
import { CodexHost } from "./session.ts";
import { CodexHostLive } from "./live.ts";
import { CodexServers, CodexServersLive } from "./servers.ts";

const call = {
  model: "gpt-6-luna",
  effort: "high" as const,
  speed: "standard" as const,
  system: "Synthetic JSON helper",
  prompt: "Invented opening context",
  maxOutputTokens: 2000,
  authorize: (enqueue: () => void) => Effect.sync(enqueue),
};
const fixture = (extra: Record<string, string> = {}) => {
  const f = codexHelperFixture(extra);
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R | CodexServers>) =>
    effect.pipe(
      Effect.provide(CodexServersLive(f.config)),
      Effect.provide(GatewayKeyProvider.layerNone),
      Effect.scoped,
    );
  return { ...f, provide };
};

describe("only-Codex guided subscription helper child", () => {
  it.effect("rejects alternate inference endpoints before delivering any helper context", () => {
    const f = fixture({
      GRAM_HELPER_RETURNED_BASE_URL: "https://invented-provider.example.invalid/v1",
    });
    return f
      .provide(
        Effect.gen(function* () {
          const adapter = makeCodexHelper(f.config, yield* GatewayKeyProvider);
          const discoveryFailure = yield* adapter.models.pipe(Effect.flip);
          expect(discoveryFailure.failure).toBe("restriction");
          expect(discoveryFailure.detail).toContain("ChatGPT subscription endpoint");
          const outcome = yield* adapter.generate(call).pipe(
            Effect.match({
              onSuccess: () => "success",
              onFailure: (error) => error.failure,
            }),
          );
          expect({ outcome, sent: f.rows().filter((row) => row.userSent).length }).toEqual({
            outcome: "restriction",
            sent: 0,
          });
          expect(f.rows().some((row) => row.method === "thread/start")).toBe(false);
          expect(f.rows().some((row) => row.method === "model/list")).toBe(false);
        }),
      )
      .pipe(Effect.ensuring(Effect.sync(() => rmSync(f.root, { recursive: true, force: true }))));
  });

  it.effect(
    "pins the subscription route over inherited TOML without changing ordinary sessions",
    () => {
      const inherited = "https://invented-provider.example.invalid/v1";
      const f = fixture({ GRAM_HELPER_TOML_BASE_URL: inherited });
      return f
        .provide(
          Effect.gen(function* () {
            const ordinary = yield* (yield* CodexServers).acquire(undefined, "user");
            const adapter = makeCodexHelper(f.config, yield* GatewayKeyProvider);
            expect((yield* adapter.models)[0]?.id).toBe("gpt-6-luna");
            expect(yield* adapter.generate(call)).toEqual({ text: '{"goal":"synthetic"}' });
            const thread = f.rows().find((row) => row.method === "thread/start")?.params as {
              config: Record<string, unknown>;
            };
            expect(thread.config.openai_base_url).toBe(CODEX_HELPER_SUBSCRIPTION_BASE_URL);
            expect(
              f
                .rows()
                .filter((row) => row.effectiveBaseUrl)
                .map((row) => row.effectiveBaseUrl),
            ).toEqual([CODEX_HELPER_SUBSCRIPTION_BASE_URL, CODEX_HELPER_SUBSCRIPTION_BASE_URL]);
            const normal = yield* ordinary.rpc.request("config/read", { includeLayers: false });
            expect(normal.config.openai_base_url).toBe(inherited);
            expect(f.rows().filter((row) => row.userSent)).toHaveLength(1);
          }),
        )
        .pipe(Effect.ensuring(Effect.sync(() => rmSync(f.root, { recursive: true, force: true }))));
    },
  );
  it.effect("concurrent helper scopes never share or retire the ordinary host server", () => {
    const f = fixture({ GRAM_HELPER_WAIT: "1" });
    return f
      .provide(
        Effect.gen(function* () {
          const servers = yield* CodexServers;
          const ordinary = yield* servers.acquire(undefined, "user");
          const adapter = makeCodexHelper(f.config, yield* GatewayKeyProvider);
          const admitted = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
          const fibers = yield* Effect.forEach(admitted, (signal) =>
            Effect.forkScoped(
              adapter.generate({
                ...call,
                authorize: (enqueue) =>
                  Effect.sync(() => {
                    enqueue();
                    signal.resolve();
                  }),
              }),
            ),
          );
          yield* Effect.promise(() => Promise.all(admitted.map((signal) => signal.promise)));
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                const deadline = Date.now() + 2000;
                const check = () =>
                  f.rows().filter((row) => row.userSent).length === 2
                    ? resolve()
                    : Date.now() > deadline
                      ? reject(new Error("Two synthetic deliveries did not arrive"))
                      : setTimeout(check, 5);
                check();
              }),
          );
          const starts = f.rows().filter((row) => row.start);
          expect(starts).toHaveLength(3);
          expect(new Set(starts.map((row) => row.pid)).size).toBe(3);
          const helpers = starts.filter((row) =>
            (row.args as Array<string>).includes("features.stable_environment_tools=false"),
          );
          expect(helpers).toHaveLength(2);
          expect(new Set(helpers.map((row) => row.cwd)).size).toBe(2);
          yield* Fiber.interrupt(fibers[0]!);
          expect(f.rows().filter((row) => row.stopped)).toHaveLength(1);
          expect((yield* servers.running).map((row) => row.server)).toEqual([ordinary]);
          expect(
            (yield* ordinary.rpc.request("account/read", { refreshToken: false })).account?.type,
          ).toBe("chatgpt");
          yield* Fiber.interrupt(fibers[1]!);
          expect(f.rows().filter((row) => row.stopped)).toHaveLength(2);
          expect(
            (yield* ordinary.rpc.request("account/read", { refreshToken: false })).account?.type,
          ).toBe("chatgpt");
          for (const row of helpers) expect(existsSync(String(row.cwd))).toBe(false);
        }),
      )
      .pipe(
        Effect.tap(() =>
          Effect.sync(() => expect(f.rows().filter((row) => row.stopped)).toHaveLength(3)),
        ),
        Effect.ensuring(Effect.sync(() => rmSync(f.root, { recursive: true, force: true }))),
      );
  });
  it.effect("expires a stalled child at the helper TTL and cleans up", () => {
    const f = fixture({ GRAM_HELPER_WAIT: "1" });
    return f
      .provide(
        Effect.gen(function* () {
          const adapter = makeCodexHelper(f.config, yield* GatewayKeyProvider);
          const admitted = Promise.withResolvers<void>();
          const fiber = yield* Effect.forkScoped(
            adapter
              .generate({
                ...call,
                authorize: (enqueue) =>
                  Effect.sync(() => {
                    enqueue();
                    admitted.resolve();
                  }),
              })
              .pipe(Effect.flip),
          );
          yield* Effect.promise(() => admitted.promise);
          yield* TestClock.adjust("21 seconds");
          expect((yield* Fiber.join(fiber)).failure).toBe("unavailable");
          expect(f.rows().some((row) => row.stopped)).toBe(true);
          for (const row of f.rows().filter((entry) => entry.start))
            expect(existsSync(String(row.cwd))).toBe(false);
        }),
      )
      .pipe(Effect.ensuring(Effect.sync(() => rmSync(f.root, { recursive: true, force: true }))));
  });

  it.effect(
    "discovers, delivers exact Luna High Standard with environment access disabled and retires child",
    () => {
      const f = fixture();
      return f
        .provide(
          Effect.gen(function* () {
            const context = yield* Layer.build(
              CodexHostLive({ servers: f.config }).pipe(
                Layer.provide(Layer.succeed(GatewayKeyProvider)(yield* GatewayKeyProvider)),
              ),
            );
            const host = Context.get(context, CodexHost);
            expect(
              host.helper,
              "Codex host must expose subscription helper generation",
            ).toBeDefined();
            const adapter = host.helper!;
            expect(adapter.mode).toBe("guided");
            expect((yield* adapter.models)[0]).toMatchObject({
              id: "gpt-6-luna",
              efforts: ["low", "high"],
            });
            expect(yield* adapter.generate(call)).toEqual({ text: '{"goal":"synthetic"}' });
            const rows = f.rows();
            expect(rows.filter((row) => row.userSent)).toHaveLength(1);
            for (const row of rows.filter((entry) => entry.start)) {
              expect(row.apiEnvironment).toEqual([]);
              expect(row.path).toBe(f.root);
              expect(existsSync(String(row.cwd))).toBe(false);
              expect(row.args).toContain("features.stable_environment_tools=false");
              expect(row.args).toContain("features.shell_tool=false");
              expect(row.args).toContain("agents.enabled=false");
              expect(row.args).toContain(`openai_base_url="${CODEX_HELPER_SUBSCRIPTION_BASE_URL}"`);
            }
            const params = rows.find((row) => row.method === "thread/start")?.params as Record<
              string,
              unknown
            >;
            expect(params).toMatchObject({
              model: "gpt-6-luna",
              ephemeral: true,
              environments: [],
              dynamicTools: [],
              approvalPolicy: "never",
              sandbox: "read-only",
              serviceTier: "default",
              allowProviderModelFallback: false,
              config: {
                mcp_servers: { private_connector: { enabled: false } },
                apps: { private_app: { enabled: false }, _default: { enabled: false } },
                features: { apps: false, plugins: false, hooks: false },
              },
            });
            expect(rows.find((row) => row.method === "turn/start")).toMatchObject({
              model: "gpt-6-luna",
              effort: "high",
              serviceTier: "default",
              environments: [],
              approvalPolicy: "never",
              sandboxPolicy: { type: "readOnly", networkAccess: false },
            });
            expect(rows.filter((row) => row.stopped)).toHaveLength(2);
          }),
        )
        .pipe(Effect.ensuring(Effect.sync(() => rmSync(f.root, { recursive: true, force: true }))));
    },
  );
  for (const [extra, failure, delivery] of [
    [{ GRAM_HELPER_AUTH: "off" }, "auth", false],
    [{ GRAM_HELPER_AUTH: "api" }, "auth", false],
    [{ GRAM_HELPER_UNSAFE: "1" }, "restriction", false],
    [{ GRAM_HELPER_UNSAFE_CONFIG: "1" }, "restriction", false],
    [{ GRAM_HELPER_VERSION: "unknown" }, "unavailable", false],
    [{ GRAM_HELPER_MODEL_SUBSTITUTE: "1" }, "restriction", false],
    [{ GRAM_HELPER_INTERACTIVE: "1" }, "restriction", true],
    [{ GRAM_HELPER_TOOL: "1" }, "restriction", true],
    [{ GRAM_HELPER_VERSION: "0.159.2" }, "unavailable", false],
  ] as const)
    it.effect(`refuses ${Object.keys(extra)[0]} without alternate billing or provider`, () => {
      const f = fixture(extra);
      return f
        .provide(
          Effect.gen(function* () {
            const adapter = makeCodexHelper(f.config, yield* GatewayKeyProvider);
            expect((yield* adapter.generate(call).pipe(Effect.flip)).failure).toBe(failure);
            expect(f.rows().some((row) => row.userSent)).toBe(delivery);
            expect(f.rows().some((row) => row.start)).toBe(!("GRAM_HELPER_VERSION" in extra));
          }),
        )
        .pipe(Effect.ensuring(Effect.sync(() => rmSync(f.root, { recursive: true, force: true }))));
    });
  it.effect(
    "rechecks authorization after startup before enqueue, without delivering revoked context",
    () => {
      const f = fixture();
      return f
        .provide(
          Effect.gen(function* () {
            const adapter = makeCodexHelper(f.config, yield* GatewayKeyProvider);
            const result = yield* adapter
              .generate({
                ...call,
                authorize: () => Effect.fail(new HelperTransportError({ failure: "restriction" })),
              })
              .pipe(Effect.flip);
            expect(result.failure).toBe("restriction");
            expect(f.rows().some((row) => row.method === "thread/start")).toBe(true);
            expect(f.rows().some((row) => row.userSent)).toBe(false);
          }),
        )
        .pipe(Effect.ensuring(Effect.sync(() => rmSync(f.root, { recursive: true, force: true }))));
    },
  );
  it.effect("cancellation retires the isolated process and removes scratch", () => {
    const f = fixture({ GRAM_HELPER_WAIT: "1" });
    return f
      .provide(
        Effect.gen(function* () {
          const adapter = makeCodexHelper(f.config, yield* GatewayKeyProvider);
          const sent = Promise.withResolvers<void>();
          const fiber = yield* Effect.forkScoped(
            adapter.generate({
              ...call,
              authorize: (enqueue) =>
                Effect.sync(() => {
                  enqueue();
                  sent.resolve();
                }),
            }),
          );
          yield* Effect.promise(() => sent.promise);
          // The child protocol acknowledges delivery; this short bounded wait is fixture-only.
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                const deadline = Date.now() + 2000;
                const check = () =>
                  f.rows().some((row) => row.userSent)
                    ? resolve()
                    : Date.now() > deadline
                      ? reject(new Error("No synthetic delivery"))
                      : setTimeout(check, 5);
                check();
              }),
          );
          yield* Fiber.interrupt(fiber);
          expect(f.rows().some((row) => row.stopped)).toBe(true);
          for (const row of f.rows().filter((entry) => entry.start))
            expect(existsSync(String(row.cwd))).toBe(false);
        }),
      )
      .pipe(Effect.ensuring(Effect.sync(() => rmSync(f.root, { recursive: true, force: true }))));
  });
});
