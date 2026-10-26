import { expect, it } from "@effect/vitest";
import { GitError, type TurnId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { makeFakeAgentAdapter } from "./fake-agent.ts";
import { CheckoutService, TurnHooks } from "./hooks.ts";
import { TEST_CONFIG } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

// Synthetic SQLite and the fake agent only; no provider, CLI or host auth is touched.
const runtimeAt = (file: string) =>
  AppToolRegistry.layer.pipe(
    Layer.provideMerge(ThreadRuntimes.layer),
    Layer.provideMerge(EventHub.layer),
    Layer.provideMerge(ThreadStore.layerSqlite(file)),
    Layer.provideMerge(makeFakeAgentAdapter({})),
    Layer.provideMerge(TurnHooks.layerNoop),
    Layer.provideMerge(CheckoutService.layerNoGit),
    Layer.provideMerge(ServerConfig.layer(TEST_CONFIG)),
    Layer.orDie,
  );

for (const interruption of [false, true])
  it.effect(
    `rewind checkpoint ${interruption ? "interruption" : "failure"} rolls back SQL and reopens intact history`,
    () =>
      Effect.gen(function* () {
        const directory = mkdtempSync(join(tmpdir(), "gram-rewind-abort-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
        );
        const file = join(directory, "gram.db");
        const saved = yield* Effect.gen(function* () {
          const rt = yield* ThreadRuntimes;
          const store = yield* ThreadStore;
          const thread = yield* rt.create({
            deferOpen: true,
            projectRoot: directory,
            checkout: { kind: "main", path: directory },
            model: { agent: "codex", model: "fake-codex" },
          });
          yield* store.insertThread({
            ...thread,
            agentSessionId: "ordinary-rollback-native",
            codexHome: "owned",
          });
          yield* store.upsertMessage(
            thread.id,
            {
              id: "saved",
              role: "user",
              parts: [{ type: "text", text: "must survive checkpoint failure" }],
            },
            "saved-turn" as TurnId,
          );
          const before = yield* store.getThread(thread.id);
          const history = yield* store.listMessages(thread.id);
          const revision = yield* store.feedRevision(thread.id);
          const plan = yield* rt.rewindTarget(thread.id, "saved");
          const abort = interruption
            ? Effect.interrupt
            : Effect.fail(
                new GitError({ message: "synthetic checkpoint failure; no files touched" }),
              );
          expect((yield* rt.rewind(thread.id, plan, abort).pipe(Effect.exit))._tag).toBe("Failure");
          expect(yield* store.getThread(thread.id)).toEqual(before);
          expect(yield* store.listMessages(thread.id)).toEqual(history);
          expect(yield* store.feedRevision(thread.id)).toEqual(revision);
          return { id: thread.id, before, history, revision };
        }).pipe(Effect.provide(runtimeAt(file)), Effect.scoped);
        yield* Effect.gen(function* () {
          const store = yield* ThreadStore;
          expect(yield* store.getThread(saved.id)).toEqual(saved.before);
          expect(yield* store.listMessages(saved.id)).toEqual(saved.history);
          expect(yield* store.feedRevision(saved.id)).toEqual(saved.revision);
        }).pipe(Effect.provide(runtimeAt(file)), Effect.scoped);
      }),
  );
