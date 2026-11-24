import {
  effectiveCheckout,
  hostOf,
  type OrchestratorCharter,
  type Thread,
  type WorkerLedgerEntry,
  type WorkerPacking,
  workerPackingOf,
  workersPerMachineOf,
} from "@gram/contracts";
import { WORKER_MACHINE_PICKS, type WorkerMachinePick } from "../embedding/worker-machines.ts";
import type { ProvidedWorkerMachine, SeatRefusal } from "../embedding/worker-seats.ts";
import { compactWorkerRow } from "./ledger.ts";

type Placed = Pick<
  Thread,
  "id" | "title" | "checkout" | "currentCheckout" | "spawnedBy" | "parked"
>;

/**
 * How tightly an orchestrator's workers are packed onto its hosted machines
 * (docs/EMBEDDING.md, "Several workers on one machine"): which workers count against a machine's
 * cap, which machines a `shared` spawn may join, and the seats spawns under way hold so a burst
 * fills one machine instead of starting several.
 */

/** How long a spawn's seat is held for it before its worker exists: past a card left unanswered. */
export const SEAT_HOLD_MS = 10 * 60_000;

/**
 * The seats spawns under way hold, by machine name. A spawn takes one as it resolves where it
 * goes, before any approval card, and lets it go once its worker exists or it failed; one never
 * let go (a card denied) runs out after `SEAT_HOLD_MS`.
 */
export const makeSeatHolds = (now: () => number = Date.now) => {
  const held = new Map<string, Map<string, number>>();
  const live = (machine: string): Map<string, number> => {
    const seats = held.get(machine) ?? new Map<string, number>();
    for (const [seat, until] of seats) if (until <= now()) seats.delete(seat);
    if (seats.size === 0) held.delete(machine);
    else held.set(machine, seats);
    return seats;
  };
  const holds = {
    hold: (machine: string, seat: string, forMs: number = SEAT_HOLD_MS) => {
      const seats = live(machine);
      seats.set(seat, now() + forMs);
      held.set(machine, seats);
    },
    release: (machine: string, seat: string) => {
      const seats = held.get(machine);
      seats?.delete(seat);
      if (seats?.size === 0) held.delete(machine);
    },
    on: (machine: string): ReadonlyArray<string> => [...live(machine).keys()],
    /** The machines that hold a seat and nothing else knows of yet: ones still being asked for. */
    machines: (): ReadonlyArray<string> => [...held.keys()].filter((name) => live(name).size > 0),
  };
  everyHolds.add(holds);
  return holds;
};

const everyHolds = new Set<{ readonly on: (machine: string) => ReadonlyArray<string> }>();

/**
 * The seats spawns and moves under way hold on a machine, across every planner of this process:
 * a worker on its way there has no thread on the machine yet, so the release pass reads these to
 * keep the machine, and its seat, until the worker is placed or its try is over.
 */
export const reservedSeats = (machine: string): ReadonlyArray<string> =>
  [...everyHolds].flatMap((holds) => holds.on(machine));
export type SeatHolds = ReturnType<typeof makeSeatHolds>;

const releasing = new Map<string, Promise<void>>();

/**
 * Keeps a machine's release and a worker on its way there apart. The release pass begins a
 * release only while no spawn holds a seat on the machine (`begin`, checked and marked in one
 * step), and a spawn waits out a release already on its way (`settled`) before it makes its
 * folder there; the pass takes back a release that a spawn reserved against while it was being
 * sent (`reservedNow`). So no release is sent after a reservation, and none sent before one is
 * left standing.
 */
export const releaseFence = {
  begin: (
    machine: string,
  ): { readonly reservedNow: () => boolean; readonly done: () => void } | undefined => {
    if (reservedSeats(machine).length > 0) return undefined;
    const settle: { now?: () => void } = {};
    const sent = new Promise<void>((resolve) => {
      settle.now = resolve;
    });
    releasing.set(machine, sent);
    return {
      reservedNow: () => reservedSeats(machine).length > 0,
      done: () => {
        if (releasing.get(machine) === sent) releasing.delete(machine);
        settle.now?.();
      },
    };
  },
  settled: (machine: string): Promise<void> => releasing.get(machine) ?? Promise.resolve(),
};

/**
 * The workers that count against a machine's cap: every open worker placed on it, whichever
 * orchestrator's, that isn't parked. A finished one counts as much as one at work: it is still
 * open and can be messaged back to work at any time, so its place is its own until it is archived,
 * and a worker that resumes never finds another in it.
 */
export const workersOnMachine = <T extends Placed>(
  threads: ReadonlyArray<T>,
  machineId: string,
): ReadonlyArray<T> =>
  threads.filter(
    (thread) =>
      thread.spawnedBy !== undefined &&
      thread.parked !== true &&
      hostOf(effectiveCheckout(thread)) === machineId,
  );

const placedOnMachine = <T extends Placed>(threads: ReadonlyArray<T>, machineId: string) =>
  threads.filter(
    (thread) => thread.spawnedBy !== undefined && hostOf(effectiveCheckout(thread)) === machineId,
  );

/**
 * How a machine is packed, from the workers placed on it: `exclusive` if any was placed so, else
 * `shared` if any was, else `own`. Undefined: no worker there says (placed before packing was).
 */
export const packingOn = (
  threads: ReadonlyArray<Placed>,
  machineId: string,
): WorkerPacking | undefined => {
  const said = placedOnMachine(threads, machineId).flatMap((thread) =>
    thread.spawnedBy?.placement?.packing === undefined ? [] : [thread.spawnedBy.placement.packing],
  );
  return said.includes("exclusive")
    ? "exclusive"
    : said.includes("shared")
      ? "shared"
      : said.includes("own")
        ? "own"
        : undefined;
};

type Picks = Partial<Record<WorkerMachinePick, string>>;

/** A machine's picks as one string, so two spawns that name the same ones compare equal. */
export const picksKey = (picks: Picks): string =>
  JSON.stringify(WORKER_MACHINE_PICKS.map((pick) => picks[pick] ?? null));

/**
 * The picks a machine was started with, from the worker it was started for (the one placed `own`,
 * `exclusive` or `shared` there). Undefined: no worker there says.
 */
export const picksOn = (threads: ReadonlyArray<Placed>, machineId: string): Picks | undefined => {
  const starter = placedOnMachine(threads, machineId).find((thread) => {
    const packing = thread.spawnedBy?.placement?.packing;
    return packing !== undefined && packing !== "named";
  });
  if (starter === undefined) return undefined;
  const kept = starter.spawnedBy?.placement?.picks ?? {};
  return Object.fromEntries(
    WORKER_MACHINE_PICKS.flatMap((pick) => (kept[pick] === undefined ? [] : [[pick, kept[pick]]])),
  );
};

/**
 * The first pick a spawn names that differs from what the machine was started with, in words.
 * Undefined when none does, or nothing says what the machine was started with.
 */
export const picksMismatch = (asked: Picks, machine: Picks | undefined): string | undefined => {
  if (machine === undefined) return undefined;
  for (const pick of WORKER_MACHINE_PICKS) {
    const wanted = asked[pick];
    if (wanted !== undefined && wanted !== machine[pick])
      return `${pick} ${wanted}, and it was started ${machine[pick] === undefined ? `with no ${pick} named` : `with ${pick} ${machine[pick]}`}`;
  }
  return undefined;
};

/**
 * How many workers a machine carries here: the provider's own count for that machine (as its list
 * says it, or as it last answered a seat there, `said`), else what it says a machine of that size
 * is for, where a machine with no size named is the size the provider starts one at; else the
 * default. Each lowered by the workspace's cap.
 */
export const machineCap = (
  charter: Pick<OrchestratorCharter, "workersPerMachine"> | undefined,
  sharing:
    | { readonly workers: Readonly<Record<string, number>>; readonly size?: string | undefined }
    | undefined,
  machine: {
    readonly size?: string | undefined;
    readonly row?: ProvidedWorkerMachine | undefined;
    readonly said?: number | undefined;
  },
): number => {
  const size = machine.row?.size ?? machine.size ?? sharing?.size;
  return workersPerMachineOf(
    charter,
    machine.row?.cap ?? machine.said ?? (size === undefined ? undefined : sharing?.workers[size]),
  );
};

const listed = (workers: ReadonlyArray<Pick<Thread, "id" | "title">>) =>
  workers.map((worker) => `${worker.title} [thread ${worker.id}]`).join("; ");

/** What an orchestrator is told when a machine it named has no room. */
export const fullWords = (
  name: string,
  cap: number,
  workers: ReadonlyArray<Pick<Thread, "id" | "title">>,
  coming: number,
): string =>
  `${name} is for ${cap} worker${cap === 1 ? "" : "s"} and has ${workers.length + coming} (${[
    ...(workers.length === 0 ? [] : [listed(workers)]),
    ...(coming === 0 ? [] : [`${coming} being spawned`]),
  ].join(
    "; ",
  )}), so no worker was placed on it. Decide: wait for one to finish (schedule_wake with condition threadFinished, then spawn again); let Gram pick a machine with room (sandbox: {"shared": true}); give it a machine of its own (sandbox: {"own": true}); or run it on yours (sandbox: {"own": false}).`;

const SEAT_WORDS: Readonly<Record<SeatRefusal, string>> = {
  machine_full: "it takes no more workers at its size",
  exclusive: "it was started for one worker only and is never shared",
  other_orchestrator: "it was started for another orchestrator's workers",
  environment_mismatch: "it runs in another environment than this worker is meant for",
  released: "it was released and is being put away",
  other: "its provider refused",
};

/** What an orchestrator is told when a machine's provider gave a worker no seat on it. */
export const seatRefusedWords = (name: string, code: SeatRefusal, message: string): string =>
  `No worker was placed on ${name}: ${SEAT_WORDS[code]} (${message}). Spawn again on another machine: sandbox: {"shared": true} for one with room, {"own": true} for one of its own, or {"own": false} for yours.`;

/**
 * The charter's line on where workers run by default, for the orchestrator's digest and for the
 * note it gets when the user changes it. Undefined while neither is set: nothing differs from a
 * workspace that never heard of packing.
 */
export const packingLine = (
  charter: Pick<OrchestratorCharter, "workerPacking" | "workersPerMachine">,
): string | undefined => {
  const packing = workerPackingOf(charter);
  const cap = charter.workersPerMachine;
  if (packing === "orchestrator" && cap === undefined) return undefined;
  const where =
    packing === "shared"
      ? 'a spawn with no `sandbox` goes onto one of your shared hosted machines, where one is offered (`sandbox: {"own": false}` keeps one on your machine, `{"own": true}` gives one its own)'
      : packing === "own"
        ? 'a spawn with no `sandbox` gets a hosted machine of its own, where one is offered (`sandbox: {"own": false}` keeps one on your machine, `{"shared": true}` packs one)'
        : "a spawn with no `sandbox` runs on your machine";
  return `where workers run: ${where}${cap === undefined ? "" : `; at most ${cap} worker${cap === 1 ? "" : "s"} on one machine`}`;
};

/**
 * A worker's compact row for `list_workers`, with how it was packed onto its machine and the
 * workers it shares it with, where it has either.
 */
export const compactSharedRow = (worker: WorkerLedgerEntry) => ({
  ...compactWorkerRow(worker),
  ...(worker.packing === undefined ? {} : { packing: worker.packing }),
  ...(worker.sharesWith === undefined || worker.sharesWith.length === 0
    ? {}
    : { sharesWith: worker.sharesWith }),
});
