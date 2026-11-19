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
  type HostUnavailable,
  type SavedDiff,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import { isWipRefOf } from "@gram/git";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { ThreadStore } from "../persistence/thread-store.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";
import type { RemoteHostsShape } from "./remote-hosts.ts";
import { cloneUrlOf } from "./repos.ts";
import { FOLDER_THERE } from "./stop.ts";

export interface StopResumeDeps {
  readonly hosts: Pick<RemoteHostsShape, "connection" | "machines" | "stops">;
  readonly store: Pick<ThreadStore["Service"], "listThreads">;
  readonly runtimes: Pick<ThreadRuntimesShape, "restSession" | "startSession">;
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
const SHARED_FLUSH_WITHIN = "15 seconds";
/** How long a machine gets to say it takes work again. */
const CANCEL_WITHIN = "30 seconds";

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
 * (`host.stop.keep`): the thread's folders there that Gram made from a clone, under the thread's
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
}

/** How long a machine gets to clone a repository again and put one folder's work back. */
const RESTORE_WITHIN = "20 minutes";
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

/** What a resume made of one thread's folder. */
type FolderOutcome =
  | { readonly kind: "there" }
  | ({ readonly kind: "restored" } & HostResumed["restored"][number])
  | { readonly kind: "missing"; readonly note?: string }
  | { readonly kind: "refused"; readonly note: string };

/** Why a thread's session doesn't open on the machine, for a folder of it that isn't back. */
const blockReason = (outcome: FolderOutcome) =>
  outcome.kind === "refused" || (outcome.kind === "missing" && outcome.note !== undefined)
    ? `Its folder wasn't put back on the machine: ${outcome.note}`
    : "Its folder isn't on the machine, and Gram can't put it back there.";

/** Why, counted: no note is a folder Gram didn't make from a clone, or a host that can't. */
const counted = (entries: ReadonlyArray<{ readonly note?: string | undefined }>) =>
  Object.fromEntries(
    [...Map.groupBy(entries, (entry) => entry.note ?? "not made from a clone here")].map(
      ([why, each]) => [why, each.length],
    ),
  );

/** How many of a machine's folders a resume puts back at once. */
export const RESTORE_CONCURRENCY = 4;

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
  } = {},
): Effect.Effect<HostResumed, HostUnavailable> =>
  Effect.suspend(() => {
    const stops = deps.hosts.stops;
    // Counted before anything can fail, so the `resumed` that ends it is this resume's own.
    stops.resumeStarted(id);
    return Effect.gen(function* () {
      const connection = yield* deps.hosts.connection(id);
      const placed = placedOn(yield* deps.store.listThreads, id);
      const missing: Array<HostResumed["missing"][number]> = [];
      const refused: Array<HostResumed["refused"][number]> = [];
      const restored: Array<HostResumed["restored"][number]> = [];
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
          { concurrency: RESTORE_CONCURRENCY },
        ),
      );
      // Missing now: owed until this resume, or a later one, is done with it.
      for (const [cwd, there] of seen) if (there === false) stops.folderOwed(id, cwd);
      const putBack = (
        { thread, cwd }: (typeof folders)[number],
        there: boolean | undefined,
      ): Effect.Effect<FolderOutcome> =>
        Effect.gen(function* () {
          const made = madeFrom(thread, id, cwd);
          if (restore === undefined || made === undefined) {
            if (there === true) return { kind: "there" };
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
          }).pipe(
            Effect.map((said) => ({ said, failed: undefined })),
            Effect.timeoutOrElse({
              duration: RESTORE_WITHIN,
              orElse: () =>
                Effect.succeed({ said: undefined, failed: "The machine didn't answer." }),
            }),
            Effect.catch((error) => Effect.succeed({ said: undefined, failed: error.message })),
          );
          if (answer.said === undefined) return { kind: "refused", note: answer.failed };
          const said = answer.said;
          const note = said.note === undefined ? {} : { note: said.note };
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
          // Made meanwhile, by a resume beside this one, or there all along: left as it is.
          if (said.there === true || said.note === FOLDER_THERE) return { kind: "there" };
          return { kind: "missing", ...note };
        });
      // Each thread's folders as they are done with, and the threads whose folders are all done.
      const toGo = new Map<ThreadId, number>();
      for (const { thread } of folders) toGo.set(thread.id, (toGo.get(thread.id) ?? 0) + 1);
      const notBack = new Map<ThreadId, string>();
      const done = (threadId: ThreadId, cwd: string, outcome: FolderOutcome) =>
        Effect.sync(() => {
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
          if ((outcome.kind === "missing" || outcome.kind === "refused") && !notBack.has(threadId))
            notBack.set(threadId, blockReason(outcome));
          const more = (toGo.get(threadId) ?? 1) - 1;
          toGo.set(threadId, more);
          stops.progress(id);
          if (more > 0) return;
          // Only a thread whose every folder is back opens its session; the rest say why.
          const why = notBack.get(threadId);
          if (why === undefined) stops.threadBack(id, threadId);
          else stops.block(id, threadId, why);
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
          // asked of the host again, there or not: what is at its path may be only what another
          // folder's restore made of it.
          const again =
            stops.isFolderOwed(id, cwd) ||
            sharing.some(({ thread }) => stops.blocked(id, thread.id) !== undefined);
          const there = again && seen.get(cwd) === true ? undefined : seen.get(cwd);
          const outcomes: Array<FolderOutcome> = [];
          let back = false;
          for (const folder of sharing) {
            if (back || there === true) {
              outcomes.push({ kind: "there" });
              continue;
            }
            const outcome = yield* putBack(folder, there);
            outcomes.push(outcome);
            back = outcome.kind === "there" || outcome.kind === "restored";
          }
          for (const [at, folder] of sharing.entries()) {
            const outcome = outcomes[at]!;
            // Back for one of them is back for all who share it.
            const settled =
              back && (outcome.kind === "missing" || outcome.kind === "refused")
                ? ({ kind: "there" } as const)
                : outcome;
            yield* done(folder.thread.id, cwd, settled);
          }
          // Done with: put back or there for all who share it, or missing with nothing kept of it.
          // One refused stays owed, and blocked, for the next resume.
          if (back || outcomes.every((outcome) => outcome.kind === "missing"))
            stops.folderDone(id, cwd);
        });
      yield* Effect.forEach(groups, putBackShared, {
        concurrency: RESTORE_CONCURRENCY,
        discard: true,
      });
      const live = new Set(placed.filter(({ session }) => session).map(({ thread }) => thread.id));
      const reopened: Array<ThreadId> = [];
      const left: Array<{ readonly threadId: ThreadId; readonly reason: string }> = [];
      for (const threadId of stops.takeRested(id)) {
        // Archived, closed or moved since the stop.
        if (!live.has(threadId)) continue;
        const why = notBack.get(threadId);
        if (why !== undefined) {
          left.push({ threadId, reason: why });
          continue;
        }
        const started = yield* deps.runtimes.startSession(threadId).pipe(
          Effect.as(undefined),
          Effect.catch((error) =>
            Effect.succeed(error._tag === "InvalidState" ? error.message : "The thread is gone."),
          ),
        );
        if (started === undefined) reopened.push(threadId);
        else left.push({ threadId, reason: started });
      }
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
      return { reopened, left, missing, refused, restored };
    }).pipe(
      // Sessions held for it (`StopMarks.resuming`) open now, but those of threads not back.
      Effect.ensuring(Effect.sync(() => stops.resumed(id))),
    );
  });

export interface StopState {
  readonly id: HostId;
  readonly name: string;
  readonly online: boolean;
  /** When it was readied to stop, epoch ms; absent once it dialled in again. */
  readonly stoppedAt?: number;
  /** A thread waits for it to be started now. */
  readonly wanted: boolean;
  /**
   * Dialled in after a stop and not yet resumed (`StopMarks.resuming`), however it was started:
   * resume it (`POST /machines/stop/resume`), as its sessions wait for that.
   */
  readonly resuming?: boolean;
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
        return {
          id,
          name: machine.name,
          online,
          ...(stoppedAt === undefined ? {} : { stoppedAt }),
          wanted: deps.hosts.stops.wanted(id),
          ...(online && deps.hosts.stops.resuming(id) ? { resuming: true } : {}),
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
