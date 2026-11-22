import { HostId, WORKER_MACHINE_RELAYS_MOST } from "@gram/contracts";
import type { RemoteHostsShape } from "../host/remote-hosts.ts";
import type { ProvidedMachine } from "./worker-machines.ts";

/**
 * The most machines from hosted servers this Gram carries at once: registered and not asleep
 * there, so the app relays them. Below the app's own bound (`APP_RELAYS_MOST`). A machine its
 * server says is stopped isn't counted.
 */
export const RELAYED_MOST = 32;
/** The most relays the app takes in one list: it drops a longer list whole. */
export const APP_RELAYS_MOST = WORKER_MACHINE_RELAYS_MOST;

/** The machines from hosted servers this Gram carries now: those it relays (`RELAYED_MOST`). */
export const carriedOf = (
  machines: ReadonlyArray<ProvidedMachine>,
  asleep: ReadonlySet<string> | undefined,
) => machines.filter((each) => each.via !== undefined && asleep?.has(each.name) !== true);

/**
 * Why there's no room for another machine from a hosted server, or undefined while there is: at
 * `RELAYED_MOST` carried, with how many of them are online and what keeps the rest.
 */
export const noRoomWords = (
  machines: ReadonlyArray<ProvidedMachine>,
  asleep: ReadonlySet<string> | undefined,
): string | undefined => {
  const held = carriedOf(machines, asleep);
  if (held.length < RELAYED_MOST) return undefined;
  const online = held.filter((each) => each.onlineSince !== undefined).length;
  return `This Gram already carries ${held.length} machines from hosted servers, the most it carries at once: ${online} online now, the rest not yet stopped there. A machine stops counting once its server stops it, which it does after its workers are archived. Archive workers you're done with, then spawn again.`;
};

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
