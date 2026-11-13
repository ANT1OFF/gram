import type { MachineState, ServerEvent } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import type { RemoteHostsShape } from "./remote-hosts.ts";

/**
 * What of the states is news to a client. A connection that closed or moved is, with its time. A
 * dial that was refused (a signature its key didn't make, a clock off, no hello, another protocol)
 * is news once: the next one differs only in its time, and anyone on the tailnet who knows a
 * machine's id can send a badly signed dial as often as they like, which must not become an event
 * to every window each time. A clock's skew counts to the minute, as it is shown.
 */
export const machineNews = (machines: ReadonlyArray<MachineState>): string =>
  JSON.stringify(
    machines.map((machine) => {
      const offline = machine.offline;
      if (offline === undefined || !("at" in offline)) return machine;
      if (offline.kind === "lost" || offline.kind === "moved") return machine;
      const { at: _, ...reason } = offline;
      return {
        ...machine,
        offline:
          reason.kind === "clock"
            ? { ...reason, skewMs: Math.round(reason.skewMs / 60_000) }
            : reason,
      };
    }),
  );

/**
 * Sends every client `machines.snapshot` when the machines' states change, so a thread that runs on
 * another machine shows where, and whether that machine is dialled in, without asking. Pushed by
 * the registry's own changes (`RemoteHostsShape.watch`): nothing polls. A change that leaves the
 * states as they were last sent publishes nothing, and neither does a refused dial that only
 * repeats the last (`machineNews`).
 */
export const publishMachineStates = (
  hub: { readonly publish: (event: ServerEvent) => Effect.Effect<void> },
  hosts: Pick<RemoteHostsShape, "states" | "watch">,
) =>
  Effect.gen(function* () {
    const run = yield* FiberSet.makeRuntime<never>();
    // A client that connects is sent the states as they stand, so only what differs is news.
    let sent = machineNews(hosts.states());
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        hosts.watch(() => {
          // Read when it runs, not when it was asked for: whichever of two quick changes runs
          // last sends the states as they then stand.
          run(
            Effect.suspend(() => {
              const machines = hosts.states();
              const next = machineNews(machines);
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
