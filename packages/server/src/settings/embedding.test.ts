import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it } from "vitest";
import { ServerConfig } from "../config.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { RECOMMENDED, type Settings } from "@gram/contracts";
import { tellShellEmbedding, withEmbeddingSeed } from "./embedding.ts";

const posted: Array<unknown> = [];
const withPort = () => {
  (process as { parentPort?: unknown }).parentPort = {
    postMessage: (message: unknown) => posted.push(message),
  };
};
afterEach(() => {
  delete (process as { parentPort?: unknown }).parentPort;
  posted.length = 0;
});

const started = (embedding: boolean | undefined) =>
  Effect.runPromise(
    Effect.scoped(
      Layer.build(
        withEmbeddingSeed(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie)).pipe(
          Layer.provide(
            Layer.succeed(ServerConfig)({ embedding } as unknown as ServerConfig["Service"]),
          ),
        ),
      ),
    ),
  );

describe("telling the desktop shell whether the hosted features are on", () => {
  it("tells it as the server starts, after GRAM_EMBEDDING is applied", async () => {
    withPort();
    await started(true);
    await started(undefined);
    expect(posted).toEqual([
      { type: "embedding", on: true },
      { type: "embedding", on: false },
    ]);
  });

  it("sends nothing where there is no shell", async () => {
    tellShellEmbedding(true);
    await started(true);
    expect(posted).toEqual([]);
  });
});

const settingsAfter = (headless: boolean, before?: Settings["agents"]["recommendedSetup"]) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        return (yield* store.getSettings).agents.recommendedSetup;
      }).pipe(
        Effect.provide(
          withEmbeddingSeed(
            Layer.effect(ThreadStore)(
              Effect.gen(function* () {
                const store = yield* ThreadStore;
                if (before !== undefined)
                  yield* store.updateSettings((s) => ({
                    ...s,
                    agents: { ...s.agents, recommendedSetup: before },
                  }));
                return store;
              }),
            ).pipe(Layer.provideMerge(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie))),
          ).pipe(
            Layer.provide(
              Layer.succeed(ServerConfig)({
                embedding: true,
                ...(headless ? { headless } : {}),
              } as unknown as ServerConfig["Service"]),
            ),
          ),
        ),
      ),
    ),
  );

describe("a headless server's recommended setup", () => {
  it("starts on, as a new install's welcome leaves it, since it has no welcome", async () => {
    expect(await settingsAfter(true)).toEqual({ enabled: true, seen: RECOMMENDED.version });
    expect(await settingsAfter(false)).toBeUndefined();
  });

  it("keeps a choice already saved", async () => {
    expect(await settingsAfter(true, { enabled: false })).toEqual({ enabled: false });
  });
});
