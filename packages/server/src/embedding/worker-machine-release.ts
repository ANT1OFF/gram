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
  ReleaseRateLimited,
  ReleaseRefused,
  SignedInWorkers,
  tellSignedInRelease,
  type WorkerMachinePortShape,
} from "./signed-in-workers.ts";
import { callOutside } from "./outside.ts";
import { reservedSeats } from "../orchestration/worker-packing.ts";
import { makeSeatUpkeep, seatAsker, seatsHere, withReserved } from "./worker-seat-upkeep.ts";
import { ReleaseOccupied, releaseOccupied } from "./worker-seats.ts";
import { WORKER_MACHINE_SETTLE_MS } from "./hosted-machine-use.ts";
import { busyThreads, setAsideReleased } from "./hosted-machine-set-aside.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { ServerConfig } from "../config.ts";
import { privateJsonFile } from "../http/remote-sessions.ts";

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

/** How often worker machines are looked at. */
export const WORKER_RELEASE_EVERY = Duration.minutes(2);
/** How long a newly online machine is given before it can be released. */
export const WORKER_RELEASE_SETTLE_MS = WORKER_MACHINE_SETTLE_MS;

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
  /** When it first joined: a hosted server's machine settles from this, not from its last dial. */
  readonly joinedAt?: number | undefined;
}

/** A thread `releaseDecisions` and `workerMachineWork` read. */
export type ReleaseThread = Pick<
  Thread,
  "id" | "checkout" | "currentCheckout" | "spawnedBy" | "parked" | "runWatches"
>;

/**
 * Whether a thread keeps its machine at work: not once the ledger reads it finished, nor once it
 * is archived (parked) with no run watched for it (`runWatches`, held across an archive) and
 * nothing going on in its session (`busy`). A parked thread no orchestrator spawned is over
 * whatever it holds, as it always was.
 */
export const atWork = (
  thread: ReleaseThread,
  finished: ReadonlySet<ThreadId>,
  busy: ReadonlySet<ThreadId>,
): boolean =>
  !finished.has(thread.id) &&
  !(
    thread.parked === true &&
    (thread.spawnedBy === undefined ||
      ((thread.runWatches?.length ?? 0) === 0 && !busy.has(thread.id)))
  );

/**
 * Each worker machine, and whether its work is over: no thread placed on it is still at work
 * (`atWork`). A machine online for less than the settling time is not judged.
 */
export const workerMachineWork = (
  machines: ReadonlyArray<ReleaseMachine>,
  threads: ReadonlyArray<
    Pick<Thread, "id" | "checkout" | "currentCheckout" | "spawnedBy" | "parked" | "runWatches">
  >,
  finished: ReadonlySet<ThreadId>,
  now: number,
  busy: ReadonlySet<ThreadId> = new Set(),
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
          hostOf(effectiveCheckout(thread)) === machine.id && atWork(thread, finished, busy),
      ),
    }));

/**
 * What to tell the provider of each worker machine this pass. An embedder's provider is told only
 * what changed, as it always was. A hosted server's: one at work is told it is working
 * unless that was told this run already: after a restart nothing is kept of what was told, and a
 * release the provider still holds would have it reclaim a machine its worker came back to. One
 * whose work is over is told it is released, unless that was told already: at once once a thread
 * was placed on it, else once it has settled (`WORKER_RELEASE_SETTLE_MS` from when it joined, so
 * its first worker is placed first). Never from its last dial: a relay that drops and dials again
 * every few minutes would keep it settling for good. `told` is by `toldKey`.
 * `finished`: the workers whose machine may be released (`releasableWorkers`); an embedder's
 * machine is judged by `embeddedFinished` (`finishedWorkers`), as it always was. A thread at work
 * is as `atWork` reads it, with `busy` the archived threads with something going on.
 */
export const releaseDecisions = (
  machines: ReadonlyArray<ReleaseMachine>,
  threads: ReadonlyArray<
    Pick<Thread, "id" | "checkout" | "currentCheckout" | "spawnedBy" | "parked" | "runWatches">
  >,
  finished: ReadonlySet<ThreadId>,
  now: number,
  told: ReadonlyMap<string, { readonly released: boolean; readonly at: number }>,
  embeddedFinished: ReadonlySet<ThreadId> = finished,
  busy: ReadonlySet<ThreadId> = new Set(),
): ReadonlyArray<{ readonly machine: ReleaseMachine; readonly released: boolean }> =>
  machines
    .filter(
      (machine) =>
        machine.onDemand === "worker" && (machine.owner !== undefined || machine.via !== undefined),
    )
    .flatMap((machine): ReadonlyArray<{ machine: ReleaseMachine; released: boolean }> => {
      const over = machine.via === undefined ? embeddedFinished : finished;
      const working = threads.some(
        (thread) => hostOf(effectiveCheckout(thread)) === machine.id && atWork(thread, over, busy),
      );
      const said = told.get(toldKey(machine));
      if (machine.via === undefined) {
        const settled =
          machine.onlineSince === undefined ||
          now - machine.onlineSince >= WORKER_RELEASE_SETTLE_MS;
        const released = !working;
        return !settled || said?.released === released || (!released && said === undefined)
          ? []
          : [{ machine, released }];
      }
      const fresh = (released: boolean) =>
        said !== undefined && said.released === released && now - said.at < TOLD_FOR_MS;
      if (working) return fresh(false) ? [] : [{ machine, released: false }];
      const placed = threads.some((thread) => hostOf(effectiveCheckout(thread)) === machine.id);
      const since = machine.joinedAt ?? machine.onlineSince;
      const settling = !placed && since !== undefined && now - since < WORKER_RELEASE_SETTLE_MS;
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
      Effect.promise(() => response.json().catch(() => undefined) as Promise<unknown>),
    ),
    Effect.flatMap((body) =>
      releaseOccupied(body) ? Effect.fail(new ReleaseOccupied()) : Effect.void,
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

/** The wait between two releases sent in one pass, so a pass never sends them in a burst. */
export const RELEASE_GAP_MS = 1_000;
/** How long a release not told waits before it is sent again; twice that after each miss more. */
export const RELEASE_RETRY_FIRST_MS = Duration.toMillis(WORKER_RELEASE_EVERY);
/** How long releases wait after a `429`; twice that after each one more, to `RELEASE_PAUSE_MOST_MS`. */
export const RELEASE_PAUSE_FIRST_MS = Duration.toMillis(WORKER_RELEASE_EVERY);
export const RELEASE_PAUSE_MOST_MS = 30 * 60_000;

/** A release that wasn't told: what it said, when it is sent again, and the wait it was given. */
export interface ReleaseRetry {
  readonly released: boolean;
  readonly at: number;
  readonly waitMs: number;
}

/**
 * What the release pass keeps between passes: what each machine was told (`told`, by `toldKey`),
 * each release not told yet with when it is sent again (`retry`), and how long every release
 * waits after the server rate-limited them (`paused`). `fileReleaseState` keeps it across a
 * restart.
 */
export interface ReleaseState {
  readonly told: Map<string, { readonly released: boolean; readonly at: number }>;
  readonly retry: Map<string, ReleaseRetry>;
  paused: { readonly until: number; readonly waitMs: number } | undefined;
  /** Writes it down; a no-op in memory. */
  readonly save: () => void;
}

export const memoryReleaseState = (): ReleaseState => ({
  told: new Map(),
  retry: new Map(),
  paused: undefined,
  save: () => undefined,
});

const RELEASES_FILE = "worker-machine-releases.json";
const RELEASES_FILE_MOST = 256 * 1024;
const RELEASES_KEPT_MOST = 512;

/**
 * `ReleaseState` kept in `worker-machine-releases.json` beside the machines, so a restart neither
 * sends every release again in a burst nor forgets one owed. Only releases told (`released: true`)
 * are kept of `told`: a machine at work is told it is working once after a restart, in case the
 * server still holds a release from before. A time read back is never further off than its longest
 * wait from now, so a clock stepped back keeps nothing waiting longer. A file that can't be read is
 * started afresh, as after a restart before this was kept.
 */
export const fileReleaseState = (dataDir: string, now: () => number = Date.now): ReleaseState => {
  const file = privateJsonFile(dataDir, RELEASES_FILE, RELEASES_FILE_MOST);
  const state: ReleaseState = {
    told: new Map(),
    retry: new Map(),
    paused: undefined,
    save: () =>
      file.write({
        version: 1,
        told: [...state.told]
          .filter(([, told]) => told.released)
          .slice(-RELEASES_KEPT_MOST)
          .map(([key, told]) => ({ key, at: told.at })),
        retry: [...state.retry]
          .slice(-RELEASES_KEPT_MOST)
          .map(([key, retry]) => ({ key, ...retry })),
        ...(state.paused === undefined ? {} : { paused: state.paused }),
      }),
  };
  const at = now();
  const time = (value: unknown, most: number) =>
    typeof value === "number" && Number.isSafeInteger(value)
      ? Math.min(value, at + most)
      : undefined;
  try {
    const read = file.read() as
      | { version?: unknown; told?: unknown; retry?: unknown; paused?: unknown }
      | undefined;
    if (read?.version === 1) {
      for (const each of Array.isArray(read.told) ? read.told.slice(0, RELEASES_KEPT_MOST) : []) {
        const told = time(each?.at, 0);
        if (typeof each?.key === "string" && told !== undefined)
          state.told.set(each.key, { released: true, at: told });
      }
      for (const each of Array.isArray(read.retry) ? read.retry.slice(0, RELEASES_KEPT_MOST) : []) {
        const due = time(each?.at, TOLD_FOR_MS);
        if (
          typeof each?.key === "string" &&
          typeof each.released === "boolean" &&
          due !== undefined &&
          typeof each.waitMs === "number" &&
          each.waitMs > 0 &&
          each.waitMs <= TOLD_FOR_MS
        )
          state.retry.set(each.key, { released: each.released, at: due, waitMs: each.waitMs });
      }
      const paused = read.paused as { until?: unknown; waitMs?: unknown } | undefined;
      const until = time(paused?.until, RELEASE_PAUSE_MOST_MS);
      if (
        until !== undefined &&
        typeof paused?.waitMs === "number" &&
        paused.waitMs > 0 &&
        paused.waitMs <= RELEASE_PAUSE_MOST_MS
      )
        state.paused = { until, waitMs: paused.waitMs };
    }
  } catch {
    return state;
  }
  return state;
};

/**
 * Sends this pass's releases, one at a time, `gapMs` apart: each machine at work first (so none
 * is reclaimed while releases wait), then each whose work is over. A release not told is sent
 * again after `RELEASE_RETRY_FIRST_MS`, twice that after each miss more, to `TOLD_FOR_MS`, and
 * not before, whatever the passes in between decide; one deciding the other way is sent at once.
 * A `429` (`ReleaseRateLimited`) ends the pass, and no release is sent until
 * `RELEASE_PAUSE_FIRST_MS` has passed, twice that after each one more, to `RELEASE_PAUSE_MOST_MS`.
 * A release its provider held back because workers still have seats on the machine
 * (`ReleaseOccupied`) is no miss: `occupied` is told, the seats of workers whose work is over are
 * given up (`worker-seat-upkeep.ts`), and the next pass sends it again.
 * `state` is written down once the pass is over.
 */
export const releaseSends = (
  decided: ReadonlyArray<{
    readonly machine: ReleaseMachine;
    readonly released: boolean;
    readonly run?: MachineRun | null | undefined;
  }>,
  tell: (
    machine: ReleaseMachine,
    released: boolean,
    run?: MachineRun | null,
  ) => Effect.Effect<void, Error>,
  state: ReleaseState,
  options: {
    readonly now?: () => number;
    readonly gapMs?: number;
    /** Told of a machine whose release its provider held back for the seats still on it. */
    readonly occupied?: (machine: ReleaseMachine) => void;
  } = {},
) =>
  Effect.gen(function* () {
    const now = options.now ?? Date.now;
    const paused = state.paused;
    if (paused !== undefined && now() < paused.until) return;
    const start = now();
    const due = decided
      .filter(({ machine, released }) => {
        const retry = state.retry.get(toldKey(machine));
        return retry === undefined || retry.released !== released || start >= retry.at;
      })
      .toSorted((a, b) => Number(a.released) - Number(b.released));
    let notTold = 0;
    for (const [index, { machine, released, run }] of due.entries()) {
      if (index > 0) yield* Effect.sleep(options.gapMs ?? RELEASE_GAP_MS);
      const sent = yield* tell(machine, released, run ?? undefined).pipe(Effect.result);
      const at = now();
      const key = toldKey(machine);
      recordTold(state.told, machine, released, sent._tag === "Success", at);
      if (sent._tag === "Success") {
        state.retry.delete(key);
        state.paused = undefined;
        continue;
      }
      if (sent.failure instanceof ReleaseRateLimited) {
        const waitMs =
          paused === undefined
            ? RELEASE_PAUSE_FIRST_MS
            : Math.min(paused.waitMs * 2, RELEASE_PAUSE_MOST_MS);
        state.paused = { until: at + waitMs, waitMs };
        yield* Effect.logWarning(
          "worker machine releases wait: the server is rate-limiting them",
        ).pipe(Effect.annotateLogs({ waiting: due.length - index, waitMs }));
        break;
      }
      if (sent.failure instanceof ReleaseHeldOff) continue;
      if (sent.failure instanceof ReleaseOccupied) {
        state.retry.delete(key);
        options.occupied?.(machine);
        continue;
      }
      const before = state.retry.get(key);
      const waitMs =
        before === undefined || before.released !== released
          ? RELEASE_RETRY_FIRST_MS
          : Math.min(before.waitMs * 2, TOLD_FOR_MS);
      state.retry.set(key, { released, at: at + waitMs, waitMs });
      notTold += 1;
      yield* Effect.logWarning("a worker machine's release could not be told").pipe(
        Effect.annotateLogs({ machine: machine.name, reason: sent.failure.message, waitMs }),
      );
    }
    if (due.length > 0 || notTold > 0)
      yield* Effect.try(() => state.save()).pipe(
        Effect.catch((error) =>
          Effect.logWarning("what worker machines were told could not be written down").pipe(
            Effect.annotateLogs({ reason: String(error) }),
          ),
        ),
      );
  });

/** Forgets what `state` holds of machines no longer registered (`keys`, by `toldKey`). */
export const forgetUnregistered = (state: ReleaseState, keys: ReadonlySet<string>) => {
  for (const key of state.told.keys()) if (!keys.has(key)) state.told.delete(key);
  for (const key of state.retry.keys()) if (!keys.has(key)) state.retry.delete(key);
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
    const runtimes = Option.getOrUndefined(yield* Effect.serviceOption(ThreadRuntimes));
    const config = Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig));
    const state = yield* Effect.sync(() =>
      config === undefined ? memoryReleaseState() : fileReleaseState(config.dataDir),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("what worker machines were told could not be read", cause).pipe(
          Effect.as(memoryReleaseState()),
        ),
      ),
    );
    const told = state.told;
    const asker = seatAsker(hosts, relayed);
    const upkeep = asker === undefined ? undefined : makeSeatUpkeep(asker);
    const pass = Effect.gen(function* () {
      const machines = remote.list().filter((machine) => machine.onDemand === "worker");
      upkeep?.prune(new Set(machines.map((machine) => machine.id)));
      if (machines.length === 0) return;
      forgetUnregistered(state, new Set(machines.map(toldKey)));
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
      if (upkeep !== undefined)
        for (const machine of machines)
          yield* upkeep.look(
            machine,
            withReserved(
              seatsHere(machine, threads, machine.via === undefined ? embeddedFinished : finished),
              reservedSeats(machine.name),
            ),
          );
      const ids = new Set(machines.map((machine) => machine.id));
      const archived = threads.filter(
        (thread) => thread.parked === true && ids.has(hostOf(effectiveCheckout(thread))),
      );
      const busy =
        runtimes === undefined
          ? new Set(archived.map((thread) => thread.id))
          : archived.length === 0
            ? new Set<ThreadId>()
            : yield* busyThreads(runtimes, archived);
      const decided = releaseDecisions(
        machines,
        threads,
        finished,
        Date.now(),
        told,
        embeddedFinished,
        busy,
      )
        .filter(({ machine, released }) => !released || reservedSeats(machine.name).length === 0)
        .map((decision) => ({ ...decision, run: runs.get(decision.machine.id) }));
      yield* releaseSends(
        decided,
        tell,
        state,
        upkeep === undefined ? {} : { occupied: upkeep.occupied },
      );
    });
    const asidePass = Effect.gen(function* () {
      const aside = signedIn?.setAside;
      if (aside === undefined || runtimes === undefined) return;
      const machines = remote.list().filter((machine) => machine.onDemand === "worker");
      const isAside = (machine: ReleaseMachine) =>
        remote.machines.get(machine.id)?.setAside !== undefined;
      const candidates = machines.filter(
        (machine) =>
          machine.via !== undefined &&
          machine.onlineSince === undefined &&
          !isAside(machine) &&
          told.get(toldKey(machine))?.released === true,
      );
      yield* setAsideReleased(
        candidates,
        machines.filter(isAside),
        { store, runtimes },
        aside.stopped,
        aside.takeBack,
      );
    });
    yield* pass.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("the worker machine release pass failed", cause),
      ),
      Effect.andThen(
        asidePass.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("the worker machine set-aside pass failed", cause),
          ),
        ),
      ),
      Effect.repeat(Schedule.spaced(WORKER_RELEASE_EVERY)),
      Effect.forkScoped,
    );
  }),
);
