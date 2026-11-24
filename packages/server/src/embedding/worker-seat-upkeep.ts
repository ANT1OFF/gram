import { effectiveCheckout, hostOf, type Thread, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { OnDemandHosts } from "./on-demand.ts";
import type { WorkerMachinePortShape } from "./signed-in-port.ts";
import { askSeats, seatsBody, seatsOnMachine, type WorkerSeatsAsk } from "./worker-seats.ts";

/**
 * Keeps a provider's record of who is on each worker machine in step with this Gram's
 * (docs/EMBEDDING.md, "Several workers on one machine"). A worker takes its seat as it is spawned
 * (`worker-sandbox.ts`); here the seat is given up once its work is over, so the provider releases
 * the machine after its last worker and not before. Looking also lets the provider keep a shared
 * machine's size in step with how many are on it.
 */

/** How often a machine with seated workers is looked at. */
export const SEAT_LOOK_EVERY_MS = 10 * 60_000;
const NO_SEATS_FOR_MS = 60 * 60_000;

/** A joined worker machine, as this reads it. */
export interface SeatedMachine {
  readonly id: string;
  readonly name: string;
  readonly owner?: string | undefined;
  readonly via?: string | undefined;
  readonly viaAccount?: string | undefined;
}

type Placed = Pick<Thread, "id" | "checkout" | "currentCheckout" | "spawnedBy" | "parked">;

/**
 * The seats on a machine this Gram still stands behind, and whether any worker placed there has
 * one at all: an unfinished worker's seat is live; a finished or parked one's is not.
 */
export const seatsHere = (
  machine: Pick<SeatedMachine, "id">,
  threads: ReadonlyArray<Placed>,
  finished: ReadonlySet<ThreadId>,
): { readonly live: ReadonlySet<string>; readonly any: boolean } => {
  const live = new Set<string>();
  let any = false;
  for (const thread of threads) {
    const seat = thread.spawnedBy?.placement?.seat;
    if (seat === undefined || hostOf(effectiveCheckout(thread)) !== machine.id) continue;
    any = true;
    if (thread.parked !== true && !finished.has(thread.id)) live.add(seat);
  }
  return { live, any };
};

/**
 * Which of the seats a provider holds for a machine to give up now, and which to remember: a seat
 * no unfinished worker here holds is given up only once it was seen so on the look before too. A
 * spawn takes its seat a moment before its worker exists, and that seat is nobody's for that long.
 */
export const staleSeats = (
  held: ReadonlyArray<string>,
  live: ReadonlySet<string>,
  seenBefore: ReadonlySet<string>,
): { readonly detach: ReadonlyArray<string>; readonly remember: ReadonlySet<string> } => {
  const stale = held.filter((seat) => !live.has(seat));
  return {
    detach: stale.filter((seat) => seenBefore.has(seat)),
    remember: new Set(stale.filter((seat) => !seenBefore.has(seat))),
  };
};

/** How a machine's seats are asked of whichever provider it came from. Undefined: nobody to ask. */
export const seatAsker = (
  hosts: OnDemandHosts | undefined,
  port: WorkerMachinePortShape | undefined,
) =>
  hosts === undefined && port === undefined
    ? undefined
    : (machine: SeatedMachine, ask: Omit<WorkerSeatsAsk, "name">) => {
        const named = { ...ask, name: machine.name };
        const via = machine.via;
        if (via !== undefined)
          return port === undefined
            ? Effect.succeed({ kind: "none" as const })
            : askSeats(
                named,
                port
                  .call(via, "workers", seatsBody(named), { account: machine.viaAccount })
                  .pipe(
                    Effect.map((answered) =>
                      answered.ok
                        ? { status: answered.status, body: answered.body }
                        : { failed: answered.why },
                    ),
                  ),
              );
        return hosts === undefined || machine.owner === undefined
          ? Effect.succeed({ kind: "none" as const })
          : seatsOnMachine(hosts, machine.owner, named);
      };

/**
 * The upkeep of every worker machine's seats, pass by pass. `look` asks a machine's provider who
 * it holds seats for and gives up the stale ones (`staleSeats`); it asks only a machine some
 * worker here has a seat on, or one whose release the provider held back for its seats
 * (`occupied`), and no more often than `SEAT_LOOK_EVERY_MS` unless such a release is pending.
 */
export const makeSeatUpkeep = (
  ask: NonNullable<ReturnType<typeof seatAsker>>,
  now: () => number = Date.now,
) => {
  const kept = new Map<
    string,
    { lookedAt: number; stale: ReadonlySet<string>; none?: true; pending?: true }
  >();
  return {
    /** A release the provider held back because it still holds seats: look at them next pass. */
    occupied: (machine: SeatedMachine) => {
      const before = kept.get(machine.id);
      kept.set(machine.id, {
        lookedAt: before?.lookedAt ?? 0,
        stale: before?.stale ?? new Set(),
        pending: true,
      });
    },
    look: (
      machine: SeatedMachine,
      seats: ReturnType<typeof seatsHere>,
    ): Effect.Effect<"looked" | "skipped"> =>
      Effect.gen(function* () {
        const before = kept.get(machine.id);
        const at = now();
        if (before?.pending !== true) {
          if (!seats.any && (before === undefined || before.stale.size === 0)) return "skipped";
          if (before?.none === true && at - before.lookedAt < NO_SEATS_FOR_MS) return "skipped";
          if (before !== undefined && at - before.lookedAt < SEAT_LOOK_EVERY_MS) return "skipped";
        }
        const held = yield* ask(machine, {});
        if (held.kind !== "seats") {
          kept.set(machine.id, {
            lookedAt: at,
            stale: before?.stale ?? new Set(),
            ...(held.kind === "none" ? { none: true as const } : {}),
          });
          return "looked";
        }
        const { detach, remember } = staleSeats(
          held.workers,
          seats.live,
          before?.stale ?? new Set(),
        );
        if (detach.length > 0) yield* ask(machine, { detach });
        kept.set(machine.id, {
          lookedAt: at,
          stale: remember,
          ...(remember.size > 0 ? { pending: true as const } : {}),
        });
        return "looked";
      }),
    /** Forgets machines that are no longer joined. */
    prune: (joined: ReadonlySet<string>) => {
      for (const id of kept.keys()) if (!joined.has(id)) kept.delete(id);
    },
  };
};
export type SeatUpkeep = ReturnType<typeof makeSeatUpkeep>;
