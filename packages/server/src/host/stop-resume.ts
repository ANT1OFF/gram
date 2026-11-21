// Stopping a joined machine with its disk kept, and resuming its threads on a host started on that
// disk later: the hosted features' way of paying for a machine only while it works. Whoever runs
// the machines asks here before stopping one (`prepareStop`), stops it, and starts a host on its
// disk again when it is wanted (`stopStatus` says when); that host dials in as the same machine,
// since its key is on the disk, and `resumeHost` opens the threads' sessions on it again.
//
// A host that dials in as the machine on another disk has none of the threads' folders. For each
// one missing that Gram made from a clone there, `resumeHost` asks the host to make it again from
// what the stop kept (`host.stop.restore`): a thread's work in progress follows it to a replaced
// machine. A host that can't, or a folder Gram didn't make from a clone, is reported missing.
// The host is held to the commit the stop said it kept, as this Gram remembers it or as the
// resume's caller names it: the hidden ref can be written by whoever can push to the remote.
//
// Nothing here stops or starts a machine: that is the caller's to do.

import {
  type Checkout,
  effectiveCheckout,
  embeddingOn,
  HostFailed,
  type HostBusy,
  type HostId,
  hostOf,
  type HostStopKept,
  HostUnavailable,
  hostServes,
  InvalidState,
  LOCAL_HOST_ID,
  type SavedDiff,
  type Thread,
  type ThreadId,
  ThreadNotFound,
} from "@gram/contracts";
import { isWipRefOf } from "@gram/git";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as FiberSet from "effect/FiberSet";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import type { ThreadStore } from "../persistence/thread-store.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";
import type { RemoteHostsShape } from "./remote-hosts.ts";
import { cloneUrlOf } from "./repos.ts";
import { HOST_RESTORE_MS, REOPEN_MS, SHARED_FLUSH_MS, STOP_CANCEL_MS } from "./budgets.ts";
import type { JobReport } from "./machine-jobs.ts";
import { cutHostText, FOLDER_THERE, KEPT_WORK_GONE_REASON, keptWorkGone } from "./stop.ts";

export interface StopResumeDeps {
  readonly hosts: Pick<RemoteHostsShape, "connection" | "machines" | "stops">;
  readonly store: Pick<ThreadStore["Service"], "listThreads">;
  readonly runtimes: Pick<ThreadRuntimesShape, "restSession" | "startSession"> &
    Partial<Pick<ThreadRuntimesShape, "snapshot">>;
  /** Brings the machine's shared-folder mirrors in step one last time, where there are any. */
  readonly sharedFlush?: (id: HostId) => Effect.Effect<void>;
}

/** Every checkout a thread holds, followed ones included. */
const checkoutsOf = (thread: Thread): ReadonlyArray<Checkout> => [
  thread.checkout,
  ...(thread.currentCheckout === undefined ? [] : [thread.currentCheckout]),
  ...(thread.extraCheckouts ?? []),
];

/**
 * The threads with a folder on the machine, each with its folders there, and whether its session
 * runs there (`placed.ts` opens a thread's session on its effective checkout's machine; an
 * archived thread has none).
 */
const placedOn = (threads: ReadonlyArray<Thread>, id: HostId) =>
  threads.flatMap((thread) => {
    const cwds = [
      ...new Set(
        checkoutsOf(thread)
          .filter((checkout) => hostOf(checkout) === id)
          .map((checkout) => checkout.path),
      ),
    ];
    // A memory update's session runs there with its folder on the control plane: nothing to keep,
    // and a session to rest and resume.
    if (thread.dreamHost === id && !thread.parked) return [{ thread, cwds: [], session: true }];
    return cwds.length === 0
      ? []
      : [
          {
            thread,
            cwds,
            session: !thread.parked && hostOf(effectiveCheckout(thread)) === id,
          },
        ];
  });

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The most folders one stop is asked to keep (`host.stop.prepare`'s limit). */
export const STOP_FOLDERS_MAX = 512;
/** How long a stop waits for the machine's shared folders, inside the embedder's own deadline. */
const SHARED_FLUSH_WITHIN = SHARED_FLUSH_MS;
/** How long a machine gets to say it takes work again. */
const CANCEL_WITHIN = STOP_CANCEL_MS;

/** Why a stop keeps nothing of a folder that a resume couldn't put back. */
const NOT_BACK_KEPT =
  "Its folder wasn't put back at the machine's last resume, so nothing of it was kept over what the remote has.";

/** What a stop kept of one folder, as this Gram vouches for it. */
export interface KeptWork {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly ref?: string;
  readonly commit?: string;
  readonly pushed: boolean;
  /** The branch at the remote already held all of it, so no ref is kept there. */
  readonly caughtUp?: boolean;
  /** The branch the folder was on, when the machine said. */
  readonly branch?: string;
  /** Where it was pushed, when the stop named a remote: where a resume fetches it from. */
  readonly remote?: string;
  readonly note?: string;
}

/** What a resume's caller says a stop kept of a folder: the stop's own answer, given back. */
export type KeptBefore = Pick<KeptWork, "threadId" | "cwd" | "commit" | "caughtUp" | "branch"> & {
  readonly remote?: string | undefined;
};

export interface StopPrepared {
  /** Whether the machine can be stopped now with nothing cut off. */
  readonly idle: boolean;
  readonly busy: HostBusy;
  readonly kept: ReadonlyArray<KeptWork>;
  readonly note?: string;
  /** The threads at work on it that a stop now would cut off, and that go on once it is back. */
  readonly working: ReadonlyArray<ThreadId>;
}

/**
 * What the host said it kept, held to what was asked: only folders this Gram named, under the ref
 * this Gram would have written, with a commit that reads as one. A host's word is otherwise its
 * own: `pushed` is its claim.
 */
const keptOf = (
  asked: ReadonlyArray<{ readonly threadId: ThreadId; readonly cwd: string }>,
  said: ReadonlyArray<HostStopKept>,
  remote?: string,
): ReadonlyArray<KeptWork> =>
  asked.map(({ threadId, cwd }) => {
    const answer = said.find((kept) => kept.threadId === threadId && kept.cwd === cwd);
    if (answer === undefined)
      return { threadId, cwd, pushed: false, note: "The machine didn't say." };
    const commit = answer.commit !== undefined && OID.test(answer.commit);
    const where = {
      ...(answer.branch === undefined || answer.branch === "" ? {} : { branch: answer.branch }),
      ...(remote === undefined ? {} : { remote }),
    };
    // The remote's branch holds it all, the host says: no ref is kept, and none is named.
    if (commit && answer.caughtUp === true && answer.ref === undefined)
      return {
        threadId,
        cwd,
        commit: answer.commit,
        pushed: answer.pushed,
        caughtUp: true,
        ...where,
        ...(answer.note === undefined ? {} : { note: answer.note }),
      };
    const sound = answer.ref !== undefined && isWipRefOf(answer.ref, threadId) && commit;
    return {
      threadId,
      cwd,
      ...(sound ? { ref: answer.ref, commit: answer.commit, ...where } : {}),
      pushed: sound && answer.pushed,
      ...(answer.note === undefined ? {} : { note: answer.note }),
    };
  });

/**
 * Remembers what the machine kept and pushed of each folder (`StopMarks.keep`), with when, and what
 * the save holds as the machine said (`HostStopKept.saved`), so it can be shown while it is away.
 */
const remember = (
  deps: Pick<StopResumeDeps, "hosts">,
  id: HostId,
  kept: ReadonlyArray<KeptWork>,
  said: ReadonlyArray<HostStopKept>,
  at: number,
) => {
  for (const work of kept) {
    if (!work.pushed || work.commit === undefined) continue;
    const saved = said.find(
      (answer) => answer.threadId === work.threadId && answer.cwd === work.cwd,
    )?.saved;
    deps.hosts.stops.keep(id, work.threadId, work.cwd, {
      commit: work.commit,
      caughtUp: work.caughtUp === true,
      at,
      ...(work.remote === undefined ? {} : { remote: work.remote }),
      ...(work.branch === undefined ? {} : { branch: work.branch }),
      ...(saved === undefined ? {} : { saved }),
    });
  }
};

/**
 * Readies the machine to stop (`host.stop.prepare`), with every folder its threads hold there to
 * keep. When it says it is idle, the threads' sessions there are put to rest, so each opens again
 * on its conversation with its next message. Forced, whatever runs there is cut off by the stop:
 * those threads wait for the machine and go on once a host on its disk dials in.
 */
export const prepareStop = (
  deps: StopResumeDeps,
  id: HostId,
  options: { readonly force?: boolean | undefined; readonly remote?: string | undefined } = {},
): Effect.Effect<StopPrepared, HostFailed | HostUnavailable> =>
  Effect.gen(function* () {
    const connection = yield* deps.hosts.connection(id);
    const placed = placedOn(yield* deps.store.listThreads, id);
    // Threads whose sessions run there first and archived ones last, should there be more folders
    // than one stop keeps.
    const rank = (entry: (typeof placed)[number]) =>
      entry.session ? 0 : entry.thread.parked ? 2 : 1;
    const all = placed
      .toSorted((a, b) => rank(a) - rank(b))
      .flatMap(({ thread, cwds }) => cwds.map((cwd) => ({ threadId: thread.id, cwd })));
    // A thread whose folder a resume couldn't put back has no work there to keep: what is there
    // (a plain clone, say) would only take the place of what the remote still has of it.
    const notBack = all.filter(
      ({ threadId }) => deps.hosts.stops.blocked(id, threadId) !== undefined,
    );
    const folders = all.filter(
      ({ threadId }) => deps.hosts.stops.blocked(id, threadId) === undefined,
    );
    const asked = folders.slice(0, STOP_FOLDERS_MAX);
    const cancels = deps.hosts.stops.cancels(id);
    // The machine takes work again, and no longer counts as readied here either.
    const takeBack = connection.stop.cancel.pipe(
      Effect.timeout(CANCEL_WITHIN),
      Effect.ignore,
      Effect.ensuring(Effect.sync(() => deps.hosts.stops.back(id))),
    );
    const prepared = yield* connection.stop
      .prepare({
        checkouts: asked,
        ...(options.force === undefined ? {} : { force: options.force }),
        ...(options.remote === undefined ? {} : { remote: options.remote }),
      })
      .pipe(
        // An ask that got no answer, or whose asker went away, leaves no machine holding.
        Effect.tapError((error) => (error._tag === "HostFailed" ? takeBack : Effect.void)),
        Effect.onInterrupt(() => takeBack),
      );
    const kept = [
      ...keptOf(asked, prepared.kept, options.remote),
      ...notBack.map((folder) => ({ ...folder, pushed: false, note: NOT_BACK_KEPT })),
    ];
    // Remembered whether or not the stop holds: the remote has it now, and a resume is held to it.
    remember(deps, id, kept, prepared.kept, yield* Clock.currentTimeMillis);
    const left = folders.length - asked.length;
    const note =
      prepared.note ??
      (left > 0 ? `${left} more folders than one stop keeps were left as they are.` : undefined);
    const answer = { busy: prepared.busy, kept, ...(note === undefined ? {} : { note }) };
    // Not idle and not forced, or a stop that didn't hold: the machine takes work as before.
    if (prepared.released === true || (!prepared.idle && options.force !== true)) {
      // An earlier stop that this one's release ended isn't holding any more.
      if (prepared.released === true) deps.hosts.stops.back(id);
      return { ...answer, kept: prepared.kept.length === 0 ? [] : kept, idle: false, working: [] };
    }
    const rested: Array<ThreadId> = [];
    const working: Array<ThreadId> = [];
    for (const { thread, session } of placed) {
      if (!session) continue;
      const state = yield* deps.runtimes.restSession(thread.id);
      if (state === "rested") rested.push(thread.id);
      else if (state === "working") working.push(thread.id);
    }
    // A thread that took work between the machine's look and this one: the stop isn't safe.
    if (working.length > 0 && options.force !== true) {
      yield* takeBack;
      return {
        ...answer,
        idle: false,
        working,
        note: "A thread on it is at work or has something waiting to go.",
      };
    }
    // Taken back while its sessions were put to rest: the machine takes work again.
    if (deps.hosts.stops.cancels(id) !== cancels) {
      // Said again: the cancel may have reached the machine before this stop did.
      yield* takeBack;
      return { ...answer, idle: false, working, note: "The stop was taken back meanwhile." };
    }
    // What its threads last wrote to their shared folders comes here before the machine goes.
    if (deps.sharedFlush !== undefined)
      yield* deps.sharedFlush(id).pipe(Effect.timeoutOption(SHARED_FLUSH_WITHIN), Effect.asVoid);
    deps.hosts.stops.stopped(id, rested);
    yield* Effect.logInfo("a machine was readied to stop").pipe(
      Effect.annotateLogs({ hostId: id, idle: prepared.idle, rested: rested.length }),
    );
    return { ...answer, idle: prepared.idle && working.length === 0, working };
  });

/**
 * What runs when a machine's host says it is about to be taken away (`host.stop.going`, a
 * provisioned host sent SIGTERM): the machine is readied to stop as whoever runs it would ask,
 * forced, so each thread's work is kept and remembered before the host's process ends, and the
 * machine is owed a resume when a host dials in as it again. Within `withinMs`, past which the
 * host goes regardless. Nothing while the hosted features are off.
 */
export const readyOnGoing =
  (deps: StopResumeDeps & { readonly settings: Pick<ThreadStore["Service"], "getSettings"> }) =>
  (id: HostId, withinMs: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (!embeddingOn(yield* deps.settings.getSettings))
        return yield* Effect.logInfo("a machine about to go wasn't readied to stop").pipe(
          Effect.annotateLogs({ hostId: id, reason: "the hosted features are off" }),
        );
      const prepared = yield* prepareStop(deps, id, { force: true }).pipe(
        Effect.timeoutOrElse({
          duration: withinMs,
          orElse: () =>
            Effect.fail(new HostFailed({ message: "The machine went before its stop was ready." })),
        }),
      );
      const missed = prepared.kept.filter((work) => !work.pushed);
      yield* (missed.length > 0 ? Effect.logWarning : Effect.logInfo)(
        "a machine about to go was readied to stop",
      ).pipe(
        Effect.annotateLogs({
          hostId: id,
          kept: prepared.kept.length - missed.length,
          missed: missed.length,
          ...(missed.length > 0 ? { notes: missed.map((work) => work.note) } : {}),
          ...(prepared.note === undefined ? {} : { note: prepared.note }),
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("a machine about to go wasn't readied to stop").pipe(
          Effect.annotateLogs({ hostId: id, reason: Cause.pretty(cause).slice(0, 1024) }),
        ),
      ),
    );

/**
 * Keeps one thread's work in progress on the machine off it now, while it works on
 * (`host.stop.keep`): the thread's folders there that Gram made from a clone, each under its own
 * hidden ref at the remote. Remembered as a stop's is, so a resume on another disk is held to it;
 * after a restart the remote's ref is taken as it is. A host built before it keeps nothing.
 */
export const keepThreadWork = (
  deps: Pick<StopResumeDeps, "hosts">,
  id: HostId,
  thread: Thread,
  options: { readonly remote?: string | undefined } = {},
): Effect.Effect<ReadonlyArray<KeptWork>, HostFailed | HostUnavailable> =>
  Effect.gen(function* () {
    const connection = yield* deps.hosts.connection(id);
    const keep = connection.stop.keep;
    if (keep === undefined) return [];
    // Its folder wasn't put back: nothing there is its work, and the remote's copy stays.
    if (deps.hosts.stops.blocked(id, thread.id) !== undefined) return [];
    // Only folders made from a clone: a resume can put back only those.
    const asked = [
      ...new Set(
        checkoutsOf(thread)
          .filter((checkout) => hostOf(checkout) === id)
          .map((checkout) => checkout.path),
      ),
    ]
      .filter((cwd) => madeFrom(thread, id, cwd) !== undefined)
      .map((cwd) => ({ threadId: thread.id, cwd }));
    if (asked.length === 0) return [];
    const said = yield* keep({
      checkouts: asked,
      ...(options.remote === undefined ? {} : { remote: options.remote }),
    });
    const kept = keptOf(asked, said, options.remote);
    remember(deps, id, kept, said, yield* Clock.currentTimeMillis);
    return kept;
  });

/** Takes a stop back: the machine takes work again and no longer counts as stopped. */
export const cancelStop = (
  deps: Pick<StopResumeDeps, "hosts">,
  id: HostId,
): Effect.Effect<void, HostFailed | HostUnavailable> =>
  Effect.gen(function* () {
    const connection = yield* deps.hosts.connection(id);
    // Counted first, so a stop being readied now sees it.
    deps.hosts.stops.cancel(id);
    yield* connection.stop.cancel.pipe(
      Effect.timeoutOrElse({
        duration: CANCEL_WITHIN,
        orElse: () => Effect.fail(new HostFailed({ message: "The machine didn't answer." })),
      }),
    );
  });

export interface HostResumed {
  /** The threads whose sessions were opened on the machine again. */
  readonly reopened: ReadonlyArray<ThreadId>;
  /** Those left to open with their next message, and why. */
  readonly left: ReadonlyArray<{ readonly threadId: ThreadId; readonly reason: string }>;
  /**
   * Threads with a folder there whose folder the machine doesn't have: its disk isn't the one, and
   * the folder wasn't made again, with why when the machine was asked to.
   */
  readonly missing: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly note?: string;
  }>;
  /**
   * Folders the machine was asked to put back and didn't: it refused, failed or didn't answer, or
   * couldn't say whether the folder is there. Such a folder may be there without the thread's work
   * (a plain clone), so it isn't taken for back.
   */
  readonly refused: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly note: string;
  }>;
  /** Folders that weren't on its disk and were made again from what a stop kept of them. */
  readonly restored: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly commit?: string;
    /** Whether files that weren't committed came back with the branch. */
    readonly uncommitted?: boolean;
    /** Made from the thread's hidden ref, or from its branch at the remote when none was kept. */
    readonly source?: "ref" | "branch";
    readonly note?: string;
  }>;
  /**
   * Folders taken as back for being there, a readable repository, with nothing kept to hold them
   * to: one the user picked, and maybe put back by hand. Not checked against any work.
   */
  readonly unverified?: ReadonlyArray<{ readonly threadId: ThreadId; readonly cwd: string }>;
}

/** How long a machine gets to clone a repository again and put one folder's work back. */
const RESTORE_WITHIN = HOST_RESTORE_MS;
/** How many times a resume asks whether a folder is there before it counts as unknown. */
const PRESENCE_TRIES = 3;
const PRESENCE_RETRY = "1 second";

/**
 * How the thread's folder `cwd` on the machine was made, when Gram made it from the machine's
 * clone of a repository: that repository's URL, rebuilt from the identity recorded as it was
 * cloned, and the folder's branch. `undefined` for any other folder.
 */
const madeFrom = (thread: Thread, id: HostId, cwd: string) => {
  for (const checkout of checkoutsOf(thread)) {
    if (hostOf(checkout) !== id || checkout.path !== cwd) continue;
    const url =
      checkout.cloneIdentity === undefined ? undefined : cloneUrlOf(checkout.cloneIdentity);
    if (url !== undefined) return { url, branch: checkout.branch };
  }
  return undefined;
};

/** Why a named thread's folder isn't made from its branch: another thread in it wasn't named. */
const SHARED_FROM_BRANCH =
  "Its folder is shared with another thread that wasn't named in fromBranch, whose saved work taking the branch would drop too: name every thread in that folder, or none.";

/** Why a folder a resume confirmed isn't back this time: Git on the machine couldn't read it. */
const FOLDER_UNREAD =
  "Git on the machine couldn't read its folder, so it wasn't checked; the next resume asks again.";

/** A thread a person took the branch for, without the work its stop kept (`fromBranch`). */
const namedIn = (fromBranch: ReadonlyArray<ThreadId> | undefined, threadId: ThreadId) =>
  fromBranch?.includes(threadId) === true;

/** What a resume made of one thread's folder. */
type FolderOutcome =
  | { readonly kind: "there"; readonly unverified?: true }
  | ({ readonly kind: "restored" } & HostResumed["restored"][number])
  | { readonly kind: "missing"; readonly note?: string; readonly keptGone?: true }
  | { readonly kind: "refused"; readonly note: string; readonly keptGone?: true };

/** Why a thread's session doesn't open on the machine, for a folder of it that isn't back. */
const blockReason = (outcome: FolderOutcome) =>
  (outcome.kind === "missing" || outcome.kind === "refused") && outcome.keptGone === true
    ? KEPT_WORK_GONE_REASON
    : outcome.kind === "refused" || (outcome.kind === "missing" && outcome.note !== undefined)
      ? `Its folder wasn't put back on the machine: ${outcome.note}`
      : "Its folder isn't on the machine, and Gram can't put it back there.";

/** Why, counted: no note is a folder Gram didn't make from a clone, or a host that can't. */
const counted = (entries: ReadonlyArray<{ readonly note?: string | undefined }>) =>
  Object.fromEntries(
    [...Map.groupBy(entries, (entry) => entry.note ?? "not made from a clone here")].map(
      ([why, each]) => [why, each.length],
    ),
  );

/**
 * A person took the thread's branch without the work its last stop kept, which is gone from the
 * remote: each joined machine whose resume holds the thread off for that (`KEPT_WORK_GONE_REASON`)
 * is resumed with it in `fromBranch`. Fails with why when no machine holds it off so, a resume
 * fails, or the thread is still held off after one.
 */
export const restoreFromBranch = (
  deps: StopResumeDeps,
  threadId: ThreadId,
): Effect.Effect<void, InvalidState | ThreadNotFound> =>
  Effect.gen(function* () {
    const thread = (yield* deps.store.listThreads).find((each) => each.id === threadId);
    if (thread === undefined) return yield* new ThreadNotFound({ threadId });
    const stops = deps.hosts.stops;
    const machines = [...new Set(checkoutsOf(thread).map(hostOf))].filter(
      (id) => id !== LOCAL_HOST_ID && stops.blocked(id, threadId) === KEPT_WORK_GONE_REASON,
    );
    if (machines.length === 0)
      return yield* new InvalidState({
        threadId,
        message: "This thread isn't held off its machine for saved work that is gone.",
      });
    for (const id of machines) {
      yield* resumeHost(deps, id, { fromBranch: [threadId] }).pipe(
        Effect.mapError((error) => new InvalidState({ threadId, message: error.message })),
      );
      const still = stops.blocked(id, threadId);
      if (still !== undefined) return yield* new InvalidState({ threadId, message: still });
    }
  });

/**
 * How many of a machine's folders a resume puts back at once: one, as the host restores one at a
 * time (`stop.ts`'s lock). Asked more at once, a folder's `RESTORE_WITHIN` would run while it
 * waits its turn there, and a slow folder ahead of it would make it read as not answering while
 * the host went on with it.
 */
export const RESTORE_CONCURRENCY = 1;
/** How many folders a resume asks after at once, before any is put back. */
const LOOK_CONCURRENCY = 4;

/**
 * Resumes the machine's threads on the host that dialled in as it: checks each thread's folders
 * are on its disk, and opens again the sessions the stop put to rest, each on its own
 * conversation. A turn a forced stop cut off needs nothing from here: it goes on by itself once
 * the host is back (`machine-restart.ts`). Fails while the machine is away.
 *
 * Whether each folder is there is asked once, before anything is put back: a folder another
 * folder's restore makes meanwhile (the machine's clone, for a worktree of it) is still put back
 * from what was kept of it. A folder the machine can't say of, or one a resume before couldn't put
 * back, is the host's to decide (`host.stop.restore`). A thread whose folder is missing or refused
 * isn't back: its session doesn't open on the machine (`StopMarks.block`), and says why.
 *
 * A folder made again is held to what the stop said it kept of it: `options.kept` (a stop's
 * answer, given back by whoever asks) before what this Gram remembers of its own stops. With
 * neither, as after this Gram restarted, the remote's ref is taken as it is.
 */
export const resumeHost = (
  deps: StopResumeDeps,
  id: HostId,
  options: {
    readonly remote?: string | undefined;
    readonly kept?: ReadonlyArray<KeptBefore> | undefined;
    /** Told of each folder as it goes: a resume job's progress. */
    readonly follow?: JobReport | undefined;
    /**
     * Threads a person said to make from their branch when the work their stop kept is gone from
     * the remote (`keptWorkGone`): without that work, rather than not at all.
     */
    readonly fromBranch?: ReadonlyArray<ThreadId> | undefined;
  } = {},
): Effect.Effect<HostResumed, HostUnavailable> =>
  Effect.suspend(() => {
    const stops = deps.hosts.stops;
    // Counted before anything can fail, so the `resumed` that ends it is this resume's own. Each
    // result names the generation it runs for: once the machine is owed a resume afresh (back on
    // another disk), what this one finds on the disk it reached counts for nothing.
    const generation = stops.resumeStarted(id);
    return Effect.gen(function* () {
      const connection = yield* deps.hosts.connection(id);
      /** The connection the resume runs on went: what it says of folders isn't known any more. */
      const lost = (): boolean => (connection.gone as (() => boolean) | undefined)?.() === true;
      const placed = placedOn(yield* deps.store.listThreads, id);
      const missing: Array<HostResumed["missing"][number]> = [];
      const refused: Array<HostResumed["refused"][number]> = [];
      const restored: Array<HostResumed["restored"][number]> = [];
      const unverified: Array<NonNullable<HostResumed["unverified"]>[number]> = [];
      const restore = connection.stop.restore;
      const folders = placed.flatMap(({ thread, cwds }) => cwds.map((cwd) => ({ thread, cwd })));
      const presence = connection.git.presence ?? ((cwd: string) => connection.git.present(cwd));
      const look = (cwd: string) =>
        Effect.gen(function* () {
          for (let tries = 0; tries < PRESENCE_TRIES; tries++) {
            if (tries > 0) yield* Effect.sleep(PRESENCE_RETRY);
            const there = yield* presence(cwd);
            if (there !== undefined) return there;
          }
          return undefined;
        });
      // Asked of every folder before any is put back: what a restore makes meanwhile isn't there.
      const seen = new Map(
        yield* Effect.forEach(
          [...new Set(folders.map(({ cwd }) => cwd))],
          (cwd) => Effect.map(look(cwd), (there) => [cwd, there] as const),
          { concurrency: LOOK_CONCURRENCY },
        ),
      );
      // A folder the host can make again: one Gram made from a clone for any thread that shares
      // it, on a host that restores. Another thread taking the same path as its own doesn't stop
      // it being checked.
      const remakeable = (sharing: ReadonlyArray<(typeof folders)[number]>) =>
        restore !== undefined &&
        sharing.some(({ thread, cwd }) => madeFrom(thread, id, cwd) !== undefined);
      // On a disk the folders weren't last seen on, one that is there is checked against what
      // was kept, never taken as back for being there: once, by the first resume of the
      // generation to confirm it. One a resume before confirmed may hold new work since.
      const otherDisk = stops.onOtherDisk(id);
      // A confirmed folder the host could make is still a checkout Git reads, or it isn't the one
      // confirmed: something replaced it since (an empty folder at its path, say), and it is
      // checked again like any other. What is in a checkout is not looked at: it may hold new work.
      const local = (
        connection.git as {
          local?: (cwd: string) => Effect.Effect<{ readonly repo?: boolean }, unknown>;
        }
      ).local;
      // Asked a few times: Git that can't answer now says nothing of what is there, so such a folder
      // is neither taken as back nor owed afresh, only left for the next resume (`unread`).
      const probe = (read: NonNullable<typeof local>, cwd: string) =>
        Effect.gen(function* () {
          for (let tries = 0; tries < PRESENCE_TRIES; tries++) {
            if (tries > 0) yield* Effect.sleep(PRESENCE_RETRY);
            const said = yield* read(cwd).pipe(
              Effect.map((state) => (state.repo === true ? "checkout" : "not")),
              Effect.orElseSucceed(() => undefined),
            );
            if (said !== undefined) return said;
          }
          return "unknown" as const;
        });
      const rechecked = new Map(
        local === undefined || !otherDisk
          ? []
          : yield* Effect.forEach(
              [...Map.groupBy(folders, ({ cwd }) => cwd)]
                .filter(
                  ([cwd, sharing]) =>
                    seen.get(cwd) === true &&
                    stops.isFolderConfirmed(id, cwd) &&
                    remakeable(sharing),
                )
                .map(([cwd]) => cwd),
              (cwd) => Effect.map(probe(local, cwd), (said) => [cwd, said] as const),
              { concurrency: LOOK_CONCURRENCY },
            ),
      );
      const unread = (cwd: string) => rechecked.get(cwd) === "unknown";
      const verifyThere = (cwd: string) =>
        otherDisk && (!stops.isFolderConfirmed(id, cwd) || rechecked.get(cwd) === "not");
      // What a resume before this one set out to put back and didn't finish with.
      const owedBefore = new Set(
        [...new Set(folders.map(({ cwd }) => cwd))].filter((cwd) => stops.isFolderOwed(id, cwd)),
      );
      // Missing now, or not known, and the host can make it: owed until a resume is done with it,
      // written before anything is put back there. Not written, nothing is put back: still owed.
      const owing = [...Map.groupBy(folders, ({ cwd }) => cwd)]
        .filter(
          ([cwd, sharing]) => remakeable(sharing) && (seen.get(cwd) !== true || verifyThere(cwd)),
        )
        .map(([cwd]) => cwd);
      const written = yield* Effect.try(() => {
        for (const cwd of owing) stops.folderOwed(id, cwd, generation);
      }).pipe(Effect.option);
      if (written._tag === "None")
        return yield* new HostUnavailable({
          hostId: id,
          message: "The machine's record couldn't be kept, so nothing was put back.",
        });
      const follow = options.follow;
      if (follow !== undefined)
        yield* follow.folders(folders.map(({ thread, cwd }) => ({ threadId: thread.id, cwd })));
      /** A host that checks a folder a resume before didn't finish with before taking it as back. */
      const checksPending =
        connection.hello !== undefined && hostServes(connection.hello, "wip-restore-pending");
      /** A host that holds a folder made from its branch to the commit its stop kept. */
      const holdsKept =
        connection.hello !== undefined && hostServes(connection.hello, "wip-restore-kept");
      const putBack = (
        { thread, cwd }: (typeof folders)[number],
        there: boolean | undefined,
        pending: boolean,
        /** Every thread sharing the folder was named in `fromBranch`. */
        fromBranch: boolean,
      ): Effect.Effect<FolderOutcome> =>
        Effect.gen(function* () {
          const made = madeFrom(thread, id, cwd);
          if (restore === undefined || made === undefined) {
            // Nothing to hold it to: back as a folder its git can read, and said to be unchecked.
            // A plain folder is a chat's as much as a repository is (git reads it, `repo: false`):
            // one with anything in it is back. An empty one is as it was left on the disk its
            // folders were last seen on, and no folder of the thread's on another. One git can't
            // read is no folder of the thread's either.
            if (there === true) {
              const git = connection.git as {
                local?: (cwd: string) => Effect.Effect<{ readonly repo?: boolean }, unknown>;
              };
              const repo =
                git.local === undefined
                  ? true
                  : yield* git.local(cwd).pipe(
                      Effect.map((state) => state.repo === true),
                      Effect.orElseSucceed(() => undefined),
                    );
              if (repo === undefined)
                return {
                  kind: "refused",
                  note: "Its folder is there, but Git can't read it.",
                };
              if (repo || !verifyThere(cwd)) return { kind: "there", unverified: true };
              const files = (
                connection as {
                  files?: {
                    list: (
                      path: string,
                      options: { readonly showHidden: boolean; readonly limit: number },
                    ) => Effect.Effect<{ readonly entries: ReadonlyArray<unknown> }, unknown>;
                  };
                }
              ).files;
              const held =
                files !== undefined &&
                (yield* files.list(cwd, { showHidden: true, limit: 1 }).pipe(
                  Effect.map((listing) => listing.entries.length > 0),
                  Effect.orElseSucceed(() => false),
                ));
              return held
                ? { kind: "there", unverified: true }
                : {
                    kind: "refused",
                    note: "Its folder is there on a new disk, but empty: put its files back there.",
                  };
            }
            if (there === false) return { kind: "missing" };
            return {
              kind: "refused",
              note: "The machine couldn't say whether its folder is there.",
            };
          }
          const before =
            options.kept?.find((kept) => kept.threadId === thread.id && kept.cwd === cwd) ??
            stops.keptOf(id, thread.id, cwd);
          const commit =
            before?.commit !== undefined && OID.test(before.commit) ? before.commit : undefined;
          // The branch the machine said the folder was on at the stop, before the one recorded here.
          const branch = (commit === undefined ? undefined : before?.branch) ?? made.branch;
          // Where the stop pushed, unless this resume names somewhere else.
          const remote = options.remote ?? (commit === undefined ? undefined : before?.remote);
          const answer = yield* restore({
            threadId: thread.id,
            cwd,
            url: made.url,
            ...(branch === undefined ? {} : { branch }),
            ...(remote === undefined ? {} : { remote }),
            ...(commit === undefined ? {} : { commit }),
            ...(commit !== undefined && before?.caughtUp === true ? { caughtUp: true } : {}),
            ...(pending ? { pending: true } : {}),
            ...(fromBranch ? { fromBranch: true } : {}),
          }).pipe(
            Effect.map((said) => ({ said, failed: undefined })),
            Effect.timeoutOrElse({
              duration: RESTORE_WITHIN,
              orElse: () =>
                Effect.succeed({ said: undefined, failed: "The machine didn't answer." }),
            }),
            Effect.catch((error) => Effect.succeed({ said: undefined, failed: error.message })),
          );
          if (!answer.said) return { kind: "refused", note: cutHostText(answer.failed) };
          const said = answer.said;
          const note = said.note === undefined ? {} : { note: said.note };
          // A host before `wip-restore-kept` makes a folder from its branch whatever the branch
          // holds, caught up or not: one at another commit than the stop kept is held to be without
          // that work (the branch may have been pushed over), unless a person took the branch.
          if (
            said.restored &&
            !holdsKept &&
            !fromBranch &&
            said.source === "branch" &&
            commit !== undefined &&
            said.commit !== commit
          )
            return { kind: "refused", note: keptWorkGone(thread.id, cwd), keptGone: true };
          if (said.restored)
            return {
              kind: "restored",
              threadId: thread.id,
              cwd,
              ...(said.commit !== undefined && OID.test(said.commit)
                ? { commit: said.commit }
                : {}),
              ...(said.uncommitted === undefined ? {} : { uncommitted: said.uncommitted }),
              ...(said.source === undefined ? {} : { source: said.source }),
              ...note,
            };
          // Made meanwhile, by a resume beside this one, or there all along: left as it is. Not a
          // folder a resume before set out to put back, though, unless the host checked it: what
          // is there may be part of it, a clone without its work.
          if (said.there === true || said.note === FOLDER_THERE)
            return pending && !checksPending
              ? {
                  kind: "refused",
                  note: "A resume before set out to put this folder back, and this machine's host can't check it: update it, or remove the folder.",
                }
              : { kind: "there" };
          return {
            kind: "missing",
            ...note,
            ...(said.keptGone === true ? { keptGone: true } : {}),
          };
        });
      // Each thread's folders as they are done with, and the threads whose folders are all done.
      const toGo = new Map<ThreadId, number>();
      for (const { thread } of folders) toGo.set(thread.id, (toGo.get(thread.id) ?? 0) + 1);
      const notBack = new Map<ThreadId, string>();
      const done = (threadId: ThreadId, cwd: string, outcome: FolderOutcome) =>
        Effect.sync(() => {
          if (outcome.kind === "there" && outcome.unverified === true)
            unverified.push({ threadId, cwd });
          if (outcome.kind === "restored") {
            const { kind: _, ...entry } = outcome;
            restored.push(entry);
          } else if (outcome.kind === "missing")
            missing.push({
              threadId,
              cwd,
              ...(outcome.note === undefined ? {} : { note: outcome.note }),
            });
          else if (outcome.kind === "refused") refused.push({ threadId, cwd, note: outcome.note });
          // What a machine whose connection went said, or didn't, of a folder is unknown, not
          // missing: nothing is blocked on it, and the resume fails below and stays owed.
          if (
            (outcome.kind === "missing" || outcome.kind === "refused") &&
            !notBack.has(threadId) &&
            !lost()
          )
            notBack.set(threadId, blockReason(outcome));
          const more = (toGo.get(threadId) ?? 1) - 1;
          toGo.set(threadId, more);
          stops.progress(id, generation);
          if (more > 0 || lost()) return;
          // Only a thread whose every folder is back opens its session; the rest say why.
          const why = notBack.get(threadId);
          if (why === undefined) stops.threadBack(id, threadId, generation);
          else stops.block(id, threadId, why, generation);
        });
      // A few folders at once: each is a clone and a fetch on the host, and sessions wait for them
      // all. Threads sharing a folder take it in turn: once one has it back, it is back for all.
      // A thread whose folders are all done opens its session then, before the rest are.
      const awaited = stops.awaited(id);
      const groups = [...Map.groupBy(folders, ({ cwd }) => cwd).values()].toSorted(
        (a, b) =>
          Number(b.some(({ thread }) => awaited.has(thread.id))) -
          Number(a.some(({ thread }) => awaited.has(thread.id))),
      );
      const putBackShared = (sharing: ReadonlyArray<(typeof folders)[number]>) =>
        Effect.gen(function* () {
          const cwd = sharing[0]!.cwd;
          // A folder a resume before couldn't put back, or set out to and didn't finish with, is
          // asked of the host again, there or not, and checked by it (`pending`): what is at its
          // path may be only part of it. One the host can't make again (a folder the user picked)
          // is taken as it is: there, and readable, is back, as when the user put it back.
          // By folder: a sibling folder that couldn't be put back puts this one through nothing.
          const again =
            remakeable(sharing) &&
            (owedBefore.has(cwd) || (verifyThere(cwd) && seen.get(cwd) === true));
          // The thread made from the clone asks first: its restore is the one that checks.
          const ordered = [...sharing].toSorted(
            (a, b) =>
              Number(madeFrom(b.thread, id, b.cwd) !== undefined) -
              Number(madeFrom(a.thread, id, a.cwd) !== undefined),
          );
          const there = again && seen.get(cwd) === true ? undefined : seen.get(cwd);
          // Taking the branch without the kept work is each thread's own choice: made so only when
          // every thread in the folder was named, as it drops what any of them kept. A named thread
          // sharing it with one that wasn't is refused that, and says why.
          const takesBranch = sharing.every(({ thread }) => namedIn(options.fromBranch, thread.id));
          const outcomes: Array<FolderOutcome> = [];
          if (follow !== undefined)
            for (const folder of ordered) yield* follow.folder(folder.thread.id, cwd, "running");
          let back = false;
          for (const folder of ordered) {
            // A confirmed folder Git couldn't read now: not checked, so not back, and asked again
            // at the next resume, with nothing owed for it meanwhile.
            if (unread(cwd)) {
              outcomes.push({ kind: "refused", note: FOLDER_UNREAD });
              continue;
            }
            // There on the disk its folders were last seen on, and the host could make it: as it
            // was left. One the host can't make is held to being a readable repository below.
            if (back || (there === true && remakeable(sharing))) {
              outcomes.push({ kind: "there" });
              continue;
            }
            if (!takesBranch && namedIn(options.fromBranch, folder.thread.id)) {
              outcomes.push({ kind: "refused", note: SHARED_FROM_BRANCH });
              continue;
            }
            const outcome = yield* putBack(folder, there, again, takesBranch);
            outcomes.push(outcome);
            back = outcome.kind === "there" || outcome.kind === "restored";
          }
          for (const [at, folder] of ordered.entries()) {
            const outcome = outcomes[at]!;
            // Back for one of them is back for all who share it.
            const settled =
              back && (outcome.kind === "missing" || outcome.kind === "refused")
                ? ({ kind: "there" } as const)
                : outcome;
            yield* done(folder.thread.id, cwd, settled);
            if (follow !== undefined)
              yield* follow.folder(
                folder.thread.id,
                cwd,
                settled.kind,
                "note" in settled ? settled.note : undefined,
              );
          }
          // Done with once put back or there for all who share it, and confirmed so for the rest of
          // this resume's generation. One refused, or missing with nothing kept of it, stays owed
          // and blocked: the host may have made a plain clone at its path before finding nothing
          // to put in it, which a later resume must not take as back for being there. Nothing a
          // connection that went said counts.
          if (!lost() && back)
            // Not written: still owed, and the next resume asks again.
            yield* Effect.try(() => stops.folderDone(id, cwd, generation)).pipe(Effect.ignore);
        });
      yield* Effect.forEach(groups, putBackShared, {
        concurrency: RESTORE_CONCURRENCY,
        discard: true,
      });
      // Every folder done with, but on a connection that went, or a disk the machine has left since:
      // not a resume of the machine as it is now. It is owed still, and the threads at rest wait
      // for the one that is.
      if (lost() || !stops.isCurrent(id, generation))
        return yield* new HostUnavailable({
          hostId: id,
          message: lost()
            ? "The machine's connection went while its threads were put back."
            : "The machine came back on another disk while its threads were put back.",
        });
      const live = new Set(placed.filter(({ session }) => session).map(({ thread }) => thread.id));
      const reopened: Array<ThreadId> = [];
      const left: Array<{ readonly threadId: ThreadId; readonly reason: string }> = [];
      /** The resume, from here on, isn't of the machine as it is now: it stops, still owed. */
      const superseded = () =>
        lost() || !stops.isCurrent(id, generation)
          ? new HostUnavailable({
              hostId: id,
              message:
                "The machine went, or came back on another disk, while its threads reopened.",
            })
          : undefined;
      // Each thread at rest leaves the list once its session is seen open, or the thread is gone:
      // one whose folder isn't back, whose start was refused or that doesn't open in time stays
      // on it for the next resume.
      const opening: Array<ThreadId> = [];
      for (const threadId of stops.restedOf(id)) {
        const why = notBack.get(threadId);
        if (why !== undefined) {
          left.push({ threadId, reason: why });
          continue;
        }
        // Archived, closed or moved since the stop: nothing to reopen.
        if (!live.has(threadId)) {
          yield* Effect.try(() => stops.restedDone(id, threadId, generation)).pipe(Effect.ignore);
          continue;
        }
        const started = yield* deps.runtimes.startSession(threadId).pipe(
          Effect.as(undefined),
          Effect.catch((error) =>
            Effect.succeed(error._tag === "InvalidState" ? error.message : "The thread is gone."),
          ),
        );
        const stop = superseded();
        if (stop !== undefined) return yield* stop;
        if (started === undefined) opening.push(threadId);
        else left.push({ threadId, reason: started });
      }
      const opened = yield* Effect.forEach(
        opening,
        (threadId) =>
          Effect.map(sessionOpened(deps.runtimes, threadId), (ok) => [threadId, ok] as const),
        { concurrency: "unbounded" },
      );
      const stop = superseded();
      if (stop !== undefined) return yield* stop;
      for (const [threadId, ok] of opened) {
        if (!ok) {
          left.push({ threadId, reason: "Its session didn't open." });
          continue;
        }
        reopened.push(threadId);
        // Not written: still on the list, and the next resume finds it open already.
        yield* Effect.try(() => stops.restedDone(id, threadId, generation)).pipe(Effect.ignore);
      }
      // Gone through every folder on the machine as it is now: it owes nothing, once that is
      // written. Not written, it is still owed, and this resume says it failed.
      const settled = yield* Effect.try(() => stops.settle(id, generation)).pipe(Effect.option);
      if (settled._tag === "None")
        return yield* new HostUnavailable({
          hostId: id,
          message:
            "The machine's threads are back, but its record couldn't be kept: resume it again.",
        });
      yield* Effect.logInfo("a machine's threads were resumed").pipe(
        Effect.annotateLogs({
          hostId: id,
          reopened: reopened.length,
          missing: missing.length,
          refused: refused.length,
          restored: restored.length,
          blocked: notBack.size,
          ...(missing.length === 0 ? {} : { missingWhy: counted(missing) }),
          ...(refused.length === 0 ? {} : { refusedWhy: counted(refused) }),
        }),
      );
      return {
        reopened,
        left,
        missing,
        refused,
        restored,
        ...(unverified.length === 0 ? {} : { unverified }),
      };
    }).pipe(
      // Counted off however it ended. Only `settle` above lifts what the machine owes: one that
      // couldn't reach the machine, failed or was cut off leaves the resume owed.
      Effect.onExit(() => Effect.sync(() => stops.resumed(id, generation, false))),
    );
  });

/** How long a reopened session at rest is waited for before it counts as not opened. */
export const REOPEN_WITHIN = Duration.millis(REOPEN_MS);

/** The statuses of a thread whose session is open. */
const OPEN: ReadonlySet<string> = new Set(["idle", "running", "needsApproval", "needsInput"]);

/**
 * Whether the thread's session is seen open, its start having been asked: true once its status is
 * one of an open session's, false once it ends up in another or `REOPEN_WITHIN` passes. A runtime
 * that can't say (only in tests) is taken at its start's word.
 */
const sessionOpened = (
  runtimes: Partial<Pick<ThreadRuntimesShape, "snapshot">>,
  threadId: ThreadId,
): Effect.Effect<boolean> => {
  const snapshot = runtimes.snapshot;
  if (snapshot === undefined) return Effect.succeed(true);
  const look = snapshot.pipe(
    Effect.map((all) => all.find((summary) => summary.thread.id === threadId)?.status),
    Effect.flatMap((status) =>
      status === "starting" ? Effect.fail("starting" as const) : Effect.succeed(status),
    ),
  );
  return look.pipe(
    Effect.retry(Schedule.spaced("250 millis")),
    Effect.timeoutOrElse({ duration: REOPEN_WITHIN, orElse: () => Effect.succeed(undefined) }),
    Effect.map((status) => status !== undefined && OPEN.has(status)),
    Effect.orElseSucceed(() => false),
  );
};

export interface StopState {
  readonly id: HostId;
  readonly name: string;
  readonly online: boolean;
  /** When it was readied to stop, epoch ms; absent once it dialled in again. */
  readonly stoppedAt?: number;
  /** A thread waits for it to be started now. */
  readonly wanted: boolean;
  /**
   * Dialled in after a stop, or on another disk, and not yet resumed (`StopMarks.owes`), however
   * it was started: resume it (`POST /machines/stop/resume`), as its sessions wait for that.
   */
  readonly resuming?: boolean;
  /**
   * Threads whose session doesn't open on it, because a resume couldn't put their folders back
   * (`StopMarks.block`), each with why: what an embedder that started the machine says when it
   * runs but its threads can't use it. Absent when there are none.
   */
  readonly blocked?: ReadonlyArray<{ readonly threadId: string; readonly reason: string }>;
  /** Its resume made no progress for too long (`StopMarks.stalled`), epoch ms since. */
  readonly stalledSince?: number;
}

/** Each joined machine: whether it is dialled in, readied to stop, and wanted. */
export const stopStatus = (
  deps: Pick<StopResumeDeps, "hosts">,
): Effect.Effect<ReadonlyArray<StopState>> =>
  Effect.forEach(
    deps.hosts.machines.list().filter((machine) => machine.confirmedAt !== undefined),
    (machine) =>
      Effect.gen(function* () {
        const id = machine.id as HostId;
        const online = yield* deps.hosts.connection(id).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        const stoppedAt = deps.hosts.stops.stoppedAt(id);
        const blocked = Object.entries(deps.hosts.stops.blocks(id)).map(([threadId, reason]) => ({
          threadId,
          reason,
        }));
        const stalledSince = deps.hosts.stops.stalled(id);
        return {
          id,
          name: machine.name,
          online,
          ...(stoppedAt === undefined ? {} : { stoppedAt }),
          wanted: deps.hosts.stops.wanted(id),
          ...(online && deps.hosts.stops.owes(id) ? { resuming: true } : {}),
          ...(blocked.length === 0 ? {} : { blocked }),
          ...(stalledSince === undefined ? {} : { stalledSince }),
        };
      }),
  );

/**
 * The diff behind the thread's `savedWork`, as its machine last sent it (`StopMarks`): its main
 * folder's first. Undefined once this Gram restarted since, or when nothing was saved.
 */
export const savedDiffOf = (
  stops: Pick<RemoteHostsShape["stops"], "keptOf">,
  thread: Thread,
): SavedDiff | undefined => {
  const main = effectiveCheckout(thread);
  return checkoutsOf(thread)
    .toSorted((a, b) => Number(b.path === main.path) - Number(a.path === main.path))
    .flatMap((checkout) => {
      const id = hostOf(checkout);
      const saved = stops.keptOf(id, thread.id, checkout.path)?.saved;
      return saved === undefined ? [] : [saved];
    })[0];
};

/** How often machines owing a resume are looked at again, should no change say so. */
const OWED_SWEEP = "1 minute";
/**
 * How often a machine that owes nothing but has threads whose folders couldn't be put back is
 * resumed again: one put back by hand, or a fetch that failed for a while, is found then.
 */
export const BLOCKED_RETRY_MS = 10 * 60_000;
/** The first wait before threads at rest whose sessions didn't open are tried again, doubled up to the most. */
export const RESTED_RETRY_FIRST_MS = 60_000;
export const RESTED_RETRY_MOST_MS = 30 * 60_000;

/**
 * With the hosted features off, nothing outside this Gram starts or resumes its machines, so one
 * that dials in owing a resume (back on another disk, `StopMarks.owes`) is resumed here as soon as
 * it is online, one resume at a time: its sessions wait for that rather than open over folders
 * that aren't there. A resume that doesn't complete leaves it owed, and it is tried again at the
 * next change or sweep. With them on, whoever starts the machines asks (`POST /machines/stop/resume`).
 */
export const resumeOwedMachines = (
  deps: StopResumeDeps & {
    readonly hosts: Pick<RemoteHostsShape, "watch">;
    readonly settings: Pick<ThreadStore["Service"], "getSettings">;
  },
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const run = yield* FiberSet.makeRuntime<never>();
    const going = new Set<HostId>();
    /** When each machine owing nothing but blocked folders was last resumed for them. */
    const triedBlocked = new Map<HostId, number>();
    /** When each machine with threads at rest not yet reopened is tried next, and how long after. */
    const restedBackoff = new Map<HostId, { wait: number; next: number }>();
    const sweep = Effect.gen(function* () {
      const hosted = embeddingOn(yield* deps.settings.getSettings);
      for (const machine of deps.hosts.machines.list()) {
        const id = machine.id as HostId;
        if (machine.confirmedAt === undefined || going.has(id)) continue;
        if (deps.hosts.stops.resumeRunning(id)) continue;
        const at = yield* Clock.currentTimeMillis;
        // Left at rest after a resume: one that owes nothing more and isn't readied to stop again.
        const resting =
          deps.hosts.stops.restedOf(id).length > 0 &&
          !deps.hosts.stops.owes(id) &&
          deps.hosts.stops.stoppedAt(id) === undefined;
        if (hosted || !deps.hosts.stops.owes(id)) {
          // Threads at rest whose sessions didn't open: tried again, less often each time, with
          // the hosted features on or off. Owing nothing, but with folders that couldn't be put
          // back: asked again now and then, with them off; with them on, whoever starts machines
          // resumes them.
          const backoff = restedBackoff.get(id);
          const restedDue = resting && (backoff === undefined || at >= backoff.next);
          const blockedDue =
            !hosted &&
            deps.hosts.stops.anyBlocked(id) &&
            at - (triedBlocked.get(id) ?? 0) >= BLOCKED_RETRY_MS;
          if (!restedDue && !blockedDue) continue;
          if (blockedDue) triedBlocked.set(id, at);
          if (restedDue) {
            const wait = Math.min(
              (backoff?.wait ?? RESTED_RETRY_FIRST_MS / 2) * 2,
              RESTED_RETRY_MOST_MS,
            );
            restedBackoff.set(id, { wait, next: at + wait });
          }
        }
        if (!resting) restedBackoff.delete(id);
        const online = yield* deps.hosts.connection(id).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (!online) continue;
        going.add(id);
        run(
          Effect.logInfo("a machine back on another disk is resumed by this Gram").pipe(
            Effect.annotateLogs({ hostId: id }),
            Effect.andThen(resumeHost(deps, id)),
            Effect.catchCause((cause) =>
              Effect.logWarning("a machine's resume didn't complete; it is tried again").pipe(
                Effect.annotateLogs({ hostId: id, reason: Cause.pretty(cause).slice(0, 300) }),
              ),
            ),
            Effect.ensuring(Effect.sync(() => going.delete(id))),
          ),
        );
      }
    }).pipe(Effect.catchCause(() => Effect.void));
    yield* Effect.acquireRelease(
      Effect.sync(() => deps.hosts.watch(() => void run(sweep))),
      (unwatch) => Effect.sync(unwatch),
    );
    yield* sweep.pipe(Effect.repeat(Schedule.spaced(OWED_SWEEP)), Effect.forkScoped);
  });
