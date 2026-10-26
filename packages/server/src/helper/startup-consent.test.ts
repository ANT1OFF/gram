import { describe, expect, it } from "@effect/vitest";
import { makeClaudeHelper, type ClaudeSdkShape } from "@gram/agents/claude";
import type { HelperProviderStatus, Settings, ThreadId } from "@gram/contracts";
import { existsSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ThreadStore } from "../persistence/thread-store.ts";
import { makeHelperScheduler } from "./scheduler.ts";
import { makeHelperStore } from "./store.ts";

const THREAD = "t-startup-consent" as ThreadId;
const discovery: HelperProviderStatus = {
  provider: "claude",
  state: "ready",
  models: [{ id: "haiku", displayName: "Haiku 5.5", supportsEffort: false }],
  detail: "Invented SDK discovery",
};
type Helpers = NonNullable<Settings["helpers"]>;
const changes: ReadonlyArray<{
  name: string;
  patch: Partial<Helpers>;
  kind?: "title";
  allowed?: boolean;
}> = [
  { name: "revoked destination consent", patch: { claudeContext: "off" } },
  { name: "reduced conversation consent", patch: { claudeContext: "opening" } },
  { name: "disabled all helpers", patch: { enabled: false } },
  { name: "disabled the feature", patch: { plan: false } },
  { name: "changed local source", patch: { source: "codex" } },
  { name: "selected gateway source", patch: { source: "gateway" } },
  { name: "changed saved effort", patch: { claudeEffort: "low" } },
  { name: "changed saved model", patch: { claudeModel: "different" } },
  { name: "changed fallback policy", patch: { localFallback: "none" } },
  { name: "revoked title consent", patch: { claudeContext: "off" }, kind: "title" },
  {
    name: "opening scope still permits a title",
    patch: { claudeContext: "opening" },
    kind: "title",
    allowed: true,
  },
  { name: "other provider consent is independent", patch: { codexContext: "off" }, allowed: true },
];

describe("authorization at local helper prompt delivery", () => {
  for (const phase of ["initialization", "model discovery"] as const) {
    for (const change of changes) {
      it.effect(`${change.name} during ${phase}`, () =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const project = yield* store.ensureProject({
            root: "/synthetic/consent",
            name: "consent",
          });
          yield* store.insertThread({
            id: THREAD,
            projectId: project.id,
            title: "synthetic",
            userNamed: false,
            model: { agent: "claude", model: "haiku" },
            mode: "default",
            checkout: { kind: "main", path: "/synthetic/consent" },
            labels: [],
            pinned: false,
            parked: false,
            unread: false,
            createdAt: 1,
            lastActivityAt: 1,
          });
          yield* store.updateSettings((s) => ({
            ...s,
            helpers: {
              source: "automatic",
              claudeContext: "conversation",
              codexContext: "conversation",
              localFallback: "automatic",
            },
          }));
          const waiting = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          const sent: Array<unknown> = [];
          let closed = false;
          let scratch = "";
          const pause = async () => {
            waiting.resolve();
            await release.promise;
          };
          const sdk = {
            query: ({ prompt, options }: Parameters<ClaudeSdkShape["query"]>[0]) => {
              scratch = options!.cwd!;
              return {
                initializationResult: async () => {
                  if (phase === "initialization") await pause();
                  return { fast_mode_state: "off" };
                },
                mcpServerStatus: async () => [],
                supportedModels: async () => {
                  if (phase === "model discovery") await pause();
                  return [{ value: "haiku", displayName: "Haiku 5.5", description: "" }];
                },
                close: () => {
                  closed = true;
                },
                async *[Symbol.asyncIterator]() {
                  if (typeof prompt === "string") throw new Error("Expected streaming input");
                  for await (const message of prompt) {
                    sent.push(message);
                    yield {
                      type: "result",
                      subtype: "success",
                      is_error: false,
                      result: '{"goal":"synthetic"}',
                      usage: { input_tokens: 1, output_tokens: 1 },
                      modelUsage: {},
                    };
                  }
                },
              };
            },
          } as unknown as ClaudeSdkShape;
          const helper = makeClaudeHelper(
            {
              prepare: Effect.succeed({
                binaryPath: "/synthetic/claude",
                cliVersion: "2.1.296",
                warnings: [],
                env: {},
              }),
              invalidate: Effect.void,
              checkAuth: () => Effect.void,
            },
            sdk,
          );
          const scheduler = yield* makeHelperScheduler({
            store,
            helperStore: yield* makeHelperStore,
            key: () => Effect.succeed(Option.none()),
            local: {
              inspect: Effect.succeed([discovery]),
              generate: (_provider, call) => helper.generate(call),
            },
          });
          const fiber = yield* Effect.forkScoped(
            scheduler.schedule({
              kind: change.kind ?? "plan",
              threadId: THREAD,
              lane: "interactive",
              basis: "initial",
              promptVersion: 1,
              system: "Synthetic material only",
              prompt: Effect.succeed("Synthetic conversation material"),
              output: Schema.Struct({ goal: Schema.String }),
            }),
          );
          yield* Effect.promise(() => waiting.promise);
          yield* store.updateSettings((s) => ({
            ...s,
            helpers: { ...s.helpers, ...change.patch },
          }));
          release.resolve();
          const result = yield* Fiber.join(fiber);
          expect(sent).toHaveLength(change.allowed ? 1 : 0);
          expect(result._tag).toBe(change.allowed ? "Done" : "Failed");
          if (!change.allowed) expect(result).toEqual({ _tag: "Failed", failure: "restriction" });
          expect(closed).toBe(true);
          expect(existsSync(scratch)).toBe(false);
        }).pipe(Effect.provide(ThreadStore.layerSqlite(":memory:")), Effect.scoped),
      );
    }
  }
});
