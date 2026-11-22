import { effectiveCheckout, HostId, hostOf, type Thread, type ThreadId } from "@gram/contracts";
import type { StopMarks } from "../host/stop-marks.ts";

/**
 * How long a newly joined worker machine is kept for the worker it was started for, before any
 * thread is placed on it: the spawn that asked for it places it within this.
 */
export const WORKER_MACHINE_SETTLE_MS = 30 * 60_000;

export type UseThread = Pick<
  Thread,
  "id" | "parked" | "checkout" | "currentCheckout" | "extraCheckouts"
>;

const placedOn = (thread: UseThread, id: string) =>
  [effectiveCheckout(thread), thread.checkout, ...(thread.extraCheckouts ?? [])].some(
    (checkout) => checkout !== undefined && hostOf(checkout) === id,
  );

/**
 * What the threads say of a hosted worker machine whose release was taken: whether its
 * registration may be forgotten. Only when every thread placed on it is archived, none of them
 * has a wake pending (`waking`, a plain thread's or a worker's) or anything going on in its
 * session (`busy`: a turn, a queued message, a request waiting), and it joined at least
 * `WORKER_MACHINE_SETTLE_MS` ago. A thread that isn't archived keeps it, finished or not: it
 * can be taken up again. `unreadable`: threads whose rows don't decode, which might be on it,
 * so none is forgotten while there are any.
 */
export const threadsLetGo = (
  machine: { readonly id: string; readonly joinedAt?: number | undefined },
  threads: {
    readonly threads: ReadonlyArray<UseThread>;
    readonly unreadable: ReadonlyArray<ThreadId>;
  },
  waking: ReadonlySet<ThreadId>,
  busy: (thread: ThreadId) => boolean,
  now: number,
): boolean => {
  if (threads.unreadable.length > 0) return false;
  if (machine.joinedAt === undefined || now - machine.joinedAt < WORKER_MACHINE_SETTLE_MS)
    return false;
  return threads.threads.every(
    (thread) =>
      !placedOn(thread, machine.id) ||
      (thread.parked === true && !waking.has(thread.id) && !busy(thread.id)),
  );
};

/**
 * Whether the machine's stop marks let it go: nothing waits for it to be started, no resume is
 * owed on it, its stop isn't held, and no thread, archived or not, waits on or rests for its stop.
 */
export const stopsLetGo = (
  stops: Pick<StopMarks, "wanted" | "owes" | "holding" | "awaited" | "restedOf">,
  id: string,
): boolean => {
  const host = HostId.make(id);
  return (
    !stops.wanted(host) &&
    !stops.owes(host) &&
    !stops.holding(host) &&
    stops.awaited(host).size === 0 &&
    stops.restedOf(host).length === 0
  );
};
