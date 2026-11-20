// Where `spawn_worker`'s `sandbox` puts a worker (`tools.ts`): on a machine of its own, started
// as the spawn goes ahead, from the embedder's provider or the hosted server the desktop app is
// signed in to; on one its orchestrator already has; or on the orchestrator's own machine.

import { AppToolError, effectiveCheckout, hostOf, type ThreadId } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
  resolveWorkerPicks,
  type WorkerMachineSource,
  workerMachineName,
} from "../embedding/worker-machines.ts";
import { refusal } from "./rules.ts";
import type { Orchestration } from "./service.ts";
import type { WorkerSandbox } from "./tool-inputs.ts";

/** Why a spawn can't reuse a machine the server says it doesn't hold (reclaimed, most likely). */
const reclaimedWords = (name: string) =>
  `The server says it no longer holds the machine ${name}: most likely it was reclaimed once its work was over, so the worker wasn't placed on it. Spawn again with another clientRequestId for a new machine, or leave out sandbox to run the worker on your machine.`;

/**
 * One machine name's bring-up (`makeWorkerSandbox`): how many tries of its spawn hold it, and,
 * while one gives it back, what the rest wait for before they join it or begin again.
 */
interface Flight {
  readonly fiber: Fiber.Fiber<{ readonly startedHere: boolean }, AppToolError>;
  holders: number;
  closing?: Deferred.Deferred<void> | undefined;
}

/** What the sandbox planner reads: the tools' own services, as `tools.ts` has them. */
export interface WorkerSandboxDeps {
  readonly orchestration: Orchestration["Service"];
  readonly store: ThreadStore["Service"];
  readonly onDemand: OnDemand["Service"] | undefined;
  readonly signedIn: SignedInWorkers["Service"] | undefined;
  readonly workerHosts: WorkerHosts["Service"] | undefined;
  readonly joined: () => ReturnType<RemoteHosts["Service"]["list"]>;
}

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
    /**
     * Each machine name's bring-up under way (`workerSandbox`), with how many tries of its spawn
     * hold it. Run in the tools' own scope, so it outlives the try that began it.
     */
    const machineFlights = new Map<string, Flight>();
    const flightScope = yield* Effect.scope;
    /**
     * Holds `name`'s bring-up for this try, in its scope: waits out one being given back (its stop
     * answered included), then joins the one under way, or begins `start` when there is none and
     * it is given one. Whether it waited, and the bring-up held, if any. Every placement on a
     * machine goes through here (`fence`), so none lands on one being given back.
     */
    const holdFlight = (
      name: string,
      start?: Effect.Effect<{ readonly startedHere: boolean }, AppToolError>,
    ) =>
      Effect.gen(function* () {
        let waited = false;
        for (;;) {
          const taken = yield* Effect.acquireRelease(
            Effect.gen(function* () {
              const joining = machineFlights.get(name);
              if (joining?.closing !== undefined) return { wait: joining.closing };
              if (joining !== undefined) {
                joining.holders += 1;
                return { held: joining };
              }
              if (start === undefined) return { none: true as const };
              const made: Flight = { fiber: yield* Effect.forkIn(start, flightScope), holders: 1 };
              machineFlights.set(name, made);
              return { held: made };
            }),
            (got) =>
              Effect.gen(function* () {
                if (!("held" in got)) return;
                const held = got.held;
                held.holders -= 1;
                if (held.holders > 0) return;
                // No try holds it: stopped, giving back what it started, and closed to every
                // try until that is over, its stop answered included.
                const closing = yield* Deferred.make<void>();
                held.closing = closing;
                yield* Fiber.interrupt(held.fiber).pipe(
                  Effect.ensuring(
                    Effect.suspend(() => {
                      if (machineFlights.get(name) === held) machineFlights.delete(name);
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
    /**
     * A worker placed on a machine there is already (shared, or named): held as a try of its
     * bring-up while one is under way, so a give-back never stops it under this worker, and
     * refused when one given back meanwhile took the machine with it.
     */
    const fence = (
      name: string,
    ): Effect.Effect<
      { readonly abandon?: Effect.Effect<void> | undefined },
      AppToolError,
      Scope.Scope
    > =>
      Effect.gen(function* () {
        const { waited } = yield* holdFlight(name);
        if (waited && !joined().some((each) => each.name === name))
          return yield* new AppToolError({
            tool: "spawn_worker",
            message: `${name} was given back as this worker was placed, so it isn't there to place it on. Spawn again on a machine of its own, or leave out sandbox to run the worker on your machine.`,
          });
        return {};
      });
    /**
     * Where `sandbox` puts a worker: the name of a machine of its own, started now, or of one its
     * orchestrator already has; or nothing, for the orchestrator's own machine.
     */
    const workerSandbox = (
      caller: ThreadId,
      input: {
        readonly title: string;
        readonly feature: string;
        readonly project: string;
        readonly clientRequestId?: string | undefined;
        readonly model?: string | undefined;
      },
      sandbox: WorkerSandbox,
    ): Effect.Effect<
      | {
          readonly name: string;
          /** Whether its provider gives machines back (`WorkerMachineSource.givesBack`). */
          readonly givesBack: boolean;
          /** Starts it and waits for it to come: run once the spawn goes ahead. */
          readonly prepare?: Effect.Effect<
            { readonly abandon?: Effect.Effect<void> | undefined },
            AppToolError,
            Scope.Scope
          >;
        }
      | undefined,
      AppToolError
    > =>
      Effect.gen(function* () {
        const tool = "spawn_worker";
        const fail = (message: string) => new AppToolError({ tool, message });
        if (sandbox.shareWith === undefined && sandbox.own !== true) {
          if (
            sandbox.size !== undefined ||
            sandbox.architecture !== undefined ||
            sandbox.isolation !== undefined ||
            sandbox.environment !== undefined
          )
            return yield* fail(
              'size, architecture, isolation and environment are for a machine of its own: add "own": true.',
            );
          return undefined;
        }
        const orchestrator = yield* store
          .getThread(caller)
          .pipe(Effect.mapError(() => fail("Your thread can't be read now.")));
        const ownHost = hostOf(effectiveCheckout(orchestrator));
        // A closed machine's holder is no one's to start machines for (`host/ownership.ts`).
        const owner = ownerSubject(workerHosts?.ownerOf(ownHost));
        const holder = workerHosts?.ownerOf(ownHost);
        // The embedder's provider for the orchestrator host's owner; or, for an orchestrator on a
        // machine of no one's in particular in the desktop app, the server the app is signed in to.
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
        if (found === undefined || "refused" in found)
          return yield* fail(
            found === undefined
              ? // As it always was, word for word: an embedded Gram's orchestrators read it.
                "Workers can't have machines of their own here: leave out sandbox, and the worker runs on your machine."
              : `Workers can't have machines of their own here: ${found.refused}. Leave out sandbox, and the worker runs on your machine.`,
          );
        const source = found;
        const theirs = source.theirs;
        // Its machines run the provider's models: a worker on another is refused before any
        // machine is asked for, never started on another model without a word.
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
          if (refused !== undefined) return yield* fail(refused);
        }
        /**
         * A machine of its workers it shares. An embedder's (`givesBack: false`): by name alone,
         * online or not, straight to the spawn, as it always was: its provider wakes it, and a
         * retry of a spawn already made returns that worker without reaching the machine. A hosted
         * server's, offline (it may be released once its work was over, and sleeps until told
         * otherwise): told it is working and waited for as the spawn goes ahead, once any
         * give-back of it is waited out. Never given back: it is the other workers' too.
         */
        const shared = (machine: { readonly name: string }) =>
          !source.givesBack
            ? { name: machine.name, givesBack: false }
            : {
                name: machine.name,
                givesBack: true,
                prepare: Effect.gen(function* () {
                  yield* fence(machine.name);
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
        if (sandbox.shareWith !== undefined) {
          const named = sandbox.shareWith.trim();
          if (isWorkerMachineName(named)) {
            const machine = joined().find((each) => each.name === named && theirs(each));
            if (machine === undefined)
              return yield* fail(`No machine of your workers is named ${named}.`);
            return shared(machine);
          }
          const worker = yield* store
            .getThread(named as ThreadId)
            .pipe(Effect.mapError(() => fail(`shareWith names no worker or machine: ${named}.`)));
          if (worker.spawnedBy?.threadId !== caller)
            return yield* fail(`${worker.title} is not one of your workers.`);
          const host = hostOf(effectiveCheckout(worker));
          const machine = joined().find((each) => each.id === host && theirs(each));
          if (machine === undefined)
            return yield* fail(
              `${worker.title} runs on your machine, not one of its own: leave out sandbox to put this worker there too.`,
            );
          return shared(machine);
        }
        // Picks by the provider's option ids, or by their labels ("No Internet"), as it offers them.
        const offered = yield* source.choices;
        const resolved = resolveWorkerPicks(offered?.choices, sandbox);
        if ("refused" in resolved) return yield* fail(resolved.refused);
        const picks = resolved.picks;
        const name = workerMachineName(
          caller,
          input.clientRequestId ?? `${input.project}\n${input.feature}\n${input.title}`,
        );
        // Online already (a retry): nothing to start, unless a try that brought it up is still
        // placing its worker, which this one then joins (`machineFlights`), so that try's
        // cancellation never gives it back under this one. Otherwise a hosted server's is started
        // only once the spawn goes ahead, after any approval (`handle`), so a refused or denied
        // spawn starts nothing; an embedder's is started and waited for here, before any card, so
        // the spawn's machine and model are admitted before it asks, as they always were.
        const seen = joined().find((each) => each.name === name && theirs(each));
        if (seen?.onlineSince !== undefined && !(source.givesBack && machineFlights.has(name)))
          return { name, givesBack: source.givesBack };
        // Brings the machine up: started (or, registered from an earlier spawn, told it is
        // working) and waited for. Whether this bring-up started it, and so may give it back.
        const bringUp = Effect.gen(function* () {
          // Read as the spawn goes ahead, after any card: what is registered now decides whether
          // this starts the machine (and may give it back) or waits for one it found.
          const already = joined().find((each) => each.name === name && theirs(each));
          // Reused, it may have been released once its earlier work was over, and sleeps until it
          // is told it is working: told so before it is waited for.
          if (already !== undefined && (yield* source.unrelease(name)) === "gone")
            return yield* fail(reclaimedWords(name));
          const asked =
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
                  })
                  // Stopped while the start is on its way: the server may start it all the same.
                  .pipe(Effect.onInterrupt(() => source.abandon(name, { unsettled: true })));
          if (asked.kind === "refused") {
            // No answer may still have started it: given back, so none runs for nothing.
            if (asked.unknown === true) yield* source.abandon(name, { unsettled: true });
            return yield* fail(asked.message);
          }
          if (asked.kind === "over-total") {
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
            return yield* fail(refusal("over_total", overTotalWords(asked, workersOn)));
          }
          const arrived = yield* source.arrive(name).pipe(
            // Stopped while it waits, with no try left to want it: what it asked for is given back.
            Effect.onInterrupt(() => (already === undefined ? source.abandon(name) : Effect.void)),
          );
          if (typeof arrived !== "string") {
            // A machine registered here before this try (an earlier spawn of the same id) may
            // hold that spawn's work on its disk: only a machine this try started is stopped.
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
        // An embedder's provider keeps its machines and gives none back: brought up now, as the
        // call is resolved, and placed by name.
        if (!source.givesBack) {
          yield* bringUp;
          return { name, givesBack: false };
        }
        // Given back if the spawn is refused after it came, so none is left running for nothing:
        // never while another try of the same request still holds it, nor while a thread is
        // placed on it (the spawn's own worker made before it failed included), nor when that
        // can't be read.
        const giveBack = (flight: Flight) =>
          Effect.gen(function* () {
            if (flight.holders > 1 || flight.closing !== undefined) return;
            // No try joins it from here on (`closing`), so none takes a machine being given back.
            const closing = yield* Deferred.make<void>();
            flight.closing = closing;
            let stopped = false;
            const open = Effect.suspend(() => {
              // Given back: the next try brings one up afresh. Kept: tries join it again.
              if (stopped && machineFlights.get(name) === flight) machineFlights.delete(name);
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
        // One bring-up of a name at a time (`machineFlights`): a try of the same request while
        // one is under way (a reconnect, a tool call tried again) joins it rather than starting,
        // waiting and giving back on its own. The bring-up outlives any one try, and is stopped,
        // giving back what it started, only once no try holds it.
        const prepare = Effect.gen(function* () {
          // One being given back takes no one: waited out, then joined if it was kept, or begun
          // afresh once it is gone.
          const { flight } = yield* holdFlight(name, bringUp);
          if (flight === undefined) return {};
          const brought = yield* Fiber.join(flight.fiber);
          return brought.startedHere ? { abandon: giveBack(flight) } : {};
        });
        return { name, givesBack: true, prepare };
      });
    /**
     * The plan for a worker `spawn_worker` places by `machine` on one a hosted server started: it
     * holds that machine's bring-up (`fence`), and its machine is given back by its provider.
     */
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
      return relayed === undefined ? undefined : { givesBack: true, prepare: fence(relayed.name) };
    };
    return Object.assign(workerSandbox, { fence, byName });
  });
