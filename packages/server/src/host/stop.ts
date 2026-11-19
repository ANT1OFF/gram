// A host readied to be stopped with its disk kept (`host.stop.prepare`): it stops taking new work,
// says whether anything still runs on it, and keeps each thread's work in progress off the machine
// under a hidden ref per folder (`@gram/git`'s `wip.ts`), so every checkout of a thread is kept,
// two of one repository included. Whoever runs the machine then stops it; a host
// started later on the same disk finds the folders, branches and agent transcripts as they were.
//
// A host started on another disk has none of that. Asked to (`host.stop.restore`), it clones the
// repository again, fetches the thread's hidden ref and makes the thread's folder as it was; a
// thread no ref was kept of, because its branch at the remote held everything, gets its folder
// from that branch. A folder kept before each had its own ref comes back from the thread's one ref
// then, held to the commit the stop said it kept. A later stop that finds the branch at the remote
// holds everything deletes the folder's ref, when what the ref names is this folder's own or is in
// that branch. `host.stop.drop` deletes it whatever it names, for a thread that is gone for good.
//
// A host about to be taken away (a provisioned host sent SIGTERM, as a node drain or a reclaimed
// spot node sends it) says so to whoever listens (`host.stop.going`, `goAway`) and holds its exit
// while one does, so the control plane readies it to stop as above and its threads' work is kept,
// remembered there as any stop's is, before the process ends.

import {
  type HostBusy,
  HostFailed,
  type HostStopCheckout,
  type HostStopKept,
  type HostStopPrepared,
  type HostStopRestored,
  SAVED_DIFF_BYTES,
  type SavedDiff,
  type ThreadId,
} from "@gram/contracts";
import {
  dropWip,
  fetchBranchTip,
  fetchWip,
  git,
  hasWip,
  isInside,
  isPushRemote,
  isWipRefOf,
  Proc,
  type ProcShape,
  pushWip,
  restoreWip,
  restoreWipWorktree,
  samePath,
  tryRealPathSync,
  snapshotWip,
  tryRepoRoots,
  wipCaughtUp,
  wipChanges,
  wipRef,
} from "@gram/git";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { Admission } from "./admission.ts";
import { HOST_DROP_MS, HOST_RESTORE_MS, HOST_STEP_MARGIN_MS, HOST_STOP_MS } from "./budgets.ts";
import { redactUrlCredentials } from "./remote-url.ts";
import { toDiffFile } from "../git/mapping.ts";

/** A snapshot commits untracked files, so none of its files is untracked. */
const NO_UNTRACKED: ReadonlySet<string> = new Set();

/** What `snapshot` holds against its branch's base, as `HostStopKept.saved`; undefined unread. */
const savedOf = (
  top: string,
  snapshot: { readonly commit: string; readonly uncommitted: boolean },
): Effect.Effect<SavedDiff | undefined, never, Proc> =>
  wipChanges(top, snapshot, SAVED_DIFF_BYTES).pipe(
    Effect.map((changes): SavedDiff => ({
      ...(changes.base === undefined ? {} : { base: changes.base.slice(0, 1024) }),
      files: changes.files.slice(0, 5000).map((file) => toDiffFile(file, NO_UNTRACKED)),
      uncommitted: snapshot.uncommitted,
      ...(changes.note === undefined ? {} : { note: changes.note.slice(0, 1024) }),
    })),
    Effect.orElseSucceed(() => undefined),
    Effect.catchDefect(() => Effect.succeed(undefined)),
  );

/** Why new work is refused while the host is readied to stop. */
export const STOPPING = "This machine is about to stop. Try again once it is back.";

/**
 * A restore's note for a folder that is there already and is left as it is. A resume reads it from a
 * host built before `HostStopRestored.there`.
 */
export const FOLDER_THERE = "Its folder is there already.";

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
  /** The commit the stop said it kept: the ref must name it, or nothing is put back. */
  readonly commit?: string | undefined;
  /** The stop kept no ref, the branch at the remote holding everything: made from the branch. */
  readonly caughtUp?: boolean | undefined;
  /** Another machine's ref of the thread, read in place of this host's own (`isWipRefOf`). */
  readonly ref?: string | undefined;
  /** A resume before set out to put it back and didn't finish: one there is checked first. */
  readonly pending?: boolean | undefined;
}

export interface KeepRequest {
  readonly checkouts: ReadonlyArray<HostStopCheckout>;
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
  /** Keeps the folders' work in progress now, while the host works on (`host.stop.keep`). */
  readonly keep: (request: KeepRequest) => Effect.Effect<HostStopKept[], HostFailed>;
  /** Makes a thread's folder again from what a stop kept of it; absent where nothing clones. */
  readonly restore?: (request: RestoreRequest) => Effect.Effect<HostStopRestored, HostFailed>;
  /** Deletes the kept work of a thread gone for good, when the repository at its folder has any. */
  readonly drop: (request: DropRequest) => Effect.Effect<{ readonly dropped: boolean }, HostFailed>;
  /** Whether new work is refused now because the host was readied to stop. */
  readonly stopping: () => boolean;
  /**
   * Says once, when `goAway` is called, that the host is about to be taken away
   * (`host.stop.going`). Each listener counts while it listens: `goAway` waits for them.
   */
  readonly going: Stream.Stream<HostGoing>;
  /**
   * The host is about to be taken away: says so to every listener of `going`, and waits until none
   * listens any more (each readied it to stop and let go, or its connection closed) or `withinMs`
   * pass. Answers at once when none listens.
   */
  readonly goAway: (withinMs: number) => Effect.Effect<GoneAway>;
}

/** What `host.stop.going` says: how long the host waits for its listeners. */
export interface HostGoing {
  readonly withinMs: number;
}

/**
 * How a `goAway` ended: `stopped` when its listeners let go after a stop was readied, `unheard`
 * when none listened or they let go with no stop, `late` when `withinMs` ran out first.
 */
export type GoneAway = "stopped" | "unheard" | "late";

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

/**
 * A step held to its own budget on the host, inside the lock: a minute less than Gram's deadline
 * for the call (`budgets.ts`). Each git command has its own time limit, but a step runs many,
 * one folder after another; past its budget it is stopped (its commands with it) and the lock
 * goes to the next, so one slow step never holds the machine's others behind it unseen.
 */
const within =
  (callMs: number, what: string) =>
  <A>(effect: Effect.Effect<A, HostFailed>): Effect.Effect<A, HostFailed> =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: callMs - HOST_STEP_MARGIN_MS,
        orElse: () =>
          Effect.fail(
            refused(
              `${what} took longer than ${Math.round((callMs - HOST_STEP_MARGIN_MS) / 60_000)} minutes on this machine, so it was stopped.`,
            ),
          ),
      }),
    );

/** A folder that isn't kept, and why. */
class NotKept {
  readonly why: string;
  constructor(why: string) {
    this.why = why;
  }
}

/** Whether the repository at `cwd` is a worktree of `clone`: their common git folder is one. */
const worktreeOf = (clone: string, cwd: string) =>
  git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).pipe(
    Effect.map((out) => {
      if (out.status !== 0) return false;
      const common = tryRealPathSync(out.stdout.trim());
      return common !== undefined && common === tryRealPathSync(join(clone, ".git"));
    }),
    Effect.orElseSucceed(() => false),
  );

export const stopOn = (deps: StopDeps): HostStop => {
  const now = deps.now ?? Date.now;
  const holdMs = deps.holdMs ?? STOP_HOLD_MS;
  /** Until when new work is refused; undefined while the host isn't readied to stop. */
  let heldUntil: number | undefined;
  /** Counts cancels, so a prepare under way knows its hold was taken back. */
  let cancels = 0;
  /** One prepare at a time: a second one waits for the first one's pushes. */
  const lock = Semaphore.makeUnsafe(1);
  /** Said once by `goAway`: the host is about to be taken away. */
  const announced = Deferred.makeUnsafe<HostGoing>();
  let goingSaid = false;
  /** Listeners of `going` now. */
  let listeners = 0;
  /** Done once, after `goAway`, when no listener is left. */
  const unheard = Deferred.makeUnsafe<void>();
  /** A prepare ended after `goAway`: the stop was readied as it went. */
  let readiedAfterGoing = false;

  const stopping = () => {
    if (heldUntil !== undefined && now() >= heldUntil) heldUntil = undefined;
    return heldUntil !== undefined;
  };

  /**
   * Where git runs for `cwd`: the folder as the gate resolved it, whose repository's working tree
   * (which is what gets committed, and can be a folder above it) passes the gate too.
   */
  /** The folder as the gate resolved it, or why it isn't let through. */
  const gate = (cwd: string) =>
    deps.admit === undefined
      ? Effect.succeed(cwd)
      : deps.admit(cwd).pipe(
          Effect.map((admitted) => admitted.path),
          Effect.mapError((error) => new NotKept(error.message)),
        );

  const placeOf = (cwd: string) =>
    Effect.gen(function* () {
      const path = yield* gate(cwd);
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

  /**
   * One thread's folders, one after another, each under its own ref (`wipRef` of the folder as
   * Gram names it): two worktrees of one repository share its refs, and each writes only its own.
   */
  const keepThread = (
    checkouts: ReadonlyArray<HostStopCheckout>,
    remote: string,
  ): Effect.Effect<ReadonlyArray<HostStopKept>> =>
    Effect.gen(function* () {
      const kept: Array<HostStopKept> = [];
      for (const checkout of checkouts) {
        const base = { threadId: checkout.threadId, cwd: checkout.cwd };
        const one: HostStopKept = yield* Effect.gen(function* () {
          const roots = yield* placeOf(checkout.cwd);
          const snapshot = yield* snapshotWip(roots.top, checkout.threadId, checkout.cwd).pipe(
            Effect.mapError((error) => new NotKept(error.message)),
          );
          const on = yield* git(roots.top, ["symbolic-ref", "--quiet", "--short", "HEAD"]).pipe(
            Effect.map((out) => (out.status === 0 ? out.stdout.trim() : "")),
            Effect.orElseSucceed(() => ""),
          );
          const branch = on === "" || on.length > 1024 ? {} : { branch: on };
          // What the save holds, for a card to show while the machine is away; never in its way.
          const saved = yield* savedOf(roots.top, snapshot);
          const local = {
            ...base,
            ref: snapshot.ref,
            commit: snapshot.commit,
            ...branch,
            ...(saved === undefined ? {} : { saved }),
          };
          // The branch at the remote holds all of it: nothing more to keep. A ref this folder
          // left at an earlier stop is out of date, so it goes; one that names anything else was
          // written since by another machine, and stays. Unsure: pushed as ever.
          const caughtUp = yield* wipCaughtUp(roots.top, snapshot, remote, deps.protocols).pipe(
            Effect.orElseSucceed(() => false),
          );
          if (caughtUp) {
            const dropped = yield* dropWip(
              roots.top,
              checkout.threadId,
              remote,
              deps.protocols,
              {
                by: snapshot.commit,
                also: snapshot.previous === undefined ? [] : [snapshot.previous],
              },
              checkout.cwd,
            ).pipe(Effect.orElseSucceed(() => "failed" as const));
            return {
              ...base,
              commit: snapshot.commit,
              ...branch,
              ...(saved === undefined ? {} : { saved }),
              pushed: true,
              caughtUp: true,
              ...(dropped === "left"
                ? {
                    note: "The folder's ref at the remote holds other work of the thread and was left there.",
                  }
                : dropped === "failed"
                  ? { note: "A ref kept at an earlier stop couldn't be deleted at the remote." }
                  : {}),
            };
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
      const expected = request.commit;
      if (expected !== undefined && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expected))
        return yield* refused("That isn't a commit a stop kept.");
      // Another machine's ref, as for a thread that moved here: of this thread, at the commit
      // named, and nothing else in its place.
      const from = request.ref;
      if (from !== undefined && (expected === undefined || !isWipRefOf(from, request.threadId)))
        return yield* refused("That isn't a ref of this thread to put back.");
      const { path: clone } = yield* ensure(request.url).pipe(
        Effect.mapError((error) => refused(error.message)),
      );
      // The clone itself was the thread's folder, and is there again; any other folder that is
      // there is somebody's, and is left alone. Unless a resume before set out to put it back
      // (`pending`) and may have stopped part way: an empty one is made again, a worktree of the
      // clone gets the kept work put into it, and anything else is refused, never taken as back.
      let into = samePath(clone, cwd) ? cwd : undefined;
      if (existsSync(cwd) && into === undefined) {
        if (request.pending !== true) return { restored: false, there: true, note: FOLDER_THERE };
        if (readdirSync(cwd).length === 0) rmSync(cwd, { recursive: true, force: true });
        else if (yield* worktreeOf(clone, cwd)) into = cwd;
        else
          return yield* refused(
            "A resume before set out to put this folder back, and what is there now isn't a worktree of its repository.",
          );
      }
      const inClone = into !== undefined && existsSync(into);
      // The folder's own ref, held to the commit the stop said it kept; no ref was kept of a
      // thread whose branch at the remote held everything, which gets its folder from that branch.
      // A folder kept before each had its own ref is under the thread's one ref then, read only
      // held to the commit kept of this folder: unheld, it may be another folder's work.
      const fetch = (ref?: string) =>
        fetchWip(
          clone,
          request.threadId,
          remote,
          deps.protocols,
          expected,
          ref,
          ref === undefined ? cwd : undefined,
        ).pipe(Effect.mapError((error) => refused(error.message)));
      const ref =
        request.caughtUp === true
          ? undefined
          : ((yield* fetch(from)) ??
            (from === undefined && expected !== undefined
              ? yield* fetch(wipRef(request.threadId))
              : undefined));
      const kept =
        ref ??
        (request.branch === undefined || from !== undefined
          ? undefined
          : yield* fetchBranchTip(clone, request.branch, remote, deps.protocols).pipe(
              Effect.mapError((error) => refused(error.message)),
            ));
      if (kept === undefined)
        return { restored: false, note: "Nothing was kept of it at the remote." };
      // A ref fetched and then not put back isn't this repository's own work: forgotten here, so
      // a later stop doesn't take it for a snapshot of its own (the remote's stays).
      const forget =
        ref === undefined
          ? Effect.void
          : git(clone, ["update-ref", "--no-deref", "-d", ref.ref]).pipe(Effect.ignore);
      // Only into a folder the machine's sessions may open, as the stop kept only those: asked
      // of the gate before anything is written there. The gate reads a folder that is there, so
      // a missing one is made empty for it, and removed again when it is refused.
      let made: string | undefined;
      const unmake = Effect.sync(() => {
        if (made !== undefined) rmSync(made, { recursive: true, force: true });
      });
      const put = Effect.gen(function* () {
        if (inClone) {
          yield* placeOf(cwd).pipe(Effect.mapError((error) => refused(error.why)));
          // A worktree a restore before made and didn't finish: the clone gives up the branch
          // when it is on it with nothing of its own, as for a worktree made now.
          return yield* restoreWip(into ?? clone, kept, request.branch, { release: clone }).pipe(
            Effect.mapError((error) => refused(error.message)),
          );
        }
        yield* Effect.try({
          try: () => {
            // The first folder it had to make, parents included: what a refusal removes.
            made = mkdirSync(cwd, { recursive: true });
          },
          catch: () => refused("Its folder couldn't be made."),
        });
        const path = yield* gate(cwd).pipe(Effect.mapError((error) => refused(error.why)));
        if (deps.admit !== undefined && isInside(path, deps.home ?? homedir()))
          return yield* refused(`${path} holds this machine's home folder, so it isn't restored.`);
        const done = yield* restoreWipWorktree(clone, cwd, kept, request.branch).pipe(
          Effect.mapError((error) => refused(error.message)),
        );
        // And as the repository it now is: its working tree is the folder let through.
        yield* placeOf(cwd).pipe(
          Effect.mapError((error) => refused(error.why)),
          Effect.tapError(() =>
            git(clone, ["worktree", "remove", "--force", cwd]).pipe(
              Effect.ignore,
              Effect.andThen(Effect.sync(() => rmSync(cwd, { recursive: true, force: true }))),
              Effect.andThen(git(clone, ["worktree", "prune"]).pipe(Effect.ignore)),
            ),
          ),
        );
        return done;
      });
      const { ahead } = yield* put.pipe(Effect.onError(() => Effect.andThen(unmake, forget)));
      const count = (range: string) =>
        git(clone, ["rev-list", "--count", range, "--"]).pipe(
          Effect.map((out) => out.status === 0 && Number(out.stdout.trim()) > 0),
          Effect.orElseSucceed(() => false),
        );
      let said: string | undefined;
      if (ahead)
        said =
          "The branch was on this disk with commits made after this work was kept, and is as it was.";
      else if (ref === undefined) {
        // From the branch: said when it isn't what the stop found there.
        if (expected !== undefined && kept.commit !== expected)
          said =
            request.caughtUp === true
              ? "The branch at the remote has moved since the stop."
              : "The ref the stop wrote is gone from the remote; the folder is the remote's branch.";
      } else if (
        // Kept at a stop, and the branch pushed further since: said, so nobody takes it for new.
        request.branch !== undefined &&
        kept.head !== undefined &&
        (yield* count(`${kept.head}..refs/remotes/origin/${request.branch}`))
      )
        said = "The branch at the remote has commits made after this work was kept.";
      return {
        restored: true,
        commit: kept.commit,
        uncommitted: kept.uncommitted,
        source: ref === undefined ? ("branch" as const) : ("ref" as const),
        ...(said === undefined ? {} : { note: said }),
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
      // Read here first: a repository that never kept anything asks nothing of a remote. The
      // folder's own ref, and the thread's one ref from before each folder had its own.
      let dropped = false;
      for (const folder of [request.cwd, undefined]) {
        const has = yield* hasWip(roots.top, request.threadId, folder).pipe(
          Effect.orElseSucceed(() => false),
        );
        if (!has) continue;
        yield* dropWip(roots.top, request.threadId, remote, deps.protocols, undefined, folder).pipe(
          Effect.mapError((error) => refused(error.message)),
        );
        dropped = true;
      }
      return { dropped };
    }).pipe(
      Effect.provideService(Proc, deps.proc),
      Effect.catchDefect(() => Effect.fail(refused("Its kept work couldn't be deleted."))),
    );

  /**
   * Keeps the folders' work in progress now, while the host goes on working: what a stop keeps,
   * with no hold and no look at what runs. A host readied to stop keeps nothing more here: the
   * stop has kept it, or is keeping it.
   */
  const keep = (request: KeepRequest): Effect.Effect<HostStopKept[], HostFailed> =>
    Effect.gen(function* () {
      const remote = request.remote ?? "origin";
      if (!isPushRemote(remote)) return yield* refused("That isn't a remote to push to.");
      // Said per folder, so the asker doesn't read the silence as a keep that went missing.
      if (stopping())
        return request.checkouts.map((checkout): HostStopKept => ({
          threadId: checkout.threadId,
          cwd: checkout.cwd,
          pushed: false,
          note: "The machine is readied to stop, and the stop keeps its work.",
        }));
      const byThread = new Map<string, Array<HostStopCheckout>>();
      for (const checkout of request.checkouts) {
        const list = byThread.get(checkout.threadId) ?? [];
        if (!list.some((known) => known.cwd === checkout.cwd)) list.push(checkout);
        byThread.set(checkout.threadId, list);
      }
      const lists = yield* Effect.forEach(
        [...byThread.values()],
        (list) => keepThread(list, remote),
        { concurrency: KEEP_CONCURRENCY },
      );
      return lists.flat();
    });

  const going: Stream.Stream<HostGoing> = Stream.suspend(() => {
    listeners += 1;
    return Stream.concat(Stream.fromEffect(Deferred.await(announced)), Stream.never).pipe(
      Stream.ensuring(
        Effect.sync(() => {
          listeners -= 1;
          if (goingSaid && listeners === 0) Deferred.doneUnsafe(unheard, Exit.void);
        }),
      ),
    );
  });

  const goAway = (withinMs: number): Effect.Effect<GoneAway> =>
    Effect.suspend(() => {
      goingSaid = true;
      Deferred.doneUnsafe(announced, Exit.succeed({ withinMs }));
      if (listeners === 0) Deferred.doneUnsafe(unheard, Exit.void);
      return Deferred.await(unheard).pipe(
        Effect.map((): GoneAway => (readiedAfterGoing ? "stopped" : "unheard")),
        Effect.timeoutOrElse({
          duration: withinMs,
          orElse: () => Effect.succeed<GoneAway>("late"),
        }),
      );
    });

  const ensure = deps.ensure;
  return {
    going,
    goAway,
    keep: (request) =>
      lock.withPermits(1)(within(HOST_STOP_MS, "Keeping the work")(asWork(keep(request)))),
    ...(ensure === undefined
      ? {}
      : {
          restore: (request: RestoreRequest) =>
            lock.withPermits(1)(
              within(HOST_RESTORE_MS, "Putting the folder back")(asWork(restore(ensure, request))),
            ),
        }),
    drop: (request) =>
      lock.withPermits(1)(within(HOST_DROP_MS, "Deleting the kept work")(asWork(drop(request)))),
    prepare: (request) =>
      lock
        .withPermits(1)(within(HOST_STOP_MS, "Readying the machine to stop")(prepare(request)))
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (goingSaid) readiedAfterGoing = true;
            }),
          ),
        ),
    cancel: Effect.sync(() => {
      cancels += 1;
      heldUntil = undefined;
    }),
    stopping,
  };
};
