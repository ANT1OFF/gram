// The hosted features setting (`experimental.embedding`), which every feature for running Gram
// behind another service sits behind: how a server with no window takes it from its environment,
// and how server code reads it.

import { applySettingsPatch, embeddingOn } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import { ThreadStore } from "../persistence/thread-store.ts";

/** Only the app on this machine changes the hosted features setting, never a paired phone. */
export const EMBEDDING_LOCAL_ONLY =
  "Hosted features are turned on or off in the Gram app on this machine, or with GRAM_EMBEDDING where the server runs.";

/** Whether the hosted features are on now, as the stored setting says. */
export const embeddingEnabled: Effect.Effect<boolean, never, ThreadStore> = Effect.gen(
  function* () {
    return embeddingOn(yield* (yield* ThreadStore).getSettings);
  },
);

/**
 * Writes `GRAM_EMBEDDING` (`ServerConfig.embedding`) into the stored setting as the server starts,
 * so the setting stays the one thing anything reads. Without the variable the setting is left as
 * it is.
 */
export const seedEmbedding: Effect.Effect<void, never, ServerConfig | ThreadStore> = Effect.gen(
  function* () {
    const { embedding } = yield* ServerConfig;
    if (embedding === undefined) return;
    const store = yield* ThreadStore;
    if (embeddingOn(yield* store.getSettings) === embedding) return;
    yield* store.updateSettings(
      (settings) => applySettingsPatch(settings, { experimental: { embedding } }),
      [["experimental", "embedding"]],
    );
  },
);

/** `store` with `GRAM_EMBEDDING` applied before anything above it reads the settings. */
export const withEmbeddingSeed = <A, E, R>(
  store: Layer.Layer<A | ThreadStore, E, R>,
): Layer.Layer<A | ThreadStore, E, R | ServerConfig> =>
  Layer.effectDiscard(seedEmbedding).pipe(Layer.provideMerge(store));
