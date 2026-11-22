import { HostId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { RemoteHostsShape } from "../host/remote-hosts.ts";
import { stopsLetGo } from "./hosted-machine-use.ts";
import { parseMachineStatus, sentOf, settledSince, type StartsSent } from "./signed-in-calls.ts";
import type { WorkerMachinePortShape } from "./signed-in-port.ts";
import { isLegacyRelayed } from "./signed-in-reclaim.ts";
import { type NameLocks, withName } from "./worker-machine-stops.ts";

/**
 * Where a machine's removal is decided last, given the removal itself: run `remove` only if the
 * threads still let the machine go, read where nothing that would take it up can land between that
 * read and the removal (the thread store's write transaction, `forgetReleased`). Whether it did.
 */
export type FinalCheck = (remove: () => boolean) => Effect.Effect<boolean>;

/**
 * Forgets one hosted worker machine's registration here, and nothing there: it is neither stopped
 * nor released by this. Only one that is offline, of a sign-in that was kept with it
 * (`isLegacyRelayed`), with no start of its name on its way and nothing in its stop marks
 * (`stopsLetGo`), and whose server answers its status, as a 2xx naming the phase, that it is
 * stopped or failed. All of that is read under its name's lock, which every start and wake of the
 * name takes, and read again after the status, inside `final`, as the one removal: its
 * registration, stop marks and saved folders stay whole until then, and nothing is put back after.
 * When `final` fails or dies, nothing is removed.
 */
export const forgetStoppedSignedIn = (
  port: WorkerMachinePortShape,
  hosts: Pick<RemoteHostsShape, "list" | "remove" | "stops">,
  deps: {
    readonly locks?: NameLocks | undefined;
    readonly asleep?: Set<string> | undefined;
    readonly sent?: StartsSent | undefined;
    readonly starting?: ReadonlySet<string> | undefined;
  },
  id: string,
  final: FinalCheck,
): Effect.Effect<boolean> => {
  const free = () => {
    const machine = hosts.list().find((each) => each.id === id);
    return machine?.via === undefined ||
      machine.onDemand !== "worker" ||
      isLegacyRelayed(machine) ||
      machine.onlineSince !== undefined ||
      deps.starting?.has(machine.name) === true ||
      !stopsLetGo(hosts.stops, id)
      ? undefined
      : { ...machine, via: machine.via };
  };
  const first = free();
  if (first === undefined) return Effect.succeed(false);
  return withName(
    deps.locks,
    first.name,
    Effect.gen(function* () {
      const machine = free();
      if (machine === undefined) return false;
      const before = sentOf(deps.sent, machine.name);
      const answered = yield* port.call(
        machine.via,
        "status",
        { name: machine.name },
        { account: machine.viaAccount },
      );
      if (!answered.ok || answered.status < 200 || answered.status >= 300) return false;
      const phase = parseMachineStatus(answered.body).phase;
      if (phase !== "stopped" && phase !== "failed") return false;
      const removed = yield* final(() => {
        const still = free();
        if (still?.name !== machine.name || !settledSince(deps.sent, machine.name, before))
          return false;
        port.unrelay(machine.name);
        deps.asleep?.delete(machine.name);
        hosts.remove(HostId.make(id));
        return true;
      });
      if (removed)
        yield* Effect.logInfo("a stopped worker machine no thread here needs was forgotten").pipe(
          Effect.annotateLogs({ machine: machine.name }),
        );
      return removed;
    }),
  );
};
