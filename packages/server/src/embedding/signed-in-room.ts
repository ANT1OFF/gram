import { HostId, WORKER_MACHINE_RELAYS_MOST } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { RemoteHostsShape } from "../host/remote-hosts.ts";
import type { StopMarks } from "../host/stop-marks.ts";
import type { ThreadStore } from "../persistence/thread-store.ts";
import { hostedMachineInUse, type UsedMachine } from "./hosted-machine-use.ts";
import { isLegacyRelayed, type MachinesInUse } from "./signed-in-reclaim.ts";
import type { ProvidedMachine } from "./worker-machines.ts";

/**
 * The most machines from hosted servers this Gram carries at once: registered and not asleep
 * there, so the app relays them. Below the app's own bound (`APP_RELAYS_MOST`). A machine its
 * server says is stopped isn't counted, and one nothing here needs is given back to make room.
 */
export const RELAYED_MOST = 32;
/** The most relays the app takes in one list: it drops a longer list whole. */
export const APP_RELAYS_MOST = WORKER_MACHINE_RELAYS_MOST;

/** The machines from hosted servers this Gram carries now: those it relays (`RELAYED_MOST`). */
export const carriedOf = (
  machines: ReadonlyArray<ProvidedMachine>,
  asleep: ReadonlySet<string> | undefined,
) => machines.filter((each) => each.via !== undefined && asleep?.has(each.name) !== true);

const fullWords = (held: ReadonlyArray<ProvidedMachine>) =>
  `This Gram already carries ${held.length} machines from hosted servers, the most it carries at once (${held.filter((each) => each.onlineSince !== undefined).length} online now), and none could be given back: each has a worker that isn't archived, a wake or resume waiting for it, joined within the last 30 minutes, or is another sign-in's. Archive workers you're done with, or wait for a machine to stop there, then spawn again.`;

/**
 * Makes room for one more machine, `name`: at `RELAYED_MOST` carried, gives back the oldest of
 * this sign-in's (`mine`) that nothing here needs (`inUse`), as many as it takes. Undefined: there
 * is room; else why there isn't. Without `inUse`, nothing is given back.
 */
export const roomForOne = (
  deps: {
    readonly hosts: { readonly list: () => ReadonlyArray<ProvidedMachine> };
    readonly asleep?: ReadonlySet<string> | undefined;
    readonly inUse?: MachinesInUse | undefined;
  },
  mine: (machine: ProvidedMachine) => boolean,
  giveBack: (name: string) => Effect.Effect<boolean>,
  name: string,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    for (let tries = 0; ; tries += 1) {
      const held = carriedOf(deps.hosts.list(), deps.asleep);
      if (held.length < RELAYED_MOST) return undefined;
      const used = deps.inUse === undefined ? undefined : yield* deps.inUse;
      const spare =
        used === undefined || tries >= RELAYED_MOST
          ? undefined
          : held
              .filter(
                (each) => mine(each) && each.name !== name && !isLegacyRelayed(each) && !used(each),
              )
              .toSorted((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0))[0];
      if (spare === undefined || !(yield* giveBack(spare.name))) return fullWords(held);
    }
  });

/**
 * Which registered machines something here needs (`hostedMachineInUse`), from the threads now;
 * every one, when they can't be read.
 */
export const machinesInUse = (
  store: Pick<ThreadStore["Service"], "listThreads">,
  stops: Pick<StopMarks, "wanted" | "owes" | "holding" | "awaited" | "restedOf">,
  starting: ReadonlySet<string>,
): MachinesInUse =>
  store.listThreads.pipe(
    Effect.map(
      (threads) => (machine: UsedMachine) =>
        hostedMachineInUse(machine, threads, stops, Date.now(), starting),
    ),
    Effect.orElseSucceed(() => () => true),
  );

/** The relays the app is asked to carry: every worker machine not asleep, to `APP_RELAYS_MOST`. */
export const relaysOf = (
  hosts: Pick<RemoteHostsShape, "list" | "stops">,
  asleep: ReadonlySet<string>,
) =>
  firstRelayed(
    hosts
      .list()
      .filter(
        (machine) =>
          machine.via !== undefined && machine.onDemand === "worker" && !asleep.has(machine.name),
      ),
    (machine) => hosts.stops.wantedSince(HostId.make(machine.id)) !== undefined,
  ).map((machine) => ({
    origin: machine.via!,
    name: machine.name,
    ...(machine.viaAccount === undefined ? {} : { account: machine.viaAccount }),
  }));

/**
 * The machines to relay, at most `APP_RELAYS_MOST`: past it, online ones first, then ones something
 * waits to be started, then the newest. In the order listed while within it.
 */
export const firstRelayed = <
  M extends { readonly onlineSince?: number | undefined; readonly joinedAt?: number | undefined },
>(
  machines: ReadonlyArray<M>,
  wanted: (machine: M) => boolean,
): ReadonlyArray<M> => {
  if (machines.length <= APP_RELAYS_MOST) return machines;
  const rank = (machine: M) => (machine.onlineSince !== undefined ? 0 : wanted(machine) ? 1 : 2);
  return machines
    .toSorted((a, b) => rank(a) - rank(b) || (b.joinedAt ?? 0) - (a.joinedAt ?? 0))
    .slice(0, APP_RELAYS_MOST);
};
