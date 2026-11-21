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
  type MachineRun,
  ReleaseRefused,
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
      if (machine.via === undefined) {
        const settled =
          machine.onlineSince === undefined ||
          now - machine.onlineSince >= WORKER_RELEASE_SETTLE_MS;
        const released = !atWork;
        return !settled || said?.released === released || (!released && said === undefined)
          ? []
          : [{ machine, released }];
      }
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
 * A hosted server's release not sent this pass: it refused it as malformed (`ReleaseRefused`)
 * lately, so a server from before fences isn't asked every pass. Not told, all the same.
 */
export class ReleaseHeldOff extends Error {}

/**
 * How long after a hosted server first refuses a machine's release it is sent again; twice that
 * after each refusal more, to `TOLD_FOR_MS`.
 */
export const RELEASE_REFUSED_WAIT_MS = 2 * Duration.toMillis(WORKER_RELEASE_EVERY);

/**
 * How a machine's release is told: to the hosted server a desktop's worker host came through, or
 * to the embedder's provider. Undefined: there is no one to tell. A signed-in server's `404
 * not_found` is a release not applied, told again next pass, and forgets nothing here: a server
 * answers it for every machine while its backend is out of reach, and only `forgetReclaimed`, a few
 * passes in a row, forgets one. `run`: a hosted machine's run as the release was decided
 * (`knownRun`), the only one it is told for. One a hosted server refused as malformed (`400`, as
 * one from before fences answers a release that carries them) is never sent without them: it
 * stays to be told, and isn't sent again until `RELEASE_REFUSED_WAIT_MS` has passed, twice that
 * after a second refusal, and so on to `TOLD_FOR_MS`.
 */
export const releaseTeller = (
  hosts: OnDemandHosts | undefined,
  signedIn: WorkerMachinePortShape | undefined,
  now: () => number = Date.now,
) => {
  if (hosts === undefined && signedIn === undefined) return undefined;
  const refused = new Map<string, { readonly until: number; readonly waitMs: number }>();
  const tellSignedIn = (
    port: WorkerMachinePortShape,
    machine: ReleaseMachine & { readonly via: string },
    released: boolean,
    run: MachineRun | null | undefined,
  ): Effect.Effect<void, Error> =>
    Effect.suspend(() => {
      const at = now();
      for (const [each, entry] of refused) if (at - entry.until > TOLD_FOR_MS) refused.delete(each);
      const key = toldKey(machine);
      const before = refused.get(key);
      if (before !== undefined && at < before.until && before.until - at <= before.waitMs)
        return Effect.fail(new ReleaseHeldOff("the server refused it before; told again later"));
      return tellSignedInRelease(
        port,
        { name: machine.name, via: machine.via, account: machine.viaAccount },
        released,
        run === undefined ? {} : { run },
      ).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (!(error instanceof ReleaseRefused)) return;
            const waitMs =
              before === undefined
                ? RELEASE_REFUSED_WAIT_MS
                : Math.min(before.waitMs * 2, TOLD_FOR_MS);
            refused.set(key, { until: now() + waitMs, waitMs });
          }),
        ),
        Effect.tap(() => Effect.sync(() => refused.delete(key))),
        Effect.flatMap((told) =>
          told === "missing"
            ? Effect.fail(new Error("the server answered that it holds no such machine"))
            : Effect.void,
        ),
      );
    });
  return (
    machine: ReleaseMachine,
    released: boolean,
    run?: MachineRun | null,
  ): Effect.Effect<void, Error> =>
    machine.via !== undefined
      ? signedIn === undefined
        ? Effect.fail(new Error("no desktop app to tell"))
        : tellSignedIn(signedIn, { ...machine, via: machine.via }, released, run)
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
    const told = new Map<string, { readonly released: boolean; readonly at: number }>();
    const pass = Effect.gen(function* () {
      const machines = remote.list().filter((machine) => machine.onDemand === "worker");
      if (machines.length === 0) return;
      const runs = new Map<string, MachineRun | null | undefined>(
        machines.flatMap((machine) =>
          machine.via === undefined
            ? []
            : [
                [
                  machine.id,
                  relayed?.knownRun?.(machine.via, machine.name, machine.viaAccount),
                ] as const,
              ],
        ),
      );
      const threads = yield* store.listThreads;
      const finished = new Set<ThreadId>();
      const embeddedFinished = new Set<ThreadId>();
      for (const workspace of yield* store.listWorkspaces) {
        const ledger = yield* orchestration.ledger(workspace.workspace.id).pipe(Effect.option);
        if (Option.isNone(ledger)) continue;
        for (const id of releasableWorkers(ledger.value.features)) finished.add(id);
        for (const id of finishedWorkers(ledger.value.features)) embeddedFinished.add(id);
      }
      const decided = releaseDecisions(
        machines,
        threads,
        finished,
        Date.now(),
        told,
        embeddedFinished,
      ).map((decision) => ({ ...decision, run: runs.get(decision.machine.id) }));
      for (const { machine, released, run } of decided) {
        const sent = yield* tell(machine, released, run).pipe(Effect.result);
        recordTold(told, machine, released, sent._tag === "Success", Date.now());
        if (sent._tag === "Failure" && !(sent.failure instanceof ReleaseHeldOff)) {
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
