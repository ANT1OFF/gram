import type { ServerEvent } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import type { RemoteHostsShape } from "./remote-hosts.ts";

/**
 * Sends every client `machines.snapshot` when the machines' states change, so a thread that runs on
 * another machine shows where, and whether that machine is dialled in, without asking. Pushed by
 * the registry's own changes (`RemoteHostsShape.watch`): nothing polls. A change that leaves the
 * states as they were last sent publishes nothing.
 */
export const publishMachineStates = (
  hub: { readonly publish: (event: ServerEvent) => Effect.Effect<void> },
  hosts: Pick<RemoteHostsShape, "states" | "watch">,
) =>
  Effect.gen(function* () {
    const run = yield* FiberSet.makeRuntime<never>();
    // A client that connects is sent the states as they stand, so only what differs is news.
    let sent = JSON.stringify(hosts.states());
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        hosts.watch(() => {
          // Read when it runs, not when it was asked for: whichever of two quick changes runs
          // last sends the states as they then stand.
          run(
            Effect.suspend(() => {
              const machines = hosts.states();
              const next = JSON.stringify(machines);
              if (next === sent) return Effect.void;
              sent = next;
              return hub.publish({ type: "machines.snapshot", machines });
            }),
          );
        }),
      ),
      (unwatch) => Effect.sync(unwatch),
    );
  });
