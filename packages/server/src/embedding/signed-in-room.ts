import { HostId, WORKER_MACHINE_RELAYS_MOST } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { RemoteHostsShape } from "../host/remote-hosts.ts";
import type { StartsSent } from "./signed-in-calls.ts";
import type { WorkerMachinePortShape } from "./signed-in-port.ts";
import { forgetReclaimed } from "./signed-in-reclaim.ts";
import type { ProvidedMachine } from "./worker-machines.ts";

/**
 * The most machines from hosted servers this Gram carries at once: registered and not asleep
 * there, so the app relays them. Below the app's own bound (`APP_RELAYS_MOST`). A machine its
 * server says is stopped isn't counted.
 */
export const RELAYED_MOST = 32;
/** The most relays the app takes in one list: it drops a longer list whole. */
export const APP_RELAYS_MOST = WORKER_MACHINE_RELAYS_MOST;

/**
 * Whether a machine from a hosted server rests: asleep (its server says it is stopped) or set
 * aside (`PairedMachine.setAside`). One that rests is neither relayed nor counted.
 */
export type Resting = (machine: { readonly id: string; readonly name: string }) => boolean;

/** Rests as `asleep` and `aside` say. */
export const restingBy =
  (asleep: ReadonlySet<string> | undefined, aside: (id: string) => boolean): Resting =>
  (machine) =>
    asleep?.has(machine.name) === true || aside(machine.id);

/** The machines from hosted servers this Gram carries now: those it relays (`RELAYED_MOST`). */
export const carriedOf = (machines: ReadonlyArray<ProvidedMachine>, resting: Resting) =>
  machines.filter((each) => each.via !== undefined && !resting(each));

/**
 * Why there's no room for another machine from a hosted server, or undefined while there is: at
 * `RELAYED_MOST` carried, with how many of them are online and what keeps the rest.
 */
export const noRoomWords = (
  machines: ReadonlyArray<ProvidedMachine>,
  resting: Resting,
): string | undefined => {
  const held = carriedOf(machines, resting);
  if (held.length < RELAYED_MOST) return undefined;
  const online = held.filter((each) => each.onlineSince !== undefined).length;
  return `This Gram already carries ${held.length} machines from hosted servers, the most it carries at once: ${online} online now, the rest not yet stopped there. A machine stops counting once its server stops it, which it does after its workers are archived. Archive workers you're done with, then spawn again.`;
};

/**
 * Why there's no room for another machine from a hosted server (`noRoomWords`), or undefined
 * while there is. At the bound, the servers are asked first which machines are stopped (the
 * reclaimed pass, with misses of its own, so nothing is forgotten), within `withinMs`: just after
 * a restart, none is known asleep yet.
 */
export const roomFor = (
  port: WorkerMachinePortShape,
  hosts: Parameters<typeof forgetReclaimed>[1],
  deps: { readonly asleep?: Set<string> | undefined; readonly sent?: StartsSent | undefined },
  resting: Resting,
  withinMs: number,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const full = noRoomWords(hosts.list(), resting);
    if (full === undefined || deps.asleep === undefined) return full;
    yield* forgetReclaimed(port, hosts, new Map(), deps.asleep, deps.sent).pipe(
      Effect.timeoutOption(Math.max(0, withinMs)),
    );
    return noRoomWords(hosts.list(), resting);
  });

/** The relays the app is asked to carry: every worker machine that doesn't rest, to `APP_RELAYS_MOST`. */
export const relaysOf = (hosts: Pick<RemoteHostsShape, "list" | "stops">, resting: Resting) =>
  firstRelayed(
    hosts
      .list()
      .filter(
        (machine) =>
          machine.via !== undefined && machine.onDemand === "worker" && !resting(machine),
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
