// Telling the host provider when a worker's own machine has no work left (`worker-machines.ts`).
//
// A machine an orchestrator started for its workers pauses when idle and wakes on the next message,
// so a finished worker's machine costs only its disk. The provider keeps that disk for a while
// after the work ends and then reclaims it; what it can't see is when the work ended, which is
// Gram's to say: every worker on the machine finished, as the ledger reads it (its pull requests
// merged or closed, delivered, or archived), or closed with its worktree.
//
// Every `WORKER_RELEASE_EVERY` this looks at each joined worker machine and tells the provider
// (`POST /hosts/release`) once when it has none left at work, and once more, `released: false`,
// should one be at work there again (a worker reopened), so its disk is kept. A machine that came
// online within `WORKER_RELEASE_SETTLE_MS` is left alone: its first worker may not be placed yet.
// What was told is kept in memory: after a restart it is told again, which the provider takes as
// the same word.

import { effectiveCheckout, hostOf, type Thread, type ThreadId } from "@gram/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { RemoteHosts } from "../host/remote-hosts.ts";
import { finishedWorkers } from "../orchestration/ledger.ts";
import { Orchestration } from "../orchestration/service.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { OnDemand, type OnDemandHosts } from "./on-demand.ts";
import {
  SignedInWorkers,
  tellSignedInRelease,
  type WorkerMachinePortShape,
} from "./signed-in-workers.ts";
import { callOutside } from "./outside.ts";

/** How often worker machines are looked at. */
export const WORKER_RELEASE_EVERY = Duration.minutes(10);
/** How long a newly online machine is given before it can be released. */
export const WORKER_RELEASE_SETTLE_MS = 30 * 60_000;

/** A joined machine as this reads it. */
export interface ReleaseMachine {
  readonly id: string;
  readonly name: string;
  readonly owner?: string | undefined;
  readonly onDemand?: string | undefined;
  /** The hosted server a desktop's worker host came through (`signed-in-workers.ts`). */
  readonly via?: string | undefined;
  readonly onlineSince?: number | undefined;
}

/**
 * Each worker machine, and whether its work is over: no open thread placed on it is still at work.
 * A thread is over once the ledger reads it finished, or, for one no orchestrator spawned, once it
 * is parked. A machine online for less than the settling time is not judged.
 */
export const workerMachineWork = (
  machines: ReadonlyArray<ReleaseMachine>,
  threads: ReadonlyArray<
    Pick<Thread, "id" | "checkout" | "currentCheckout" | "spawnedBy" | "parked">
  >,
  finished: ReadonlySet<ThreadId>,
  now: number,
): ReadonlyArray<{ readonly machine: ReleaseMachine; readonly over: boolean }> =>
  machines
    .filter(
      (machine) =>
        machine.onDemand === "worker" &&
        (machine.owner !== undefined || machine.via !== undefined) &&
        (machine.onlineSince === undefined ||
          now - machine.onlineSince >= WORKER_RELEASE_SETTLE_MS),
    )
    .map((machine) => ({
      machine,
      over: !threads.some(
        (thread) =>
          hostOf(effectiveCheckout(thread)) === machine.id &&
          !finished.has(thread.id) &&
          !(thread.spawnedBy === undefined && thread.parked === true),
      ),
    }));

/** Tells the provider a worker machine's work is over, or going on again. 404: it keeps none. */
export const tellRelease = (hosts: OnDemandHosts, machine: ReleaseMachine, released: boolean) =>
  callOutside("host provider", hosts.provider, {
    method: "POST",
    path: "/hosts/release",
    json: {
      kind: "worker",
      owner: machine.owner,
      name: machine.name,
      released,
      reason: released ? "finished" : "working",
    },
    accept: [404],
    timeoutMs: 15_000,
  }).pipe(
    Effect.flatMap((response) =>
      Effect.promise(() => response.body?.cancel() ?? Promise.resolve()),
    ),
  );

/**
 * How a machine's release is told: to the hosted server a desktop's worker host came through, or
 * to the embedder's provider. Undefined: there is no one to tell.
 */
export const releaseTeller = (
  hosts: OnDemandHosts | undefined,
  signedIn: WorkerMachinePortShape | undefined,
) => {
  if (hosts === undefined && signedIn === undefined) return undefined;
  return (machine: ReleaseMachine, released: boolean): Effect.Effect<void, Error> =>
    machine.via !== undefined
      ? signedIn === undefined
        ? Effect.fail(new Error("no desktop app to tell"))
        : tellSignedInRelease(signedIn, { name: machine.name, via: machine.via }, released)
      : hosts === undefined
        ? Effect.fail(new Error("no host provider to tell"))
        : tellRelease(hosts, machine, released);
};

/** Looks at the worker machines every `WORKER_RELEASE_EVERY`, with a provider and joined machines. */
export const WorkerMachineReleaseLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const hosts = Option.getOrUndefined(yield* Effect.serviceOption(OnDemand));
    const signedIn = Option.getOrUndefined(yield* Effect.serviceOption(SignedInWorkers));
    const remote = Option.getOrUndefined(yield* Effect.serviceOption(RemoteHosts));
    const tell = releaseTeller(
      hosts,
      signedIn?.port.available === true ? signedIn.port : undefined,
    );
    if (tell === undefined || remote === undefined) return;
    const orchestration = yield* Orchestration;
    const store = yield* ThreadStore;
    /**
     * What the provider was last told of each machine, by its id: a machine that takes the name of
     * one reclaimed before it has another key, and so another id, and is told afresh.
     */
    const told = new Map<string, boolean>();
    const pass = Effect.gen(function* () {
      const machines = remote.list().filter((machine) => machine.onDemand === "worker");
      if (machines.length === 0) return;
      const threads = yield* store.listThreads;
      const finished = new Set<ThreadId>();
      for (const workspace of yield* store.listWorkspaces) {
        const ledger = yield* orchestration.ledger(workspace.workspace.id).pipe(Effect.option);
        if (Option.isSome(ledger))
          for (const id of finishedWorkers(ledger.value.features)) finished.add(id);
      }
      for (const { machine, over } of workerMachineWork(machines, threads, finished, Date.now())) {
        if (told.get(machine.id) === over) continue;
        // A machine never told it was released needs no word that it is at work.
        if (!over && !told.has(machine.id)) continue;
        const sent = yield* tell(machine, over).pipe(Effect.result);
        if (sent._tag === "Success") told.set(machine.id, over);
        else
          yield* Effect.logWarning("a worker machine's release could not be told").pipe(
            Effect.annotateLogs({ machine: machine.name, reason: sent.failure.message }),
          );
      }
    });
    yield* pass.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("the worker machine release pass failed", cause),
      ),
      Effect.repeat(Schedule.spaced(WORKER_RELEASE_EVERY)),
      Effect.forkScoped,
    );
  }),
);
