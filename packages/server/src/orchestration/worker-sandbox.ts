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
  workerMachineIdentity,
  workerMachineName,
} from "../embedding/worker-machines.ts";
import { refusal } from "./rules.ts";
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
        const owner = ownerSubject(workerHosts?.ownerOf(ownHost));
        const holder = workerHosts?.ownerOf(ownHost);
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
              ? "Workers can't have machines of their own here: leave out sandbox, and the worker runs on your machine."
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
          if (refused !== undefined) return yield* fail(refused);
        }
        const shared = (machine: { readonly name: string }) =>
          !source.givesBack
            ? { name: machine.name, givesBack: false }
            : {
                name: machine.name,
                givesBack: true,
                prepare: Effect.gen(function* () {
                  yield* fence(machine.name, source.identity ?? "");
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
        const offered = yield* source.choices;
        const resolved = resolveWorkerPicks(offered?.choices, sandbox);
        if ("refused" in resolved) return yield* fail(resolved.refused);
        const picks = resolved.picks;
        const name = workerMachineName(
          caller,
          input.clientRequestId ?? `${input.project}\n${input.feature}\n${input.title}`,
        );
        const seen = joined().find((each) => each.name === name && theirs(each));
        const identity = source.identity ?? "";
        if (
          seen?.onlineSince !== undefined &&
          !(source.givesBack && machineFlights.has(flightKey(identity, name)))
        )
          return { name, givesBack: source.givesBack };
        const bringUp = Effect.gen(function* () {
          const already = joined().find((each) => each.name === name && theirs(each));
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
                  .pipe(Effect.onInterrupt(() => source.abandon(name, { unsettled: true })));
          if (asked.kind === "refused") {
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
