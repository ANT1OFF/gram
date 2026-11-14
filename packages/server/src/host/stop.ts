// A host readied to be stopped with its disk kept (`host.stop.prepare`): it stops taking new work,
// says whether anything still runs on it, and keeps each thread's work in progress off the machine
// under a hidden ref (`@gram/git`'s `wip.ts`). Whoever runs the machine then stops it; a host
// started later on the same disk finds the folders, branches and agent transcripts as they were.
//
// A host started on another disk has none of that. Asked to (`host.stop.restore`), it clones the
// repository again, fetches the thread's hidden ref and makes the thread's folder as it was. The
// ref is deleted when a later stop finds the branch at the remote holds everything, and when the
// thread is closed (`host.stop.drop`).

import {
  type HostBusy,
  HostFailed,
  type HostStopCheckout,
  type HostStopKept,
  type HostStopPrepared,
  type HostStopRestored,
  type ThreadId,
} from "@gram/contracts";
import {
  dropWip,
  fetchWip,
  git,
  hasWip,
  isInside,
  isPushRemote,
  Proc,
  type ProcShape,
  pushWip,
  restoreWip,
  restoreWipWorktree,
  samePath,
  snapshotWip,
  tryRepoRoots,
  wipCaughtUp,
} from "@gram/git";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
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

export interface RestoreRequest {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly url: string;
  readonly branch?: string | undefined;
  readonly remote?: string | undefined;
}

export interface DropRequest {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly remote?: string | undefined;
}

/** A host's readiness to stop, as it serves `host.stop.*`. */
export interface HostStop {
  readonly prepare: (request: StopRequest) => Effect.Effect<HostStopPrepared, HostFailed>;
  readonly cancel: Effect.Effect<void>;
  /** Makes a thread's folder again from what a stop kept of it; absent where nothing clones. */
  readonly restore?: (request: RestoreRequest) => Effect.Effect<HostStopRestored, HostFailed>;
  /** Deletes a closed thread's kept work, when the repository at its folder has any. */
  readonly drop: (request: DropRequest) => Effect.Effect<{ readonly dropped: boolean }, HostFailed>;
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
  /**
   * The host's own clone of a repository, made when it has none (`repos.ts`): where a thread's
   * folder is made again from. Without it nothing is restored.
   */
  readonly ensure?: (
    url: string,
  ) => Effect.Effect<{ readonly path: string }, { readonly message: string }>;
  /** The machine's home folder, for tests; the user's own otherwise. */
  readonly home?: string;
  readonly now?: () => number;
  readonly holdMs?: number;
}

const isBusy = (busy: HostBusy) => busy.turns + busy.terminals + busy.clones + busy.checks > 0;

const note = (message: string) => redactUrlCredentials(message).slice(0, 1024);

const refused = (message: string) => new HostFailed({ message: note(message) });

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
      // Git commits the repository's whole working tree. Where a gate guards folders, only a
      // working tree that is the folder let through is kept: one rooted above it (a repository
      // of the home folder, say, or `core.worktree` pointed elsewhere) holds what the gate never
      // looked at. Nor one that holds the home folder, whichever folder was named.
      if (deps.admit !== undefined && !samePath(roots.top, path))
        return yield* Effect.fail(
          new NotKept(`${path} is inside a repository rooted at ${roots.top}, so it isn't kept.`),
        );
      if (deps.admit !== undefined && isInside(roots.top, deps.home ?? homedir()))
        return yield* Effect.fail(
          new NotKept(`${roots.top} holds this machine's home folder, so it isn't kept.`),
        );
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
          const snapshot = yield* snapshotWip(roots.top, checkout.threadId).pipe(
            Effect.mapError((error) => new NotKept(error.message)),
          );
          written.add(roots.common);
          const local = { ...base, ref: snapshot.ref, commit: snapshot.commit };
          // The branch at the remote holds all of it: nothing more to keep, and a ref kept at an
          // earlier stop is out of date, so it goes. Unsure, or not deleted: pushed as ever.
          const caughtUp = yield* wipCaughtUp(roots.top, snapshot, remote, deps.protocols).pipe(
            Effect.orElseSucceed(() => false),
          );
          if (caughtUp) {
            const dropped = yield* dropWip(
              roots.top,
              checkout.threadId,
              remote,
              deps.protocols,
            ).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
            if (dropped) return { ...base, commit: snapshot.commit, pushed: true, caughtUp: true };
          }
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
        return {
          idle: false,
          busy,
          kept,
          released: true,
          note: "The stop was taken back meanwhile.",
        };
      // The hold ran out under the pushes: work may have been let in since the look.
      if (!stopping())
        return {
          idle: false,
          busy,
          kept,
          released: true,
          note: "Keeping its work took too long; ask again.",
        };
      // The hold runs from the answer: the pushes may have taken most of one.
      heldUntil = now() + holdMs;
      return { idle, busy, kept };
    });

  /** As work let in, so an update doesn't restart the host under it. */
  const asWork = <A>(effect: Effect.Effect<A, HostFailed>) =>
    deps.admission.admit(effect, () => refused("It is updating Gram."));

  const restore = (
    ensure: NonNullable<StopDeps["ensure"]>,
    request: RestoreRequest,
  ): Effect.Effect<HostStopRestored, HostFailed> =>
    Effect.gen(function* () {
      const remote = request.remote ?? "origin";
      if (!isPushRemote(remote)) return yield* refused("That isn't a remote to fetch from.");
      const cwd = request.cwd;
      if (!isAbsolute(cwd) || cwd.startsWith("-") || /\0/.test(cwd))
        return yield* refused("That isn't a folder to restore.");
      const { path: clone } = yield* ensure(request.url).pipe(
        Effect.mapError((error) => refused(error.message)),
      );
      // The clone itself was the thread's folder, and is there again; any other folder that is
      // there is somebody's, and is left alone.
      const inClone = existsSync(cwd);
      if (inClone && !samePath(clone, cwd))
        return { restored: false, note: "Its folder is there already." };
      const kept = yield* fetchWip(clone, request.threadId, remote, deps.protocols).pipe(
        Effect.mapError((error) => refused(error.message)),
      );
      if (kept === undefined)
        return { restored: false, note: "Nothing was kept of it at the remote." };
      // Only into a folder the machine's sessions may open, as the stop kept only those.
      const admitted = placeOf(cwd).pipe(Effect.mapError((error) => refused(error.why)));
      if (inClone) {
        yield* admitted;
        yield* restoreWip(clone, kept, request.branch).pipe(
          Effect.mapError((error) => refused(error.message)),
        );
      } else {
        yield* restoreWipWorktree(clone, cwd, kept, request.branch).pipe(
          Effect.mapError((error) => refused(error.message)),
        );
        yield* admitted.pipe(
          Effect.tapError(() =>
            git(clone, ["worktree", "remove", "--force", cwd]).pipe(
              Effect.ignore,
              Effect.andThen(Effect.sync(() => rmSync(cwd, { recursive: true, force: true }))),
              Effect.andThen(git(clone, ["worktree", "prune"]).pipe(Effect.ignore)),
            ),
          ),
        );
      }
      // Kept at a stop, and the branch pushed further since: said, so nobody takes it for new.
      const moved =
        request.branch === undefined || kept.head === undefined
          ? false
          : yield* git(clone, [
              "rev-list",
              "--count",
              `${kept.head}..refs/remotes/origin/${request.branch}`,
              "--",
            ]).pipe(
              Effect.map((out) => out.status === 0 && Number(out.stdout.trim()) > 0),
              Effect.orElseSucceed(() => false),
            );
      return {
        restored: true,
        commit: kept.commit,
        uncommitted: kept.uncommitted,
        ...(moved
          ? { note: "The branch at the remote has commits made after this work was kept." }
          : {}),
      };
    }).pipe(
      Effect.provideService(Proc, deps.proc),
      // Never a defect: one from a handler breaks the whole connection, not just this call.
      Effect.catchDefect(() => Effect.fail(refused("Its work in progress couldn't be put back."))),
    );

  const drop = (request: DropRequest): Effect.Effect<{ readonly dropped: boolean }, HostFailed> =>
    Effect.gen(function* () {
      const remote = request.remote ?? "origin";
      if (!isPushRemote(remote)) return yield* refused("That isn't a remote to push to.");
      const roots = yield* placeOf(request.cwd).pipe(
        Effect.mapError((error) => refused(error.why)),
      );
      // Read here first: a repository that never kept anything asks nothing of a remote.
      const has = yield* hasWip(roots.top, request.threadId).pipe(
        Effect.orElseSucceed(() => false),
      );
      if (!has) return { dropped: false };
      yield* dropWip(roots.top, request.threadId, remote, deps.protocols).pipe(
        Effect.mapError((error) => refused(error.message)),
      );
      return { dropped: true };
    }).pipe(
      Effect.provideService(Proc, deps.proc),
      Effect.catchDefect(() => Effect.fail(refused("Its kept work couldn't be deleted."))),
    );

  const ensure = deps.ensure;
  return {
    ...(ensure === undefined
      ? {}
      : {
          restore: (request: RestoreRequest) =>
            lock.withPermits(1)(asWork(restore(ensure, request))),
        }),
    drop: (request) => lock.withPermits(1)(asWork(drop(request))),
    prepare: (request) => lock.withPermits(1)(prepare(request)),
    cancel: Effect.sync(() => {
      cancels += 1;
      heldUntil = undefined;
    }),
    stopping,
  };
};
