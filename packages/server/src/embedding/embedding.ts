// The seams an embedding deployment uses (`config.ts`), and the one switch over all of them: the
// hosted features setting. With it off every seam is inert, whatever the environment configured,
// and the server behaves as the desktop app's own does.

import { embeddingOn } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { NO_EMBED, type EmbedConfigShape } from "./config.ts";

export interface EmbeddingShape {
  readonly config: EmbedConfigShape;
  /** Whether the hosted features setting is on now. A setting, so asked each time it matters. */
  readonly on: Effect.Effect<boolean>;
}

export class Embedding extends Context.Service<Embedding, EmbeddingShape>()(
  "@gram/server/Embedding",
) {
  static readonly layer = Layer.effect(
    Embedding,
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const { embed } = yield* ServerConfig;
      return Embedding.of({
        config: embed ?? NO_EMBED,
        on: Effect.map(store.getSettings, embeddingOn),
      });
    }),
  );

  /** A fixed configuration, on unless `on` says otherwise: for tests. */
  static readonly layerOf = (
    config: Partial<EmbedConfigShape>,
    on: Effect.Effect<boolean> = Effect.succeed(true),
  ): Layer.Layer<Embedding> =>
    Layer.succeed(Embedding, Embedding.of({ config: { ...NO_EMBED, ...config }, on }));
}

/** The embedding seams where the server has them; `undefined` in a test that builds none. */
export const embeddingOption = Effect.map(Effect.serviceOption(Embedding), (found) =>
  found._tag === "Some" ? found.value : undefined,
);
