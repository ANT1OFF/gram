import { HostId } from "@gram/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { RemoteHostsShape } from "../host/remote-hosts.ts";
import { parseMachineStatus, sentOf, settledSince, type StartsSent } from "./signed-in-calls.ts";
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
 * Forgets each relayed worker machine that is offline and that its server answers it doesn't know
 * (`…/status` 404 `not_found`, `RECLAIMED_AFTER_MISSES` passes in a row): reclaimed there once
 * released, or removed. Online ones aren't asked. Nothing else forgets one a server started.
 */
export const forgetReclaimed = (
  port: WorkerMachinePortShape,
  hosts: Pick<RemoteHostsShape, "list" | "remove">,
  misses: Map<string, number> = new Map(),
  asleep?: Set<string>,
  sent?: StartsSent,
) =>
  Effect.gen(function* () {
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
      const phase =
        answered.ok && answered.status < 300 ? parseMachineStatus(answered.body).phase : undefined;
      if (phase !== undefined && phase !== "stopped" && phase !== "failed")
        asleep?.delete(machine.name);
      if (asleep !== undefined && (phase === "stopped" || phase === "failed")) {
        misses.delete(machine.id);
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
