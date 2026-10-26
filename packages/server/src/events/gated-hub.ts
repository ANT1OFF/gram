// For tests: an `EventHub` over the real one that holds the first matching publish until a gate opens,
// so a test can interrupt the publishing fiber at a known point.

import type { ServerEvent } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EventHub } from "./event-hub.ts";

export interface PublishGate {
  /** Opens once a matching event is being published. */
  readonly started: Deferred.Deferred<void>;
  /** The matching publish waits for this. */
  readonly gate: Deferred.Deferred<void>;
}

export const makePublishGate = Effect.gen(function* () {
  return {
    started: yield* Deferred.make<void>(),
    gate: yield* Deferred.make<void>(),
  } satisfies PublishGate;
});

/** Provide to the service under test only; its `EventHub` requirement is the real hub. */
export const gatedHubLayer = (
  match: (event: ServerEvent) => boolean,
  current: () => PublishGate | undefined,
): Layer.Layer<EventHub, never, EventHub> =>
  Layer.effect(
    EventHub,
    Effect.gen(function* () {
      const hub = yield* EventHub;
      return {
        ...hub,
        publish: (event: ServerEvent) =>
          Effect.gen(function* () {
            const gate = current();
            if (gate !== undefined && match(event)) {
              yield* Deferred.succeed(gate.started, undefined);
              yield* Deferred.await(gate.gate);
            }
            yield* hub.publish(event);
          }),
      };
    }),
  );
