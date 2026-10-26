import { DEFAULT_REVIEW_BOTS, type ReviewBot } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * The review bots PR lookups recognise. A mutable cell rather than static config, so the server can
 * keep it in step with `settings.reviewBots` without rebuilding the git layers.
 */
export class ReviewBots extends Context.Service<
  ReviewBots,
  {
    readonly get: Effect.Effect<ReadonlyArray<ReviewBot>>;
    readonly set: (bots: ReadonlyArray<ReviewBot>) => Effect.Effect<void>;
  }
>()("@gram/git/ReviewBots") {
  static readonly layer = Layer.effect(
    ReviewBots,
    Effect.sync(() => {
      let bots: ReadonlyArray<ReviewBot> = DEFAULT_REVIEW_BOTS;
      return {
        get: Effect.sync(() => bots),
        set: (next) =>
          Effect.sync(() => {
            bots = next;
          }),
      };
    }),
  );
}
