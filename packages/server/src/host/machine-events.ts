import type { HostId, MachineState, ServerEvent } from "@gram/contracts";
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
    let sent = machineNews(hosts.states());
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        hosts.watch(() => {
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

const onlineIn = (hosts: Pick<RemoteHostsShape, "states">): ReadonlySet<HostId> =>
  new Set(
    hosts.states().flatMap((machine) => (machine.onlineSince === undefined ? [] : [machine.id])),
  );

/**
 * Sends, when a machine comes online, what waits queued in the threads that run on it. A message
 * sent while the machine was offline stays queued (the send there failed), and the queue waits for
 * the folder to come back, which only the machine's joining tells. A machine that was already
 * online when this starts is the boot's (`sendQueuedAtBoot`).
 *
 * So does a machine back after a stop as its resume puts threads' folders back (`StopMarks.onReady`):
 * the queue doesn't open a session while they are being put back, and their coming back sends it.
 */
export const sendQueuedOnJoin = (
  runtimes: { readonly sendQueuedOn: (hostId: HostId) => Effect.Effect<void> },
  hosts: Pick<RemoteHostsShape, "states" | "watch"> & {
    readonly stops?: Pick<RemoteHostsShape["stops"], "onReady">;
  },
) =>
  Effect.gen(function* () {
    const run = yield* FiberSet.makeRuntime<never>();
    let online = onlineIn(hosts);
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        hosts.watch(() => {
          const now = onlineIn(hosts);
          const joined = [...now].filter((id) => !online.has(id));
          online = now;
          for (const id of joined) run(runtimes.sendQueuedOn(id));
        }),
      ),
      (unwatch) => Effect.sync(unwatch),
    );
    const stops = hosts.stops;
    if (stops === undefined) return;
    yield* Effect.acquireRelease(
      Effect.sync(() => stops.onReady((id) => void run(runtimes.sendQueuedOn(id)))),
      (unlisten) => Effect.sync(unlisten),
    );
  });
