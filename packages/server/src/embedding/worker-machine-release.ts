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

import {
  effectiveCheckout,
  type FeatureLedgerEntry,
  hostOf,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { RemoteHosts } from "../host/remote-hosts.ts";
import { finishedWorkers, isLiveWorker } from "../orchestration/ledger.ts";
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
/**
 * The workers whose machine may be told its work is over: finished as the ledger reads them and
 * with nothing still going on (`isLiveWorker`), so one whose pull request merged while its turn,
 * a build or a check still runs keeps its machine at work.
 */
export const releasableWorkers = (
  features: ReadonlyArray<Pick<FeatureLedgerEntry, "workers">>,
): ReadonlySet<ThreadId> =>
  new Set(
    features
      .flatMap((feature) => feature.workers)
      .filter((worker) => !isLiveWorker(worker))
      .map((worker) => worker.threadId),
  );

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
  /** The sign-in there it was asked for under: told only under it. */
  readonly viaAccount?: string | undefined;
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

/**
 * What to tell the provider of each worker machine this pass. An embedder's provider is told only
 * what changed, as it always was. A hosted server's: one at work is told it is working
 * unless that was told this run already: after a restart nothing is kept of what was told, and a
 * release the provider still holds would have it reclaim a machine its worker came back to. One
 * whose work is over is told it is released once it has settled (`WORKER_RELEASE_SETTLE_MS`, so
 * its first worker is placed first), unless that was told already. `told` is by `toldKey`.
 * `finished`: the workers whose machine may be released (`releasableWorkers`); an embedder's
 * machine is judged by `embeddedFinished` (`finishedWorkers`), as it always was.
 */
export const releaseDecisions = (
  machines: ReadonlyArray<ReleaseMachine>,
  threads: ReadonlyArray<
    Pick<Thread, "id" | "checkout" | "currentCheckout" | "spawnedBy" | "parked">
  >,
  finished: ReadonlySet<ThreadId>,
  now: number,
  told: ReadonlyMap<string, { readonly released: boolean; readonly at: number }>,
  embeddedFinished: ReadonlySet<ThreadId> = finished,
): ReadonlyArray<{ readonly machine: ReleaseMachine; readonly released: boolean }> =>
  machines
    .filter(
      (machine) =>
        machine.onDemand === "worker" && (machine.owner !== undefined || machine.via !== undefined),
    )
    .flatMap((machine): ReadonlyArray<{ machine: ReleaseMachine; released: boolean }> => {
      const over = machine.via === undefined ? embeddedFinished : finished;
      const atWork = threads.some(
        (thread) =>
          hostOf(effectiveCheckout(thread)) === machine.id &&
          !over.has(thread.id) &&
          !(thread.spawnedBy === undefined && thread.parked === true),
      );
      const said = told.get(toldKey(machine));
      // An embedder's provider: told only what changed, once the machine has settled, and never
      // that one it hasn't been told is released is working (as it always has been).
      if (machine.via === undefined) {
        const settled =
          machine.onlineSince === undefined ||
          now - machine.onlineSince >= WORKER_RELEASE_SETTLE_MS;
        const released = !atWork;
        return !settled || said?.released === released || (!released && said === undefined)
          ? []
          : [{ machine, released }];
      }
      // A hosted server's: what was told is trusted a while only, as a reuse that failed may have
      // taken a release back, and after a restart one at work is told so once.
      const fresh = (released: boolean) =>
        said !== undefined && said.released === released && now - said.at < TOLD_FOR_MS;
      if (atWork) return fresh(false) ? [] : [{ machine, released: false }];
      const settling =
        machine.onlineSince !== undefined && now - machine.onlineSince < WORKER_RELEASE_SETTLE_MS;
      return settling || fresh(true) ? [] : [{ machine, released: true }];
    });

/**
 * What the provider was last told of a machine is kept by: an embedder's by name, as it always
 * was, so one whose host came back with another key is still told its release is taken back; a
 * hosted server's by id, since one that takes the name of one reclaimed before has another key,
 * and so another id, and is told afresh.
 */
export const toldKey = (machine: ReleaseMachine) =>
  machine.via === undefined ? machine.name : machine.id;

/**
 * Keeps what a tell did. Taken: kept. Not: a hosted server's is forgotten, as it may have been
 * taken with the answer lost; an embedder's keeps what it was told before, so a take-back that
 * failed is told again next pass, as it always was.
 */
export const recordTold = (
  told: Map<string, { readonly released: boolean; readonly at: number }>,
  machine: ReleaseMachine,
  released: boolean,
  taken: boolean,
  now: number,
) => {
  if (taken) told.set(toldKey(machine), { released, at: now });
  else if (machine.via !== undefined) told.delete(toldKey(machine));
};

/** How long what was told of a machine is trusted before it is told again. */
export const TOLD_FOR_MS = 60 * 60_000;

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
 * to the embedder's provider. Undefined: there is no one to tell. A signed-in server's `404
 * not_found` is a release not applied, told again next pass, and forgets nothing here: a server
 * answers it for every machine while its cell is out of reach, and only `forgetReclaimed`, a few
 * passes in a row, forgets one.
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
        : tellSignedInRelease(
            signedIn,
            { name: machine.name, via: machine.via, account: machine.viaAccount },
            released,
          ).pipe(
            Effect.flatMap((told) =>
              told === "missing"
                ? Effect.fail(new Error("the server answered that it holds no such machine"))
                : Effect.void,
            ),
          )
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
    const relayed = signedIn?.port.available === true ? signedIn.port : undefined;
    const tell = releaseTeller(hosts, relayed);
    if (tell === undefined || remote === undefined) return;
    const orchestration = yield* Orchestration;
    const store = yield* ThreadStore;
    /** What the provider was last told of each machine (`toldKey`). */
    const told = new Map<string, { readonly released: boolean; readonly at: number }>();
    const pass = Effect.gen(function* () {
      const machines = remote.list().filter((machine) => machine.onDemand === "worker");
      if (machines.length === 0) return;
      const threads = yield* store.listThreads;
      const finished = new Set<ThreadId>();
      const embeddedFinished = new Set<ThreadId>();
      for (const workspace of yield* store.listWorkspaces) {
        const ledger = yield* orchestration.ledger(workspace.workspace.id).pipe(Effect.option);
        if (Option.isNone(ledger)) continue;
        for (const id of releasableWorkers(ledger.value.features)) finished.add(id);
        for (const id of finishedWorkers(ledger.value.features)) embeddedFinished.add(id);
      }
      for (const { machine, released } of releaseDecisions(
        machines,
        threads,
        finished,
        Date.now(),
        told,
        embeddedFinished,
      )) {
        const sent = yield* tell(machine, released).pipe(Effect.result);
        // Kept only once the provider took it: one it didn't apply is told again next pass.
        recordTold(told, machine, released, sent._tag === "Success", Date.now());
        if (sent._tag === "Failure") {
          yield* Effect.logWarning("a worker machine's release could not be told").pipe(
            Effect.annotateLogs({ machine: machine.name, reason: sent.failure.message }),
          );
        }
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
