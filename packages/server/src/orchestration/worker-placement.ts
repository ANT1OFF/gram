import {
  AppToolError,
  effectiveCheckout,
  hostOf,
  type OrchestratorCharter,
  type Thread,
  type ThreadId,
  type WorkerPacking,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { MachineClaim, MachineClaims } from "../embedding/worker-machine-claims.ts";
import type { ProvidedWorkerMachine } from "../embedding/worker-seats.ts";
import {
  fullWords,
  machineCap,
  packingOn,
  picksKey,
  picksMismatch,
  picksOn,
  releaseFence,
  type SeatHolds,
  workersOnMachine,
} from "./worker-packing.ts";

type Picks = Readonly<Record<string, string>>;
type Placed = Pick<
  Thread,
  "id" | "title" | "checkout" | "currentCheckout" | "spawnedBy" | "parked"
>;

export type PlacementRefusal =
  | "not_yours"
  | "other_orchestrator"
  | "exclusive"
  | "in_use"
  | "mode"
  | "picks"
  | "full";

export type PlacementDecision =
  | { readonly ok: true; readonly claim: MachineClaim; readonly fresh: boolean }
  | { readonly ok: false; readonly code: PlacementRefusal; readonly message: string };

const refuse = (code: PlacementRefusal, message: string) => ({ ok: false, code, message }) as const;

const ELSEWHERE =
  'Give this worker a machine of its own (sandbox: {"own": true}), or one of your shared machines ({"shared": true}).';

/**
 * The one decision every placement on a workers' machine goes through (docs/EMBEDDING.md,
 * "Several workers on one machine"): a spawn's `sandbox` in each of its forms, `machine` naming
 * such a machine, the making of the worker's folder there, and a thread taken on as a worker
 * while it is on one. It is decided from the machine's own claim (`worker-machine-claims.ts`),
 * never from which workers happen to be on it.
 *
 * Whether `caller` may put a worker on the machine `name`, packed `as` asked.
 *
 * - `claim`: the machine's, or undefined for one nobody asked for yet.
 * - `on`: the open workers placed on it, the one being placed aside (`workersOnMachine`).
 * - `coming`: the seats other spawns under way hold there. A machine that isn't here yet
 *   carries nobody, and only those count.
 *
 * A machine is its claim's orchestrator's alone. An exclusive one carries the one worker it was
 * asked for, known by its seat: no other is placed there, even once it stands empty. A machine "of its own" is one nobody else is on, so an `own` or `exclusive` spawn
 * that comes to a machine carrying a worker is refused, whatever name led it there. A `shared`
 * spawn joins only a machine asked for as shared, with the same picks; a machine named outright
 * (`named`) is taken as it is unless a pick named with it differs. The cap is counted last.
 */
export const decidePlacement = (facts: {
  readonly caller: ThreadId;
  readonly machine: string;
  readonly claim: MachineClaim | undefined;
  readonly as: WorkerPacking;
  readonly picks: Picks;
  readonly on: ReadonlyArray<Placed>;
  readonly coming: number;
  readonly cap: number;
  readonly now: number;
  /** The seat of the worker being placed: an exclusive machine takes its first one only. */
  readonly seat?: string | undefined;
  /** Whether the machine's provider keeps seats, written into a claim made now. */
  readonly keepsSeats?: boolean | undefined;
}): PlacementDecision => {
  const { caller, machine: name, claim, as, picks, on, coming, cap } = facts;
  const notYours = refuse(
    "not_yours",
    `${name} wasn't asked for by you, so it isn't yours to place a worker on: a machine is shared within one orchestrator only. ${ELSEWHERE}`,
  );
  const others = on.length + coming;
  if (claim === undefined) {
    if (as === "named" || others > 0) return notYours;
    return {
      ok: true,
      fresh: true,
      claim: {
        orchestrator: caller,
        mode: as,
        picks: { ...picks },
        ...(facts.seat === undefined ? {} : { seat: facts.seat }),
        ...(facts.keepsSeats === true ? { seats: true } : {}),
        at: facts.now,
      },
    };
  }
  if (claim.orchestrator !== caller) return notYours;
  const guest = on.find((thread) => thread.spawnedBy?.threadId !== claim.orchestrator);
  if (guest !== undefined)
    return refuse(
      "other_orchestrator",
      `${name} carries another orchestrator's worker (${guest.title}), so yours isn't placed there: a machine is shared within one orchestrator only.`,
    );
  if (
    claim.mode === "exclusive" &&
    (as !== "exclusive" || others > 0 || claim.seat === undefined || claim.seat !== facts.seat)
  )
    return refuse(
      "exclusive",
      `${name} was started for one worker only and is never shared. ${ELSEWHERE}`,
    );
  if (as === "exclusive" && claim.mode !== "exclusive")
    return refuse(
      "mode",
      `${name} was asked for as a machine other workers may be placed on, so it can't become one worker's alone. Give this spawn a clientRequestId of its own for a new machine.`,
    );
  if (as === "own" && (claim.mode !== "own" || others > 0))
    return refuse(
      "in_use",
      `A machine was already asked for under this request, project, feature and title (${name})${
        on[0] === undefined ? "" : `, and ${on[0].title} is on it`
      }, so this worker isn't given it as its own. Give this spawn a clientRequestId of its own for a new machine, or name that one with sandbox: {"shareWith": "${name}"}.`,
    );
  if (as === "shared" && claim.mode !== "shared")
    return refuse(
      "mode",
      `${name} isn't one of your shared machines. Name it with sandbox: {"shareWith": "${name}"} to place a worker on it.`,
    );
  const differs =
    as === "named"
      ? picksMismatch(picks, claim.picks)
      : picksKey(picks) === picksKey(claim.picks)
        ? undefined
        : "other picks than it was asked for with";
  if (differs !== undefined)
    return refuse(
      "picks",
      `${name} isn't what this worker asks for: it names ${differs}. Leave that out to take the machine as it is, or give the worker a machine of its own.`,
    );
  if (others >= cap) return refuse("full", fullWords(name, cap, on, coming));
  return { ok: true, fresh: false, claim };
};

/**
 * The claim of a machine from before claims were kept, worked out once from the workers its
 * orchestrator placed on it and then written down: every worker whose spawn names the machine
 * (`placement.machine`) must be one orchestrator's. A worker another orchestrator took on carries
 * no placement of its own, and says nothing. Undefined: nothing says, and the machine takes no
 * worker beside the ones on it.
 */
export const claimFromWorkers = (
  name: string,
  machineId: string,
  threads: ReadonlyArray<Placed>,
  at: number,
): MachineClaim | undefined => {
  const placed = threads.filter(
    (thread) =>
      thread.spawnedBy?.placement?.machine === name &&
      hostOf(effectiveCheckout(thread)) === machineId,
  );
  const owners = new Set(placed.map((thread) => thread.spawnedBy?.threadId));
  const [owner] = owners;
  if (owners.size !== 1 || owner === undefined) return undefined;
  const packing = packingOn(placed, machineId);
  const first = placed.find((thread) => {
    const how = thread.spawnedBy?.placement?.packing;
    return how !== undefined && how !== "named";
  })?.spawnedBy?.placement?.seat;
  return {
    orchestrator: owner,
    mode: packing === undefined || packing === "named" ? "own" : packing,
    picks: { ...picksOn(placed, machineId) },
    ...(first === undefined ? {} : { seat: first }),
    at,
  };
};

/** A joined machine as a placement reads it. */
export interface PlacedOnMachine {
  readonly id: string;
  readonly name: string;
}

export interface PlacementAsk {
  readonly caller: ThreadId;
  /** The machine by the name it was asked for under, exactly. */
  readonly name: string;
  /** It as joined here, when it is: found by the caller, who knows whose machines it may see. */
  readonly machine: PlacedOnMachine | undefined;
  readonly as: WorkerPacking;
  readonly picks: Picks;
  /** The seat of the worker being placed, held for it from here on. */
  readonly seat: string;
  /** The worker itself, when it is on the machine already: not counted against its own place. */
  readonly thread?: ThreadId | undefined;
  readonly charter: Pick<OrchestratorCharter, "workersPerMachine"> | undefined;
  readonly sharing:
    | { readonly workers: Readonly<Record<string, number>>; readonly size?: string | undefined }
    | undefined;
  readonly row?: ProvidedWorkerMachine | undefined;
  /** Whether the machine is being brought up now: its claim then stands though it isn't joined. */
  readonly comingUp: boolean;
  readonly tool: string;
}

/**
 * The placements of one Gram: `place` decides one (`decidePlacement`) from the claim on record
 * and the workers there now, writes the claim of a machine first asked for, and holds the
 * worker's seat. One at a time, so two spawns never both take a machine's last place. Its seat
 * held, every placement then waits out a release of the machine that is on its way
 * (`releaseFence`): whichever road led here, no folder is made on a machine being released.
 */
export const makeWorkerPlacement = (deps: {
  readonly listThreads: Effect.Effect<ReadonlyArray<Thread>, unknown>;
  readonly claims: MachineClaims;
  readonly seatHolds: SeatHolds;
  /** Of these archived threads, those with something still going on in their session. */
  readonly busy?:
    | ((archived: ReadonlyArray<Thread>) => Effect.Effect<ReadonlySet<ThreadId>>)
    | undefined;
  readonly now?: () => number;
}) =>
  Effect.gen(function* () {
    const { claims, seatHolds } = deps;
    const now = deps.now ?? Date.now;
    const one = yield* Semaphore.make(1);
    const capsSaid = new Map<string, number>();
    const openOn = (
      threads: ReadonlyArray<Thread>,
      machine: PlacedOnMachine | undefined,
      placing?: ThreadId,
    ) =>
      Effect.gen(function* () {
        if (machine === undefined) return [];
        const archived = threads.filter(
          (thread) =>
            thread.parked === true &&
            thread.id !== placing &&
            hostOf(effectiveCheckout(thread)) === machine.id,
        );
        const busy =
          deps.busy === undefined || archived.length === 0
            ? new Set<ThreadId>()
            : yield* deps.busy(archived);
        return workersOnMachine(threads, machine.id, busy).filter(
          (thread) => thread.id !== placing,
        );
      });
    const claimOf = (
      name: string,
      machine: PlacedOnMachine | undefined,
      threads: ReadonlyArray<Placed>,
      stands: boolean,
    ) => {
      const kept = claims.get(name);
      if (kept !== undefined && machine === undefined && !stands) {
        claims.forget(name);
        return undefined;
      }
      if (kept !== undefined || machine === undefined) return kept;
      const worked = claimFromWorkers(name, machine.id, threads, now());
      return worked === undefined ? undefined : claims.claim(name, worked);
    };
    const place = (ask: PlacementAsk) =>
      Semaphore.withPermits(
        one,
        1,
      )(
        Effect.gen(function* () {
          const threads =
            ask.machine === undefined
              ? []
              : yield* deps.listThreads.pipe(
                  Effect.mapError(
                    () =>
                      new AppToolError({
                        tool: ask.tool,
                        message: "The workspace's workers can't be read now.",
                      }),
                  ),
                );
          const on = yield* openOn(threads, ask.machine, ask.thread);
          const seated = new Set(on.map((thread) => thread.spawnedBy?.placement?.seat));
          const coming = seatHolds
            .on(ask.name)
            .filter((seat) => seat !== ask.seat && !seated.has(seat)).length;
          const claim = claimOf(ask.name, ask.machine, threads, ask.comingUp || coming > 0);
          const cap = machineCap(ask.charter, ask.sharing, {
            size: claim?.picks["size"] ?? ask.picks["size"],
            row: ask.row,
            said: capsSaid.get(ask.name),
          });
          const decided = decidePlacement({
            ...ask,
            machine: ask.name,
            claim,
            on,
            coming,
            cap,
            now: now(),
            keepsSeats: ask.sharing !== undefined,
          });
          if (!decided.ok)
            return yield* new AppToolError({ tool: ask.tool, message: decided.message });
          const kept = decided.fresh ? claims.claim(ask.name, decided.claim) : decided.claim;
          seatHolds.hold(ask.name, ask.seat);
          return { claim: kept, cap, on, coming };
        }),
      ).pipe(Effect.tap(() => Effect.promise(() => releaseFence.settled(ask.name))));
    return {
      place,
      /** Whether `place` would find room there now, with nothing held or written. */
      room: (ask: Omit<PlacementAsk, "seat">) =>
        Effect.gen(function* () {
          const threads = yield* deps.listThreads.pipe(Effect.orElseSucceed(() => []));
          const on = yield* openOn(threads, ask.machine);
          const seated = new Set(on.map((thread) => thread.spawnedBy?.placement?.seat));
          const coming = seatHolds.on(ask.name).filter((seat) => !seated.has(seat)).length;
          const claim =
            claims.get(ask.name) ??
            (ask.machine === undefined
              ? undefined
              : claimFromWorkers(ask.name, ask.machine.id, threads, now()));
          const cap = machineCap(ask.charter, ask.sharing, {
            size: claim?.picks["size"] ?? ask.picks["size"],
            row: ask.row,
            said: capsSaid.get(ask.name),
          });
          return decidePlacement({ ...ask, machine: ask.name, claim, on, coming, cap, now: now() })
            .ok;
        }),
      /** The cap a machine's provider last said for it, as it answered a seat there. */
      capSaid: (name: string, cap: number) => {
        capsSaid.set(name, cap);
        if (capsSaid.size > 256) capsSaid.delete(capsSaid.keys().next().value!);
      },
      claimOn: (name: string) => claims.get(name),
      /** A joined machine's claim, worked out from its workers and written down where none was. */
      claimOf: (name: string, machine: PlacedOnMachine, threads: ReadonlyArray<Placed>) =>
        claimOf(name, machine, threads, true),
      forget: (name: string) => claims.forget(name),
    };
  });
export type WorkerPlacementService = Effect.Success<ReturnType<typeof makeWorkerPlacement>>;
