import * as Effect from "effect/Effect";
import type { RemoteHostsShape } from "../host/remote-hosts.ts";
import { stopsLetGo } from "./hosted-machine-use.ts";
import { parseMachineStatus, sentOf, settledSince, type StartsSent } from "./signed-in-calls.ts";
import type { WorkerMachinePortShape } from "./signed-in-port.ts";
import { isLegacyRelayed } from "./signed-in-reclaim.ts";
import { type NameLocks, withName } from "./worker-machine-stops.ts";

/**
 * Where setting a machine aside is decided last, given the setting aside itself: run `setAside`
 * only if the threads, read afresh, still let the machine go (`setAsideReleased`). Whether it did.
 */
export type FinalCheck = (setAside: () => boolean) => Effect.Effect<boolean>;

/**
 * How long the status asked before setting a machine aside may take: it is asked under the name's
 * lock, so a wake or start of the name waits behind it no longer than this. Past it, nothing is
 * set aside.
 */
export const SET_ASIDE_STATUS_MS = 10_000;

/** What setting a machine aside reads and changes. */
export type SetAsideHosts = Pick<RemoteHostsShape, "list" | "stops"> & {
  readonly machines: Pick<RemoteHostsShape["machines"], "get" | "setAside">;
};

/**
 * Sets one hosted worker machine aside here (`PairedMachine.setAside`): no longer relayed nor
 * listed, and counted as asleep, with its registration, key, id and stop records kept whole. It
 * is neither stopped nor released there, and nothing of it is removed. Only one that is offline,
 * of a sign-in that was kept with it (`isLegacyRelayed`), with no start of its name on its way and
 * nothing in its stop marks (`stopsLetGo`), and whose server answers its status, as a 2xx naming
 * the phase, that it is stopped or failed. That is read under its name's lock, which every start
 * and wake of the name takes, and read again inside `final`, after the status. Whatever takes it
 * up afterwards (a host want, a dial, a start of its name, a thread that needs it) takes it back
 * (`takeBackSetAside`).
 */
export const setAsideStoppedSignedIn = (
  port: WorkerMachinePortShape,
  hosts: SetAsideHosts,
  deps: {
    readonly locks?: NameLocks | undefined;
    readonly asleep?: Set<string> | undefined;
    readonly sent?: StartsSent | undefined;
    readonly starting?: ReadonlySet<string> | undefined;
    readonly now?: () => number;
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
      hosts.machines.get(id)?.setAside !== undefined ||
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
      const asked = yield* port
        .call(machine.via, "status", { name: machine.name }, { account: machine.viaAccount })
        .pipe(Effect.timeoutOption(SET_ASIDE_STATUS_MS));
      if (asked._tag === "None") return false;
      const answered = asked.value;
      if (!answered.ok || answered.status < 200 || answered.status >= 300) return false;
      const phase = parseMachineStatus(answered.body).phase;
      if (phase !== "stopped" && phase !== "failed") return false;
      const setAside = yield* final(() => {
        const still = free();
        if (still?.name !== machine.name || !settledSince(deps.sent, machine.name, before))
          return false;
        hosts.machines.setAside(id, (deps.now ?? Date.now)());
        deps.asleep?.add(machine.name);
        port.unrelay(machine.name);
        return true;
      });
      if (setAside)
        yield* Effect.logInfo("a stopped worker machine no thread here needs was set aside").pipe(
          Effect.annotateLogs({ machine: machine.name }),
        );
      return setAside;
    }),
  );
};

/**
 * Takes back each machine set aside that something takes up again: online (it dialled), wanted
 * (a session waits for it, which wakes it), a start of its name on its way, or `needed` (a thread
 * here needs it again, `setAsideReleased`). It is listed again at once, and relayed again once it
 * is woken, as any asleep machine is.
 */
export const takeBackSetAside = (
  hosts: SetAsideHosts,
  starting: ReadonlySet<string>,
  needed: (id: string) => boolean = () => false,
) => {
  for (const machine of hosts.list()) {
    if (hosts.machines.get(machine.id)?.setAside === undefined) continue;
    if (
      machine.onlineSince !== undefined ||
      !stopsLetGo(hosts.stops, machine.id) ||
      starting.has(machine.name) ||
      needed(machine.id)
    )
      hosts.machines.setAside(machine.id, undefined);
  }
};

/** The names of the machines set aside, as asleep from the start: none of them is relayed. */
export const setAsideNames = (hosts: SetAsideHosts): ReadonlyArray<string> =>
  hosts
    .list()
    .filter((machine) => hosts.machines.get(machine.id)?.setAside !== undefined)
    .map((machine) => machine.name);
