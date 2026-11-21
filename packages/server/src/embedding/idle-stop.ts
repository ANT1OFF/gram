import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Orchestration } from "../orchestration/service.ts";
import { answer, EmbedInbound } from "./inbound.ts";

/** Serves `idle-stop`; provides nothing. */
export const IdleStopInboundLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const inbound = yield* EmbedInbound;
    const orchestration = yield* Orchestration;
    yield* inbound.route("POST", "idle-stop", () =>
      orchestration.compactIdleBeforeStop.pipe(Effect.map((result) => answer(result))),
    );
  }),
);
