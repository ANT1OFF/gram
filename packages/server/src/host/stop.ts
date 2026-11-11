// A host readied to be stopped with its disk kept (`host.stop.prepare`): it stops taking new work,
// says whether anything still runs on it, and keeps each thread's work in progress off the machine
// under a hidden ref (`@gram/git`'s `wip.ts`). Whoever runs the machine then stops it; a host
// started later on the same disk finds the folders, branches and agent transcripts as they were.

import {
  type HostBusy,
  HostFailed,
  type HostStopCheckout,
  type HostStopKept,
  type HostStopPrepared,
} from "@gram/contracts";
import {
  isPushRemote,
  Proc,
  type ProcShape,
  pushWip,
  samePath,
  snapshotWip,
  tryRepoRoots,
} from "@gram/git";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { Admission } from "./admission.ts";
import { redactUrlCredentials } from "./remote-url.ts";

/** Why new work is refused while the host is readied to stop. */
export const STOPPING = "This machine is about to stop. Try again once it is back.";

/** How long a host readied to stop refuses new work when no stop and no cancel follows. */
export const STOP_HOLD_MS = 10 * 60_000;

/** How many threads' folders are committed and pushed at a time. */
const KEEP_CONCURRENCY = 4;

export interface StopRequest {
  readonly checkouts: ReadonlyArray<HostStopCheckout>;
  readonly force?: boolean | undefined;
  readonly remote?: string | undefined;
}

/** A host's readiness to stop, as it serves `host.stop.*`. */
export interface HostStop {
  readonly prepare: (request: StopRequest) => Effect.Effect<HostStopPrepared, HostFailed>;
  readonly cancel: Effect.Effect<void>;
  /** Whether new work is refused now because the host was readied to stop. */
  readonly stopping: () => boolean;
}

export interface StopDeps {
  readonly proc: ProcShape;
  /** What runs on the host now, as its update reads it. */
  readonly busy: Effect.Effect<HostBusy>;
  /**
   * The host's gate for new work: what was let in and hasn't answered, and an update's hold. The
   * commits and pushes run as work let in, so an update doesn't restart the host under them.
   */
  readonly admission: Pick<Admission, "inflight" | "closed" | "admit">;
  /**
   * Lets a folder through as the place it really is, or says why not: a joined machine's folder
   * gate. Without one (this machine's own host) a folder is taken as written.
   */
  readonly admit?: (
    cwd: string,
  ) => Effect.Effect<{ readonly path: string }, { readonly message: string }>;
  /** The transports a push may use; `wip.ts`'s when left out. */
  readonly protocols?: string;
  readonly now?: () => number;
  readonly holdMs?: number;
}

const isBusy = (busy: HostBusy) => busy.turns + busy.terminals + busy.clones + busy.checks > 0;

const note = (message: string) => redactUrlCredentials(message).slice(0, 1024);

/** A folder that isn't kept, and why. */
class NotKept {
  readonly why: string;
  constructor(why: string) {
    this.why = why;
  }
}

export const stopOn = (deps: StopDeps): HostStop => {
  const now = deps.now ?? Date.now;
  const holdMs = deps.holdMs ?? STOP_HOLD_MS;
  /** Until when new work is refused; undefined while the host isn't readied to stop. */
  let heldUntil: number | undefined;
  /** Counts cancels, so a prepare under way knows its hold was taken back. */
  let cancels = 0;
  /** One prepare at a time: a second one waits for the first one's pushes. */
  const lock = Semaphore.makeUnsafe(1);

  const stopping = () => {
    if (heldUntil !== undefined && now() >= heldUntil) heldUntil = undefined;
    return heldUntil !== undefined;
  };

  /**
   * Where git runs for `cwd`: the folder as the gate resolved it, whose repository's working tree
   * (which is what gets committed, and can be a folder above it) passes the gate too.
   */
  const placeOf = (cwd: string) =>
    Effect.gen(function* () {
      const admit = (path: string) =>
        deps.admit === undefined
          ? Effect.succeed(path)
          : deps.admit(path).pipe(
              Effect.map((admitted) => admitted.path),
              Effect.mapError((error) => new NotKept(error.message)),
            );
      const path = yield* admit(cwd);
      const roots = yield* tryRepoRoots(path).pipe(
        Effect.mapError((error) => new NotKept(error.message)),
      );
      if (roots === undefined)
        return yield* Effect.fail(new NotKept(`${path} is not a git repository`));
      if (!samePath(roots.top, path)) {
        const top = yield* admit(roots.top);
        if (!samePath(top, roots.top))
          return yield* Effect.fail(new NotKept(`${roots.top} isn't a folder of its own.`));
      }
      return roots;
    });

  /** One thread's folders, one after another: its ref in a repository is written once. */
  const keepThread = (
    checkouts: ReadonlyArray<HostStopCheckout>,
    remote: string,
  ): Effect.Effect<ReadonlyArray<HostStopKept>> =>
    Effect.gen(function* () {
      const kept: Array<HostStopKept> = [];
      /** The repositories this thread's ref was written in, by their shared git folder. */
      const written = new Set<string>();
      for (const checkout of checkouts) {
        const base = { threadId: checkout.threadId, cwd: checkout.cwd };
        const one: HostStopKept = yield* Effect.gen(function* () {
          const roots = yield* placeOf(checkout.cwd);
          if (written.has(roots.common))
            return yield* Effect.fail(
              new NotKept(
                "Another folder of this thread is a worktree of the same repository, and one is kept per repository.",
              ),
            );
          written.add(roots.common);
          const snapshot = yield* snapshotWip(roots.top, checkout.threadId).pipe(
            Effect.mapError((error) => new NotKept(error.message)),
          );
          const local = { ...base, ref: snapshot.ref, commit: snapshot.commit };
          return yield* pushWip(roots.top, snapshot, remote, deps.protocols).pipe(
            Effect.match({
              onFailure: (error): HostStopKept => ({
                ...local,
                pushed: false,
                note: note(error.message),
              }),
              onSuccess: (): HostStopKept => ({ ...local, pushed: true }),
            }),
          );
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed<HostStopKept>({ ...base, pushed: false, note: note(error.why) }),
          ),
          // Never a defect: one from a handler breaks the whole connection, not just this call.
          Effect.catchCause(() =>
            Effect.succeed<HostStopKept>({
              ...base,
              pushed: false,
              note: "Its work in progress couldn't be kept.",
            }),
          ),
        );
        kept.push(one);
      }
      return kept;
    }).pipe(Effect.provideService(Proc, deps.proc));

  const prepare = (request: StopRequest): Effect.Effect<HostStopPrepared, HostFailed> =>
    Effect.gen(function* () {
      const remote = request.remote ?? "origin";
      if (!isPushRemote(remote))
        return yield* new HostFailed({ message: "That isn't a remote to push to." });
      const force = request.force === true;
      const was = stopping() ? heldUntil : undefined;
      const cancelled = cancels;
      // Closed before the look at what runs, so nothing starts between that look and the stop.
      heldUntil = now() + holdMs;
      const busy = yield* deps.busy;
      const updating = deps.admission.closed();
      const inflight = deps.admission.inflight();
      const idle = !isBusy(busy) && inflight === 0 && !updating;
      if (!idle && !force) {
        // As it was, unless a cancel came meanwhile.
        if (cancels === cancelled) heldUntil = was;
        return {
          idle,
          busy,
          kept: [],
          ...(updating
            ? { note: "It is updating Gram." }
            : !isBusy(busy)
              ? { note: "It is starting work." }
              : {}),
        };
      }
      // Each folder once, a thread's folders together.
      const byThread = new Map<string, Array<HostStopCheckout>>();
      for (const checkout of request.checkouts) {
        const list = byThread.get(checkout.threadId) ?? [];
        if (!list.some((known) => known.cwd === checkout.cwd)) list.push(checkout);
        byThread.set(checkout.threadId, list);
      }
      const keeping = Effect.forEach([...byThread.values()], (list) => keepThread(list, remote), {
        concurrency: KEEP_CONCURRENCY,
      }).pipe(Effect.map((lists) => lists.flat()));
      // As work let in, so an update waits for it; under an update's hold only a forced stop
      // reaches here, and goes on regardless.
      const kept = yield* deps.admission
        .admit(keeping, () => "closed" as const)
        .pipe(Effect.catch(() => keeping));
      if (cancels !== cancelled)
        return { idle: false, busy, kept, note: "The stop was taken back meanwhile." };
      // The hold runs from the answer: the pushes may have taken most of one.
      heldUntil = now() + holdMs;
      return { idle, busy, kept };
    });

  return {
    prepare: (request) => lock.withPermits(1)(prepare(request)),
    cancel: Effect.sync(() => {
      cancels += 1;
      heldUntil = undefined;
    }),
    stopping,
  };
};
