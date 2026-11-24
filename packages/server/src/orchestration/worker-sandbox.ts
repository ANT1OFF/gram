import {
  AppToolError,
  effectiveCheckout,
  hostOf,
  type ThreadId,
  type WorkerPacking,
  type WorkerPlacement,
  workerPackingOf,
} from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type { ThreadStore } from "../persistence/thread-store.ts";
import type { OnDemand } from "../embedding/on-demand.ts";
import type { SignedInWorkers } from "../embedding/signed-in-workers.ts";
import { ownerSubject } from "../host/ownership.ts";
import type { RemoteHosts } from "../host/remote-hosts.ts";
import type { WorkerHosts } from "../host/worker-host.ts";
import {
  embeddedSource,
  isWorkerMachineName,
  modelRefusal,
  overTotalWords,
  pinRefusal,
  placementOf,
  resolveWorkerPicks,
  type WorkerMachineSource,
  workerMachineIdentity,
  workerMachineName,
} from "../embedding/worker-machines.ts";
import { type MachineSharing, newSeat } from "../embedding/worker-seats.ts";
import { isLiveWorker } from "./ledger.ts";
import { refusal } from "./rules.ts";
import {
  fullWords,
  machineCap,
  makeSeatHolds,
  packingOn,
  picksKey,
  picksMismatch,
  picksOn,
  seatRefusedWords,
  workersOnMachine,
} from "./worker-packing.ts";
import type { Orchestration } from "./service.ts";
import type { WorkerSandbox } from "./tool-inputs.ts";

const reclaimedWords = (name: string) =>
  `The server says it no longer holds the machine ${name}: most likely it was reclaimed once its work was over, so the worker wasn't placed on it. Spawn again with another clientRequestId for a new machine, or leave out sandbox to run the worker on your machine.`;

interface Flight {
  readonly name: string;
  readonly identity: string;
  readonly fiber: Fiber.Fiber<{ readonly startedHere: boolean }, AppToolError>;
  holders: number;
  closing?: Deferred.Deferred<void> | undefined;
}

const flightKey = (identity: string, name: string) => JSON.stringify([identity, name]);

const unread = (tool: string) => () =>
  new AppToolError({ tool, message: "The workspace's workers can't be read now." });

/** What the sandbox planner reads: the tools' own services, as `tools.ts` has them. */
export interface WorkerSandboxDeps {
  readonly orchestration: Orchestration["Service"];
  readonly store: ThreadStore["Service"];
  readonly onDemand: OnDemand["Service"] | undefined;
  readonly signedIn: SignedInWorkers["Service"] | undefined;
  readonly workerHosts: WorkerHosts["Service"] | undefined;
  readonly joined: () => ReturnType<RemoteHosts["Service"]["list"]>;
}

type Store = WorkerSandboxDeps["store"];

const workspaceOf = (store: Store, caller: ThreadId, tool: string) =>
  store.getThread(caller).pipe(
    Effect.mapError(unread(tool)),
    Effect.map((thread) => thread.workspaceId),
  );

/** The charter of the workspace `caller` orchestrates, or works in. Undefined: it has none. */
export const charterOf = (store: Store, caller: ThreadId, tool: string) =>
  Effect.gen(function* () {
    const workspaceId = yield* workspaceOf(store, caller, tool);
    if (workspaceId === undefined) return undefined;
    return Option.getOrUndefined(yield* store.getWorkspace(workspaceId).pipe(Effect.option))
      ?.charter;
  });

/**
 * Every open thread, and which workers of `caller`'s workspace the ledger reads as finished: what
 * decides who counts against a machine's cap.
 */
export const placedThreads = (
  { store, orchestration }: Pick<WorkerSandboxDeps, "store" | "orchestration">,
  caller: ThreadId,
  tool: string,
) =>
  Effect.gen(function* () {
    const threads = yield* store.listThreads.pipe(Effect.mapError(unread(tool)));
    const workspaceId = yield* workspaceOf(store, caller, tool);
    const ledger =
      workspaceId === undefined
        ? undefined
        : Option.getOrUndefined(yield* orchestration.ledger(workspaceId).pipe(Effect.option));
    return {
      threads,
      finished: new Set(
        (ledger?.features ?? [])
          .flatMap((feature) => feature.workers)
          .filter((worker) => !isLiveWorker(worker))
          .map((worker) => worker.threadId),
      ),
    };
  });

/**
 * Where the orchestrator `orchestratorId`'s workers' machines come from: the embedder's provider for
 * the person whose host it is on, or the hosted server the app is signed in to. Undefined: neither.
 */
export const workerMachineSourceFor = (
  { store, onDemand, signedIn, workerHosts, joined }: Omit<WorkerSandboxDeps, "orchestration">,
  orchestratorId: ThreadId,
  tool: string,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* store
      .getThread(orchestratorId)
      .pipe(
        Effect.mapError(
          () => new AppToolError({ tool, message: "The orchestrator's thread can't be read now." }),
        ),
      );
    const ownHost = hostOf(effectiveCheckout(orchestrator));
    const holder = workerHosts?.ownerOf(ownHost);
    const owner = ownerSubject(holder);
    const found: WorkerMachineSource | { readonly refused: string } | undefined =
      onDemand !== undefined
        ? owner === undefined
          ? undefined
          : embeddedSource(onDemand, owner, joined)
        : signedIn !== undefined && holder === undefined
          ? yield* signedIn.source.pipe(
              Effect.map((each) => ("refused" in each ? each : each.source)),
            )
          : undefined;
    return found;
  });

/**
 * The sandbox planner, in the scope it is made in: each machine's bring-up runs there, so it
 * outlives the spawn try that began it.
 */
export const makeWorkerSandbox = ({
  orchestration,
  store,
  onDemand,
  signedIn,
  workerHosts,
  joined,
}: WorkerSandboxDeps) =>
  Effect.gen(function* () {
    const machineFlights = new Map<string, Flight>();
    const otherFlight = (identity: string, name: string) =>
      [...machineFlights.values()].some(
        (flight) => flight.name === name && flight.identity !== identity,
      );
    const flightScope = yield* Effect.scope;
    const holdFlight = (
      name: string,
      identity: string,
      start?: Effect.Effect<{ readonly startedHere: boolean }, AppToolError>,
    ) =>
      Effect.gen(function* () {
        const key = flightKey(identity, name);
        let waited = false;
        for (;;) {
          const taken = yield* Effect.acquireRelease(
            Effect.gen(function* () {
              const joining = machineFlights.get(key);
              if (joining?.closing !== undefined) return { wait: joining.closing };
              if (joining !== undefined) {
                joining.holders += 1;
                return { held: joining };
              }
              if (start === undefined) return { none: true as const };
              const made: Flight = {
                name,
                identity,
                fiber: yield* Effect.forkIn(start, flightScope),
                holders: 1,
              };
              machineFlights.set(key, made);
              return { held: made };
            }),
            (got) =>
              Effect.gen(function* () {
                if (!("held" in got)) return;
                const held = got.held;
                held.holders -= 1;
                if (held.holders > 0) return;
                const closing = yield* Deferred.make<void>();
                held.closing = closing;
                yield* Fiber.interrupt(held.fiber).pipe(
                  Effect.ensuring(
                    Effect.suspend(() => {
                      if (machineFlights.get(key) === held) machineFlights.delete(key);
                      held.closing = undefined;
                      return Deferred.succeed(closing, undefined);
                    }),
                  ),
                );
              }),
          );
          if ("wait" in taken) {
            waited = true;
            yield* Deferred.await(taken.wait);
          } else return { waited, flight: "held" in taken ? taken.held : undefined };
        }
      });
    const fence = (
      name: string,
      identity: string,
    ): Effect.Effect<
      { readonly abandon?: Effect.Effect<void> | undefined },
      AppToolError,
      Scope.Scope
    > =>
      Effect.gen(function* () {
        const { waited } = yield* holdFlight(name, identity);
        if (waited && !joined().some((each) => each.name === name))
          return yield* new AppToolError({
            tool: "spawn_worker",
            message: `${name} was given back as this worker was placed, so it isn't there to place it on. Spawn again on a machine of its own, or leave out sandbox to run the worker on your machine.`,
          });
        return {};
      });
    const seatHolds = makeSeatHolds();
    const coming = new Map<string, string>();
    const capsSaid = new Map<string, number>();
    const workerSandbox = (
      caller: ThreadId,
      input: {
        readonly title: string;
        readonly feature: string;
        readonly project: string;
        readonly clientRequestId?: string | undefined;
        readonly model?: string | undefined;
      },
      asked: WorkerSandbox | undefined,
    ): Effect.Effect<
      | {
          readonly name: string;
          /** Whether its provider gives machines back (`WorkerMachineSource.givesBack`). */
          readonly givesBack: boolean;
          /**
           * Starts it where it isn't there, waits for it to come, and takes the worker's seat on
           * it: run once the spawn goes ahead, in the scope the spawn runs in.
           */
          readonly prepare: Effect.Effect<
            { readonly abandon?: Effect.Effect<void> | undefined },
            AppToolError,
            Scope.Scope
          >;
          /** Whether it is still to come as `prepare` runs: one already there is admitted first. */
          readonly arrives: boolean;
          readonly placement: WorkerPlacement;
        }
      | undefined,
      AppToolError
    > =>
      Effect.gen(function* () {
        const tool = "spawn_worker";
        const fail = (message: string) => new AppToolError({ tool, message });
        const named =
          (asked?.own === true ? 1 : 0) +
          (asked?.shared === true ? 1 : 0) +
          (asked?.shareWith === undefined ? 0 : 1);
        if (named > 1 || (asked?.own === false && named > 0))
          return yield* fail(
            'sandbox names one place: "own": true for a machine of its own, "shared": true for one of your shared machines, "shareWith" for a machine you name, or "own": false for yours.',
          );
        if (asked?.exclusive === true && asked.own !== true)
          return yield* fail('exclusive is for a machine of its own: give "own": true with it.');
        const defaulted = named === 0 && asked?.own !== false;
        const byDefault = defaulted
          ? workerPackingOf(yield* charterOf(store, caller, tool))
          : "orchestrator";
        if (named === 0 && byDefault === "orchestrator") {
          if (
            asked?.size !== undefined ||
            asked?.architecture !== undefined ||
            asked?.isolation !== undefined ||
            asked?.environment !== undefined
          )
            return yield* fail(
              'size, architecture, isolation and environment are for a machine of its own: add "own": true.',
            );
          return undefined;
        }
        const sandbox: WorkerSandbox =
          named > 0
            ? (asked ?? {})
            : { ...asked, ...(byDefault === "shared" ? { shared: true } : { own: true }) };
        const yours = defaulted
          ? ' Pass sandbox: {"own": false} to run this one on your machine.'
          : " Leave out sandbox, and the worker runs on your machine.";
        const found = yield* workerMachineSourceFor(
          { store, onDemand, signedIn, workerHosts, joined },
          caller,
          tool,
        );
        if (found === undefined && defaulted) return undefined;
        if (found === undefined || "refused" in found)
          return yield* fail(
            found === undefined
              ? "Workers can't have machines of their own here: leave out sandbox, and the worker runs on your machine."
              : defaulted
                ? `This workspace puts workers on hosted machines by default, and none can be asked for now: ${found.refused}.${yours}`
                : `Workers can't have machines of their own here: ${found.refused}. Leave out sandbox, and the worker runs on your machine.`,
          );
        const source = found;
        const theirs = source.theirs;
        const models = yield* source.models;
        if (models !== undefined) {
          const chosen = yield* orchestration.spawnModel(caller, input.model);
          const refused =
            modelRefusal(source.label, models, chosen) ??
            pinRefusal(
              `${source.label}'s worker machines`,
              models.filter((model) => model.agent === chosen.agent),
              input.model,
              chosen,
            );
          if (refused !== undefined)
            return yield* fail(
              defaulted
                ? `This workspace puts workers on hosted machines by default. ${refused}`
                : refused,
            );
        }
        const offered = yield* source.choices;
        const resolved = resolveWorkerPicks(offered?.choices, sandbox);
        if ("refused" in resolved) return yield* fail(resolved.refused);
        const picks = resolved.picks;
        const offer = yield* source.sharing;
        const rows = offer === undefined ? undefined : yield* source.machines;
        const identity = source.identity ?? "";
        const seat = newSeat();
        const placed = yield* Effect.cached(
          Effect.all({
            charter: charterOf(store, caller, tool),
            facts: placedThreads({ store, orchestration }, caller, tool),
          }),
        );
        const roomOn = (
          { charter, facts }: Effect.Success<typeof placed>,
          machine: { readonly name: string; readonly id?: string },
          size?: string,
        ) => {
          const row = rows?.find((each) => each.name === machine.name);
          const cap = machineCap(charter, offer, { size, row, said: capsSaid.get(machine.name) });
          const on =
            machine.id === undefined
              ? []
              : workersOnMachine(facts.threads, machine.id, facts.finished);
          const held = seatHolds.on(machine.name).length;
          return { cap, on, held, free: cap - on.length - held };
        };
        const shared = (machine: { readonly name: string }) =>
          !source.givesBack
            ? { name: machine.name, givesBack: false }
            : {
                name: machine.name,
                givesBack: true,
                prepare: Effect.gen(function* () {
                  yield* fence(machine.name, identity);
                  if (
                    joined().find((each) => each.name === machine.name)?.onlineSince !== undefined
                  )
                    return {};
                  if ((yield* source.unrelease(machine.name)) === "gone")
                    return yield* fail(reclaimedWords(machine.name));
                  const arrived = yield* source.arrive(machine.name);
                  if (typeof arrived !== "string")
                    return yield* fail(
                      `${machine.name} is offline and didn't come back, so the worker wasn't placed on it. It was left as it is: wait for it, or spawn on a machine of its own.`,
                    );
                  return {};
                }),
              };
        const bringUpPlan = (name: string, sharing: MachineSharing) =>
          Effect.gen(function* () {
            const seen = joined().find((each) => each.name === name && theirs(each));
            if (
              seen?.onlineSince !== undefined &&
              !(source.givesBack && machineFlights.has(flightKey(identity, name)))
            )
              return { name, givesBack: source.givesBack };
            const bringUp = Effect.gen(function* () {
              const already = joined().find((each) => each.name === name && theirs(each));
              if (already !== undefined && (yield* source.unrelease(name)) === "gone")
                return yield* fail(reclaimedWords(name));
              const started =
                already !== undefined
                  ? ({ kind: "started", name } as const)
                  : yield* source
                      .start({
                        name,
                        orchestrator: caller,
                        title: input.title,
                        size: picks.size,
                        architecture: picks.architecture,
                        isolation: picks.isolation,
                        environment: picks.environment,
                        ...(offer === undefined ? {} : { sharing }),
                      })
                      .pipe(Effect.onInterrupt(() => source.abandon(name, { unsettled: true })));
              if (started.kind === "refused") {
                if (started.unknown === true) yield* source.abandon(name, { unsettled: true });
                return yield* fail(started.message);
              }
              if (started.kind === "over-total") {
                const threads = yield* store.listThreads;
                const workersOn = (machineName: string) => {
                  const machine = joined().find((each) => each.name === machineName);
                  return machine === undefined
                    ? []
                    : threads
                        .filter(
                          (thread) =>
                            thread.spawnedBy?.threadId === caller &&
                            !thread.parked &&
                            hostOf(effectiveCheckout(thread)) === machine.id,
                        )
                        .map((thread) => `${thread.title} [thread ${thread.id}]`);
                };
                return yield* fail(refusal("over_total", overTotalWords(started, workersOn)));
              }
              const arrived = yield* source
                .arrive(name)
                .pipe(
                  Effect.onInterrupt(() =>
                    already === undefined ? source.abandon(name) : Effect.void,
                  ),
                );
              if (typeof arrived !== "string") {
                if (already !== undefined && source.givesBack)
                  return yield* fail(
                    arrived.failed === "timeout"
                      ? `The machine ${name} is registered here from an earlier spawn of this request and didn't come online, so it was left as it is: it may hold that spawn's work. Wait for it to come back, spawn with another clientRequestId for a new machine, or leave out sandbox to run the worker on your machine.`
                      : `${arrived.failed} It is registered here from an earlier spawn of this request and was left as it is, since it may hold that spawn's work. Spawn with another clientRequestId for a new machine, or leave out sandbox to run the worker on your machine.`,
                  );
                if (arrived.failed === "timeout") return yield* fail(yield* source.timedOut(name));
                yield* source.abandon(name);
                return yield* fail(arrived.failed);
              }
              return { startedHere: already === undefined };
            });
            if (!source.givesBack) {
              yield* bringUp;
              return { name, givesBack: false };
            }
            const giveBack = (flight: Flight) =>
              Effect.gen(function* () {
                if (flight.holders > 1 || flight.closing !== undefined) return;
                if (seatHolds.on(name).length > 0) return;
                const closing = yield* Deferred.make<void>();
                flight.closing = closing;
                let stopped = false;
                const open = Effect.suspend(() => {
                  const key = flightKey(identity, name);
                  if (stopped && machineFlights.get(key) === flight) machineFlights.delete(key);
                  flight.closing = undefined;
                  return Deferred.succeed(closing, undefined);
                });
                yield* Effect.gen(function* () {
                  const id = source.idOf(name);
                  if (id !== undefined) {
                    const threads = yield* store.listThreads.pipe(Effect.option);
                    if (threads._tag === "None") return;
                    if (
                      threads.value.some(
                        (thread) =>
                          thread.parked !== true &&
                          [
                            effectiveCheckout(thread),
                            thread.checkout,
                            ...(thread.extraCheckouts ?? []),
                          ].some((checkout) => checkout !== undefined && hostOf(checkout) === id),
                      )
                    )
                      return;
                  }
                  stopped = true;
                  yield* source.abandon(name);
                }).pipe(Effect.ensuring(open));
              });
            const prepare = Effect.gen(function* () {
              if (otherFlight(identity, name))
                return yield* fail(
                  `The machine ${name} for this request is being brought up under another sign-in to ${source.label}, so this one leaves it alone. Spawn again with another clientRequestId for a new machine, or leave out sandbox to run the worker on your machine.`,
                );
              const { flight } = yield* holdFlight(name, identity, bringUp);
              if (flight === undefined) return {};
              const brought = yield* Fiber.join(flight.fiber);
              return brought.startedHere ? { abandon: giveBack(flight) } : {};
            });
            return { name, givesBack: true, prepare };
          });
        const seated = (
          plan: {
            readonly name: string;
            readonly givesBack: boolean;
            readonly prepare?: Effect.Effect<
              { readonly abandon?: Effect.Effect<void> | undefined },
              AppToolError,
              Scope.Scope
            >;
          },
          packing: WorkerPacking,
          environment: string | undefined = picks.environment,
        ) => {
          const name = plan.name;
          seatHolds.hold(name, seat);
          let attached = false;
          const letGo = Effect.suspend(() => {
            seatHolds.release(name, seat);
            if (!attached) return Effect.void;
            attached = false;
            return Effect.asVoid(source.seats({ name, detach: [seat] }));
          });
          const take = {
            name,
            orchestrator: caller,
            attach: { worker: seat, environment },
          };
          const prepare = Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                seatHolds.release(name, seat);
                if (!attached) return;
                const threads = yield* store.listThreads.pipe(Effect.option);
                if (
                  threads._tag === "Some" &&
                  !threads.value.some((thread) => thread.spawnedBy?.placement?.seat === seat)
                )
                  yield* letGo;
              }),
            );
            const prepared = plan.prepare === undefined ? {} : yield* plan.prepare;
            if (offer !== undefined) {
              let answered = yield* source.seats(take);
              if (answered.kind === "unknown") {
                yield* Effect.sleep("1 second");
                answered = yield* source.seats(take);
              }
              if (answered.kind !== "unknown" && answered.kind !== "none") {
                if (answered.cap !== undefined) capsSaid.set(name, answered.cap);
                if (capsSaid.size > 256) capsSaid.delete(capsSaid.keys().next().value!);
              }
              if (answered.kind === "refused" || answered.kind === "unknown") {
                seatHolds.release(name, seat);
                yield* prepared.abandon ?? Effect.void;
                return yield* fail(
                  answered.kind === "refused"
                    ? seatRefusedWords(name, answered.code, answered.message)
                    : `Whether ${name} has room for this worker couldn't be confirmed (${answered.message}), so it wasn't placed there. Spawn again in a moment.`,
                );
              }
              attached = answered.kind === "seats";
            }
            const abandon = prepared.abandon;
            return abandon === undefined ? {} : { abandon: Effect.andThen(letGo, abandon) };
          });
          return {
            name,
            givesBack: plan.givesBack,
            prepare,
            arrives: plan.prepare !== undefined,
            placement: placementOf(
              name,
              { ...sandbox, ...picks },
              { packing, ...(offer === undefined ? {} : { seat }) },
            ),
          };
        };
        if (sandbox.shareWith !== undefined) {
          const wanted = sandbox.shareWith.trim();
          let machine: ReturnType<typeof joined>[number] | undefined;
          if (isWorkerMachineName(wanted)) {
            machine = joined().find((each) => each.name === wanted && theirs(each));
            if (machine === undefined)
              return yield* fail(`No machine of your workers is named ${wanted}.`);
          } else {
            const worker = yield* store
              .getThread(wanted as ThreadId)
              .pipe(
                Effect.mapError(() => fail(`shareWith names no worker or machine: ${wanted}.`)),
              );
            if (worker.spawnedBy?.threadId !== caller)
              return yield* fail(`${worker.title} is not one of your workers.`);
            const host = hostOf(effectiveCheckout(worker));
            machine = joined().find((each) => each.id === host && theirs(each));
            if (machine === undefined)
              return yield* fail(
                `${worker.title} runs on your machine, not one of its own: leave out sandbox to put this worker there too.`,
              );
          }
          const known = yield* placed;
          const { facts } = known;
          const machineId = machine.id;
          const anothers = facts.threads.find(
            (thread) =>
              thread.spawnedBy !== undefined &&
              thread.spawnedBy.threadId !== caller &&
              hostOf(effectiveCheckout(thread)) === machineId,
          );
          if (anothers !== undefined)
            return yield* fail(
              `${machine.name} carries another orchestrator's worker (${anothers.title}), so yours isn't placed there: a machine is shared within one orchestrator only.`,
            );
          if (packingOn(facts.threads, machine.id) === "exclusive")
            return yield* fail(
              `${machine.name} was started for one worker only and is never shared. Give this worker a machine of its own (sandbox: {"own": true}), or one of your shared machines ({"shared": true}).`,
            );
          const started = picksOn(facts.threads, machine.id);
          const differs = picksMismatch(picks, started);
          if (differs !== undefined)
            return yield* fail(
              `${machine.name} isn't what this worker asks for: it names ${differs}. Leave that out to take the machine as it is, or give the worker a machine of its own.`,
            );
          const room = roomOn(known, machine, started?.size);
          if (room.free <= 0)
            return yield* fail(fullWords(machine.name, room.cap, room.on, room.held));
          return seated(shared(machine), "named", picks.environment ?? started?.environment);
        }
        if (sandbox.shared === true) {
          const known = yield* placed;
          const { facts } = known;
          const key = picksKey(picks);
          const pool = joined()
            .filter(
              (each) =>
                theirs(each) &&
                facts.threads.some(
                  (thread) =>
                    thread.spawnedBy?.threadId === caller &&
                    thread.spawnedBy.placement?.packing === "shared" &&
                    hostOf(effectiveCheckout(thread)) === each.id,
                ) &&
                packingOn(facts.threads, each.id) === "shared" &&
                picksKey(picksOn(facts.threads, each.id) ?? {}) === key,
            )
            .toSorted(
              (a, b) =>
                Number(b.onlineSince !== undefined) - Number(a.onlineSince !== undefined) ||
                a.name.localeCompare(b.name),
            );
          const fits = pool.find((each) => roomOn(known, each, picks.size).free > 0);
          if (fits !== undefined) return seated(shared(fits), "shared");
          const comingKey = JSON.stringify([caller, identity, key]);
          const begun = coming.get(comingKey);
          const there =
            begun === undefined ? undefined : joined().find((each) => each.name === begun);
          const still =
            begun !== undefined &&
            (there !== undefined ||
              seatHolds.on(begun).length > 0 ||
              machineFlights.has(flightKey(identity, begun)));
          if (begun !== undefined && !still) coming.delete(comingKey);
          const name =
            begun !== undefined &&
            still &&
            roomOn(
              known,
              { name: begun, ...(there === undefined ? {} : { id: there.id }) },
              picks.size,
            ).free > 0
              ? begun
              : workerMachineName(caller, `shared\n${key}\n${input.clientRequestId ?? seat}`);
          coming.set(comingKey, name);
          return seated(yield* bringUpPlan(name, "shared"), "shared");
        }
        const name = workerMachineName(
          caller,
          input.clientRequestId ?? `${input.project}\n${input.feature}\n${input.title}`,
        );
        const exclusive = sandbox.exclusive === true;
        return seated(
          yield* bringUpPlan(name, exclusive ? "exclusive" : "own"),
          exclusive ? "exclusive" : "own",
        );
      });
    const byName = (machine: string | undefined) => {
      const named = machine?.trim();
      const relayed =
        named === undefined
          ? undefined
          : joined().find(
              (each) =>
                each.via !== undefined &&
                each.onDemand === "worker" &&
                (each.name === named || each.id === named),
            );
      return relayed === undefined
        ? undefined
        : {
            givesBack: true,
            prepare: fence(relayed.name, workerMachineIdentity(relayed.via!, relayed.viaAccount)),
          };
    };
    return Object.assign(workerSandbox, { fence, byName });
  });
