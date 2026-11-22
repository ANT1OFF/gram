import { HostId } from "@gram/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { RemoteHostsShape } from "../host/remote-hosts.ts";
import {
  parseMachineStatus,
  providerWordOf,
  sentOf,
  settledSince,
  type StartsSent,
  tellSignedInRelease,
} from "./signed-in-calls.ts";
import type { UsedMachine } from "./hosted-machine-use.ts";
import type { WorkerMachinePortShape } from "./signed-in-port.ts";
import { isNotFound, type OwedStop, RECLAIMED_AFTER_MISSES } from "./worker-machine-stops.ts";

/**
 * Whether a relayed machine was registered before the sign-in it was asked under was kept: what a
 * server answers of it may be about another sign-in's, so it is never forgotten on a "no such
 * machine" (`forgetReclaimed`, a give-back's stop).
 */
export const isLegacyRelayed = (
  machine:
    | { readonly via?: string | undefined; readonly viaAccount?: string | undefined }
    | undefined,
) => machine?.via !== undefined && machine.viaAccount === undefined;

/** How often offline relayed machines are asked after, to forget one the server reclaimed. */
export const RECLAIMED_EVERY = Duration.minutes(10);

/**
 * Whether each registered machine is still needed here (`hostedMachineInUse`), read afresh each
 * time it is run. Absent: every one is.
 */
export type MachinesInUse = Effect.Effect<(machine: UsedMachine) => boolean>;

/**
 * Forgets each relayed worker machine that is offline and that its server answers it doesn't know
 * (`…/status` 404 `not_found`, `RECLAIMED_AFTER_MISSES` passes in a row): reclaimed there once
 * released, or removed. Online ones aren't asked. With `inUse`, it also forgets one its server
 * says is stopped or failed that nothing here needs, once the server takes its release: no worker
 * will dial it again, so it would only sit under Machines. One kept from before its sign-in was
 * (`isLegacyRelayed`) is never forgotten so. Nothing else forgets one a server started, but a
 * give-back's stop (`signedInSource`).
 */
export const forgetReclaimed = (
  port: WorkerMachinePortShape,
  hosts: Pick<RemoteHostsShape, "list" | "remove" | "providerSaid">,
  misses: Map<string, number> = new Map(),
  asleep?: Set<string>,
  sent?: StartsSent,
  inUse?: MachinesInUse,
) =>
  Effect.gen(function* () {
    const used = inUse === undefined ? undefined : yield* inUse;
    for (const machine of hosts.list()) {
      if (machine.via === undefined || machine.onDemand !== "worker") continue;
      if (machine.onlineSince !== undefined) {
        misses.delete(machine.id);
        asleep?.delete(machine.name);
        continue;
      }
      const before = sentOf(sent, machine.name);
      const answered = yield* port.call(
        machine.via,
        "status",
        { name: machine.name },
        { account: machine.viaAccount },
      );
      if (!settledSince(sent, machine.name, before)) continue;
      const status =
        answered.ok && answered.status < 300 ? parseMachineStatus(answered.body) : undefined;
      if (status !== undefined)
        hosts.providerSaid?.(HostId.make(machine.id), providerWordOf(status, Date.now()));
      const phase = status?.phase;
      if (phase !== undefined && phase !== "stopped" && phase !== "failed")
        asleep?.delete(machine.name);
      if (asleep !== undefined && (phase === "stopped" || phase === "failed")) {
        misses.delete(machine.id);
        if (
          inUse !== undefined &&
          used?.(machine) === false &&
          !isLegacyRelayed(machine) &&
          (yield* forgetOnceReleased(port, hosts, machine, inUse, sent, before))
        ) {
          asleep.delete(machine.name);
          continue;
        }
        if (!asleep.has(machine.name)) {
          asleep.add(machine.name);
          port.unrelay(machine.name);
          if (phase === "failed")
            yield* Effect.logWarning(
              "a worker machine failed there, and is not dialled until work here starts it again",
            ).pipe(Effect.annotateLogs({ machine: machine.name }));
        }
        continue;
      }
      if (!isNotFound(answered) || isLegacyRelayed(machine)) {
        misses.delete(machine.id);
        continue;
      }
      const missed = (misses.get(machine.id) ?? 0) + 1;
      if (missed < RECLAIMED_AFTER_MISSES) {
        misses.set(machine.id, missed);
        continue;
      }
      misses.delete(machine.id);
      port.unrelay(machine.name);
      hosts.remove(HostId.make(machine.id));
    }
  });

const forgetOnceReleased = (
  port: WorkerMachinePortShape,
  hosts: Pick<RemoteHostsShape, "list" | "remove">,
  machine: {
    readonly id: string;
    readonly name: string;
    readonly via?: string | undefined;
    readonly viaAccount?: string | undefined;
  },
  inUse: MachinesInUse,
  sent: StartsSent | undefined,
  before: number,
) =>
  Effect.gen(function* () {
    const told = yield* tellSignedInRelease(
      port,
      { name: machine.name, via: machine.via!, account: machine.viaAccount },
      true,
      { attempts: 1 },
    ).pipe(Effect.option);
    if (told._tag === "None" || told.value !== "applied") return false;
    const now = hosts.list().find((each) => each.id === machine.id);
    if (now === undefined || now.onlineSince !== undefined) return false;
    if (!settledSince(sent, machine.name, before) || (yield* inUse)(now)) return false;
    port.unrelay(machine.name);
    hosts.remove(HostId.make(machine.id));
    yield* Effect.logInfo("a stopped worker machine nothing here needs was forgotten").pipe(
      Effect.annotateLogs({ machine: machine.name }),
    );
    return true;
  });

/**
 * Whether a machine of an owed stop's name is registered here (`settleOwedStops`' `claimed`):
 * under that stop's own sign-in it is the release pass's now; under another, or where whose
 * either is isn't known, the stop is kept and not sent, since it might end that other machine. A
 * start on its way keeps it too (`startingNow`).
 */
export const claimedHere =
  (hosts: Pick<RemoteHostsShape, "list">) =>
  (name: string, origin: string, stop: OwedStop): boolean | "other" => {
    const holders = hosts
      .list()
      .filter((machine) => machine.name === name && machine.via === origin);
    if (holders.length === 0) return false;
    return stop.legacy !== true &&
      holders.some(
        (machine) => machine.viaAccount !== undefined && machine.viaAccount === stop.account,
      )
      ? true
      : "other";
  };
