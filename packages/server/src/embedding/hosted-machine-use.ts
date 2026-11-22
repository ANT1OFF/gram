import { effectiveCheckout, HostId, hostOf, type Thread, type ThreadId } from "@gram/contracts";
import type { StopMarks } from "../host/stop-marks.ts";

/**
 * How long a newly joined worker machine is kept for the worker it was started for, before any
 * thread is placed on it: the spawn that asked for it places it within this.
 */
export const WORKER_MACHINE_SETTLE_MS = 30 * 60_000;

/** A hosted worker machine as `hostedMachineInUse` reads it. */
export interface UsedMachine {
  readonly id: string;
  readonly name: string;
  /** When it first joined; one with none is taken as just joined. */
  readonly joinedAt?: number | undefined;
}

export type UseThread = Pick<
  Thread,
  "id" | "parked" | "checkout" | "currentCheckout" | "extraCheckouts"
>;

const placedOn = (thread: UseThread, id: string) =>
  [effectiveCheckout(thread), thread.checkout, ...(thread.extraCheckouts ?? [])].some(
    (checkout) => checkout !== undefined && hostOf(checkout) === id,
  );

/**
 * Whether anything here still needs a hosted worker machine, so its registration is kept: a
 * thread not archived is placed on it (at work, waiting, finished but resumable), something waits
 * for it to be started, a resume is owed on it or its stop is held, a thread not archived waits on
 * or was put to rest for its stop, a start of its name is on its way, or it joined within
 * `WORKER_MACHINE_SETTLE_MS` (its worker isn't placed yet). Archived threads alone don't keep it:
 * archiving a worker gives its machine back (`worker-machine-release.ts`).
 */
export const hostedMachineInUse = (
  machine: UsedMachine,
  threads: ReadonlyArray<UseThread>,
  stops: Pick<StopMarks, "wanted" | "owes" | "holding" | "awaited" | "restedOf">,
  now: number,
  starting?: ReadonlySet<string>,
): boolean => {
  if (starting?.has(machine.name) === true) return true;
  if (machine.joinedAt === undefined || now - machine.joinedAt < WORKER_MACHINE_SETTLE_MS)
    return true;
  const open = new Map<ThreadId, UseThread>();
  for (const thread of threads) if (thread.parked !== true) open.set(thread.id, thread);
  for (const thread of open.values()) if (placedOn(thread, machine.id)) return true;
  const id = HostId.make(machine.id);
  if (stops.wanted(id) || stops.owes(id) || stops.holding(id)) return true;
  for (const waiting of stops.awaited(id)) if (open.has(waiting)) return true;
  return stops.restedOf(id).some((rested) => open.has(rested));
};
