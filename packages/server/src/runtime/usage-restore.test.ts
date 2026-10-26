import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentAdapter, FakeAgentControl } from "./fake-agent.ts";
import { CheckoutService, TurnHooks } from "./hooks.ts";
import { TEST_CONFIG, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

const layerAt = (file: string) =>
  AppToolRegistry.layer.pipe(
    Layer.provideMerge(ThreadRuntimes.layer),
    Layer.provideMerge(EventHub.layer),
    Layer.provideMerge(ThreadStore.layerSqlite(file)),
    Layer.provideMerge(FakeAgentAdapter),
    Layer.provideMerge(TurnHooks.layerNoop),
    Layer.provideMerge(CheckoutService.layerNoGit),
    Layer.provideMerge(ServerConfig.layer(TEST_CONFIG)),
    Layer.orDie,
  );

describe("usage across a restart", () => {
  it.effect("shows the last turn's usage for a cold thread and seeds its resumed session", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-usage-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      const file = join(dir, "gram.db");
      const usage = {
        tokens: { inputTokens: 42_000, outputTokens: 1_200 },
        contextWindow: 200_000,
        costUsd: 1.5,
      };

      const threadId = yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        const thread = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/repo" },
          input: { text: "one" },
        });
        const session = yield* waitFor(
          "the first send",
          fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
        );
        yield* session.emit({ type: "usage", ...usage }, { type: "turnEnd", reason: "completed" });
        yield* waitFor(
          "the turn's usage persisted",
          store.lastTurnUsage(thread.id).pipe(Effect.map((u) => u !== undefined)),
        );
        return thread.id;
      }).pipe(Effect.provide(layerAt(file)));

      yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        const [cold] = yield* runtimes.snapshot;
        expect(cold?.status).toBe("cold");
        // Saved with the turn's anchor, which idle compaction plans from.
        expect(cold?.usage).toEqual({ ...usage, lastRequestAt: expect.any(Number) });

        // The resumed session hasn't reported yet: the meter keeps the last value, not zero.
        yield* runtimes.send(threadId, { text: "two" });
        const session = yield* waitFor(
          "the resumed session's send",
          fake.latest(threadId).pipe(Effect.map((s) => s.sent.length === 1 && s)),
        );
        const [resumed] = yield* runtimes.snapshot;
        expect(resumed?.status).not.toBe("cold");
        expect(resumed?.usage).toEqual({ ...usage, lastRequestAt: expect.any(Number) });

        // An agent prices a resumed session from zero; the thread's cost counts on.
        const tokens = { inputTokens: 900, outputTokens: 40 };
        yield* session.emit({ type: "usage", tokens, costUsd: 0.25 });
        yield* waitFor(
          "the resumed session's cost",
          runtimes.snapshot.pipe(Effect.map(([t]) => t?.usage?.tokens.inputTokens === 900)),
        );
        const [charged] = yield* runtimes.snapshot;
        expect(charged?.usage).toEqual({ tokens, costUsd: 1.75 });
      }).pipe(Effect.provide(layerAt(file)));
    }).pipe(Effect.scoped),
  );
});
