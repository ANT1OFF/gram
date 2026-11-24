import {
  AppToolError,
  type Checkout,
  effectiveCheckout,
  hostOf,
  type Thread,
  type ThreadId,
  type WorkerPlacement,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { newSeat } from "../embedding/worker-seats.ts";
import { releaseFence, seatRefusedWords, type SeatHolds } from "./worker-packing.ts";
import { charterOf, workerMachineSourceFor, type WorkerSandboxDeps } from "./worker-placed.ts";
import { occupantKey, type WorkerPlacementService } from "./worker-placement.ts";

const NOBODY = "" as ThreadId;
const UNDECIDED =
  "Whether this thread has a place on its machine couldn't be decided now, so its session wasn't opened. Try again in a moment.";

/**
 * The placement decision where it can't be gone round (`worker-placement.ts`). The orchestration
 * service calls both, so a held brief started later, a routine's spawn or an adoption is held to
 * what `spawn_worker`'s `sandbox` is held to.
 *
 * `confirm` admits the worker `caller` is about to make on the machine `hostId`, and gives the
 * placement it is made with. A machine that isn't a workers' machine is none of this: `given` as
 * it came. On one, the spawn's own placement (its packing, picks and seat, as `sandbox` resolved
 * them) is decided again; a spawn that carries none is a worker placed by name. Its seat is taken
 * with the provider here if nothing took it before.
 *
 * `adopting` says whether `thread` may become `holder`'s worker with `target` as its checkout,
 * and the placement it keeps. A machine stays its claim's orchestrator's whoever takes one of its
 * workers on:
 *
 * - taken on by the machine's own orchestrator, it is placed as any worker named there is;
 * - taken on by another, it must be alone there, and stays alone: the machine takes no other
 *   worker while it carries one of another orchestrator's (`decidePlacement`). It keeps no
 *   placement of its own, so nothing about it ever says the machine is its new orchestrator's.
 *   The machine's claim is written down first, where it wasn't yet;
 * - a thread is never moved onto a workers' machine by being taken on.
 *
 * `reviving` is the same question for an archived thread coming back to the machine its folder is
 * on, a worker or one that is no orchestrator's any more (which must then be alone there): archived, it gave its place up, and others may have been placed there since. It answers
 * why it may not come back, or nothing; allowed, its place is held from here on.
 *
 * `opening` is asked as a session opens: no session opens on a workers' machine for a thread
 * that has no place there. One that holds a place (`MachineClaim.occupants`) opens; any other is
 * decided then, as a return from the archive is, whatever led its session to open (a message to
 * an archived worker, a close undone, a thread started on the machine by hand).
 */
export const makeWorkerAdmission = ({
  deps,
  placement,
  seatHolds,
  tookSeat,
  hasSeat,
}: {
  readonly deps: Omit<WorkerSandboxDeps, "orchestration" | "claims" | "busy" | "runtimes">;
  readonly placement: WorkerPlacementService;
  readonly seatHolds: SeatHolds;
  readonly tookSeat: (seat: string) => void;
  readonly hasSeat: (seat: string) => boolean;
}) => {
  const { store, joined } = deps;
  const workersMachine = (hostId: string | undefined) => {
    const machine = hostId === undefined ? undefined : joined().find((each) => each.id === hostId);
    return machine?.onDemand === "worker" ? machine : undefined;
  };
  const confirm = (
    caller: ThreadId,
    hostId: string | undefined,
    given: WorkerPlacement | undefined,
  ): Effect.Effect<WorkerPlacement | undefined, AppToolError> =>
    Effect.gen(function* () {
      const tool = "spawn_worker";
      const machine = workersMachine(hostId);
      if (machine === undefined) return given;
      const fail = (message: string) => new AppToolError({ tool, message });
      const source = yield* workerMachineSourceFor(deps, caller, tool);
      if (source === undefined || "refused" in source || !source.theirs(machine))
        return yield* fail(
          `${machine.name} is a machine for another's workers, so no worker of yours is placed on it. Leave out machine to run the worker on yours.`,
        );
      const own = given?.machine === machine.name ? given : undefined;
      const seat = own?.seat ?? newSeat();
      const offer = yield* source.sharing;
      const admitted = yield* placement.place({
        caller,
        name: machine.name,
        machine,
        as: own?.packing ?? "named",
        picks: own?.picks ?? {},
        seat,
        charter: yield* charterOf(store, caller, tool),
        sharing: offer,
        comingUp: false,
        tool,
      });
      if (offer !== undefined && !hasSeat(seat)) {
        const answered = yield* source.seats({
          name: machine.name,
          orchestrator: caller,
          attach: {
            worker: seat,
            environment: own?.picks?.["environment"] ?? admitted.claim.picks["environment"],
          },
        });
        if (answered.kind === "refused" || answered.kind === "unknown") {
          seatHolds.release(machine.name, seat);
          return yield* fail(
            answered.kind === "refused"
              ? seatRefusedWords(machine.name, answered.code, answered.message)
              : `Whether ${machine.name} has room for this worker couldn't be confirmed (${answered.message}), so it wasn't placed there. Spawn again in a moment.`,
          );
        }
        if (answered.kind === "seats") tookSeat(seat);
      }
      return {
        ...(own ?? { machine: machine.name, shared: true, packing: "named" as const }),
        seat,
      };
    });

  const sharingFor = (orchestrator: ThreadId) =>
    workerMachineSourceFor(deps, orchestrator, "adopt_thread").pipe(
      Effect.flatMap((source) =>
        source === undefined || "refused" in source ? Effect.succeed(undefined) : source.sharing,
      ),
      Effect.orElseSucceed(() => undefined),
    );
  const adopting = (
    thread: Thread,
    holder: ThreadId,
    target: Checkout,
    keepPlace = false,
  ): Effect.Effect<WorkerPlacement | undefined, string> =>
    Effect.gen(function* () {
      const kept = thread.spawnedBy?.placement;
      const machine = workersMachine(hostOf(target));
      if (machine === undefined) return undefined;
      if (hostOf(effectiveCheckout(thread)) !== machine.id)
        return yield* Effect.fail(
          `${machine.name} is a machine for an orchestrator's workers: a thread isn't moved onto one by being taken on. Spawn a worker there instead.`,
        );
      const threads = yield* store.listThreads.pipe(
        Effect.mapError(() => "The workspace's workers can't be read now."),
      );
      const claim = placement.claimOf(machine.name, machine, threads);
      const seat = kept?.seat ?? newSeat();
      if (claim?.orchestrator === holder) {
        yield* placement
          .place({
            caller: holder,
            name: machine.name,
            machine,
            as: claim.mode === "exclusive" ? "exclusive" : "named",
            picks: claim.mode === "exclusive" ? claim.picks : {},
            seat,
            occupant: occupantKey(thread),
            thread: thread.id,
            charter: yield* charterOf(store, holder, "adopt_thread").pipe(
              Effect.orElseSucceed(() => undefined),
            ),
            sharing: yield* sharingFor(holder),
            comingUp: false,
            tool: "adopt_thread",
          })
          .pipe(Effect.mapError((error) => error.message));
        if (!keepPlace) seatHolds.release(machine.name, seat);
        return kept?.machine === machine.name ? kept : undefined;
      }
      if (claim?.mode === "exclusive")
        return yield* Effect.fail(
          `${machine.name} was started for one worker only and is never shared, so “${thread.title}” has no place on it.`,
        );
      const others = yield* placement.on(threads, machine, thread.id);
      const coming = seatHolds.on(machine.name).filter((each) => each !== seat).length;
      if (others.length + coming > 0)
        return yield* Effect.fail(
          `“${thread.title}” runs on ${machine.name}, a machine another orchestrator's workers share${
            others[0] === undefined ? "" : ` (${others[0].title} is on it)`
          }. A machine is shared within one orchestrator only, so it isn't taken on while it is there.`,
        );
      if (keepPlace) {
        seatHolds.hold(machine.name, seat);
        placement.occupy(machine.name, occupantKey(thread));
        yield* Effect.promise(() => releaseFence.settled(machine.name));
      }
      return undefined;
    });

  const reviving = (thread: Thread): Effect.Effect<string | undefined> =>
    adopting(thread, thread.spawnedBy?.threadId ?? NOBODY, effectiveCheckout(thread), true).pipe(
      Effect.as(undefined),
      Effect.catch((refused) => Effect.succeed<string | undefined>(refused)),
    );

  const opening = (thread: Thread): Effect.Effect<string | undefined> =>
    Effect.gen(function* () {
      const machine = workersMachine(hostOf(effectiveCheckout(thread)));
      if (machine === undefined) return undefined;
      const threads = yield* store.listThreads;
      placement.claimOf(machine.name, machine, threads);
      const { keys } = yield* placement.admitted(machine.name, machine, threads, thread.id);
      return thread.parked !== true && keys.includes(occupantKey(thread))
        ? undefined
        : yield* reviving(thread);
    }).pipe(Effect.catchCause(() => Effect.succeed<string | undefined>(UNDECIDED)));

  return { confirm, adopting, reviving, opening };
};
export type WorkerAdmission = ReturnType<typeof makeWorkerAdmission>;
