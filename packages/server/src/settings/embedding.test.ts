import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it } from "vitest";
import { ServerConfig } from "../config.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
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
