// What this Gram remembers of the machines it readied to stop (`stop-resume.ts`): which are
// stopped, which threads' sessions it put to rest for the stop, what each stop said it kept of a
// folder, which machines are owed a resume and which threads' folders it put back or couldn't, and
// which disk each machine's host last said it runs on (`HostHello.diskId`). All of that is kept
// across a restart of this Gram (`persisted`), so a machine that comes back after one is still owed
// its resume and its sessions still wait for it. What waits on a machine now (`wanting`,
// `awaiting`) and how many resumes run are this process's alone, as is the diff behind a save.

import {
  effectiveCheckout,
  HostDiskId,
  hostOf,
  LOCAL_HOST_ID,
  type HostId,
  type SavedDiff,
  type Thread,
  ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { STOP_HOLD_MS } from "./stop.ts";

/** How long after a readied machine's hold its sessions are still waited for as a stopped one's. */
export const STOPPED_RECENTLY_MS = 15 * 60_000;
/**
 * How long a machine owed a resume may go with no restore progress (no resume started, no folder
 * done) before the sessions waiting on it give up, and say so. A resume under way always makes
 * progress sooner: each folder is done within `RESTORE_WITHIN` (20 minutes) of being started.
 * Only the end of its resume opens the machine to sessions; this never does.
 */
export const RESUME_STALL_MS = 25 * 60_000;

/** How long a machine told to come back on another disk (`expect`) is taken at its word. */
export const EXPECT_FOR_MS = 15 * 60_000;

/**
 * Whether the thread's folder is missing only because its machine, back on a new disk, hasn't had
 * it put back yet: the machine is owed a resume (`resuming`) and the thread's folders aren't back.
 * A session waiting for that resume isn't stopped for a deleted folder meanwhile.
 */
export const folderOwedResume = (
  stops: Pick<StopMarks, "resuming" | "isThreadBack">,
  thread: Thread,
): boolean => {
  const id = hostOf(effectiveCheckout(thread));
  return id !== LOCAL_HOST_ID && stops.resuming(id) && !stops.isThreadBack(id, thread.id);
};

/** What a stop said it kept of one folder at a remote, for a resume to hold the remote to. */
export interface KeptRecord {
  /** The commit under the thread's ref, or the branch's tip when `caughtUp`. */
  readonly commit: string;
  /** No ref was kept: the branch at the remote held everything. */
  readonly caughtUp: boolean;
  /** Where it was pushed, as the stop was asked: the remote a resume fetches it from. */
  readonly remote?: string;
  /** The branch the folder was on, when the machine said. */
  readonly branch?: string;
  /** Epoch ms this Gram heard it was kept. */
  readonly at?: number;
  /** What the save holds against the branch's base, when the machine said. */
  readonly saved?: SavedDiff;
}

/**
 * How many folders' kept records a machine keeps, newest first: what a resume holds a folder to.
 * Older ones are dropped, so the marks file stays small however long a machine lives.
 */
export const KEPT_FOLDERS_MAX = 256;

/**
 * How many disks a machine is remembered to have been replaced from, newest kept: a host that says
 * one of them is refused. Far more than a machine is ever replaced in its life; removing the
 * machine and joining it again starts it over.
 */
export const RETIRED_DISKS_KEPT = 4096;

/** What a stop said it kept of a folder, as kept across a restart: without the diff behind it. */
const KeptRecordStored = Schema.Struct({
  commit: Schema.String,
  caughtUp: Schema.Boolean,
  remote: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  at: Schema.optionalKey(Schema.Number),
});

/** One machine's marks as kept across a restart of this Gram. */
export const MachineMarks = Schema.Struct({
  /** Readied to stop then, and whether its connection was lost since. */
  stop: Schema.optionalKey(Schema.Struct({ at: Schema.Number, left: Schema.Boolean })),
  last: Schema.optionalKey(Schema.Number),
  rested: Schema.optionalKey(Schema.Array(ThreadId)),
  /** Told to come back on another disk then (`expect`). */
  expected: Schema.optionalKey(Schema.Number),
  /** Owed a resume, with when it last made progress. */
  owed: Schema.optionalKey(Schema.Struct({ progress: Schema.Number })),
  /**
   * Counts the times the machine was owed a resume afresh: a resume's results count only for the
   * one owed when it started (`StopMarks.resumeStarted`).
   */
  generation: Schema.optionalKey(Schema.Int),
  stalled: Schema.optionalKey(Schema.Number),
  /** While owed: the threads whose folders are back. */
  back: Schema.optionalKey(Schema.Array(ThreadId)),
  /** The threads whose folders a resume couldn't put back, with why. */
  blocks: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  kept: Schema.optionalKey(Schema.Record(Schema.String, KeptRecordStored)),
  /** The disk its host last said it runs on, the start of the host that said it, and when. */
  disk: Schema.optionalKey(
    Schema.Struct({ id: HostDiskId, boot: Schema.optionalKey(HostDiskId), at: Schema.Number }),
  ),
  /** Disks it was replaced from, oldest first: a host that says one of them is refused. */
  retired: Schema.optionalKey(Schema.Array(HostDiskId)),
});
export type MachineMarks = typeof MachineMarks.Type;

/** Every machine's marks, as `persisted` keeps them. */
export type MachineMarksByHost = Readonly<Record<string, MachineMarks>>;

/**
 * What a host dialling in said of its disk makes it, against the disk last remembered for its
 * machine (`StopMarks.hello`):
 * - `unknown`: it said none (a host built before it said one, or one that couldn't keep one);
 * - `first`: no disk was remembered for the machine;
 * - `redial`: the same disk and the same start of its host: only its connection dropped;
 * - `restarted`: the same disk, another start: its sessions went with the old one, its folders
 *   are there;
 * - `replaced`: another disk, a new machine under the same key, whose folders aren't there until
 *   a resume puts them back. It is owed one from then, in the same change that remembers the disk,
 *   and the disk before is retired;
 * - `fenced`: a disk it was replaced from, or the disk it was told it comes back without
 *   (`expect`): an old host that dialled in again with the machine's key, which is refused.
 */
export type DiskVerdict =
  | { readonly kind: "unknown" | "first" | "redial" | "restarted" }
  | { readonly kind: "replaced"; readonly was: string }
  | { readonly kind: "fenced"; readonly why: "replaced" | "expected" };

export interface StopMarks {
  /**
   * A host of the machine dialled in, saying this of its disk: what that makes it. Remembers the
   * disk it said unless it is `fenced`, and on another disk retires the one before and owes the
   * machine a resume, kept as one change.
   */
  readonly hello: (
    id: HostId,
    said: { readonly diskId?: string | undefined; readonly bootId?: string | undefined },
  ) => DiskVerdict;
  /** The disk last remembered for the machine (`hello`), if any host of it ever said one. */
  readonly disk: (id: HostId) => string | undefined;
  /** A stop said the machine kept this of the thread's folder `cwd` at a remote. */
  readonly keep: (id: HostId, threadId: ThreadId, cwd: string, record: KeptRecord) => void;
  /** What the last stop that kept anything of the folder said; kept when a stop is taken back. */
  readonly keptOf: (id: HostId, threadId: ThreadId, cwd: string) => KeptRecord | undefined;
  /** The machine was readied to stop now, these threads' sessions put to rest for it. */
  readonly stopped: (id: HostId, rested: ReadonlyArray<ThreadId>) => void;
  /**
   * When the machine was readied to stop. Undefined once it dialled in again or its stop was taken
   * back, and once its hold ran out with its connection never lost: it wasn't stopped after all.
   */
  readonly stoppedAt: (id: HostId) => number | undefined;
  /** Readied, still connected and within its hold: it is there but takes no work. */
  readonly holding: (id: HostId) => boolean;
  /** Readied within its hold and `STOPPED_RECENTLY_MS`, a connection lost or made since or not. */
  readonly recently: (id: HostId) => boolean;
  /** The machine's connection was lost. */
  readonly away: (id: HostId) => void;
  /**
   * The machine dialled in: it is no longer stopped. The threads rested for it are kept. One that
   * had left after it was readied, or was told to come back on another disk, is owed a resume
   * from then (`resuming`), as is one `hello` found on another disk, already.
   */
  readonly back: (id: HostId) => void;
  /**
   * The machine will dial in on another disk, whatever this Gram remembers of its stop (none, after
   * a restart): once it is back, it is owed a resume as one that left after a stop is.
   */
  readonly expect: (id: HostId) => void;
  /**
   * Its sessions wait for its resume: dialled in after a stop, or on another disk, and its threads
   * not yet resumed, until a resume of it completes or it goes `RESUME_STALL_MS` with no restore
   * progress (`stalled` then says since when). A stall opens the gate to the sessions sent after it
   * is said, but the machine still `owes` the resume.
   */
  readonly resuming: (id: HostId) => boolean;
  /**
   * The machine is owed a resume, stalled or not: only a resume of it that completes on its
   * current disk settles that. What whoever starts machines reads (`stopStatus`).
   */
  readonly owes: (id: HostId) => boolean;
  /** A resume of the machine runs now. */
  readonly resumeRunning: (id: HostId) => boolean;
  /**
   * When the machine's owed resume was given up on for making no progress, while nothing newer
   * is owed: the sessions that waited for it are told so, rather than opened.
   */
  readonly stalled: (id: HostId) => number | undefined;
  /**
   * A resume of the machine starts: its folders are being put back. Answers the generation it
   * runs for, which each of its results below names: a result for another generation (the
   * machine came back on another disk since) is dropped.
   */
  readonly resumeStarted: (id: HostId) => number;
  /** One of the machine's folders is done with by its resume, put back or not. */
  readonly progress: (id: HostId, generation?: number) => void;
  /**
   * A resume of the machine ended, having gone through every folder (`completed`) or not (it
   * couldn't reach the machine, failed, or was interrupted). Once none is running and one
   * completed, sessions open on it as on any machine, but those of `blocked` threads; one that
   * didn't complete leaves the resume owed.
   */
  readonly resumed: (id: HostId, generation?: number, completed?: boolean) => void;
  /**
   * While the machine is `resuming`: this thread's folders are back, so its session may open
   * before the others' are. Lifts a block a resume before put on it.
   */
  readonly threadBack: (id: HostId, threadId: ThreadId, generation?: number) => void;
  /**
   * A resume couldn't put this thread's folder back (missing, or refused): its session doesn't open
   * on the machine, now or once the resume ends, until a later resume puts it back.
   */
  readonly block: (id: HostId, threadId: ThreadId, reason: string, generation?: number) => void;
  /** Why the thread's session doesn't open on the machine (`block`), if it doesn't. */
  readonly blocked: (id: HostId, threadId: ThreadId) => string | undefined;
  /** Told when threads' sessions may open on a machine now: a thread back, or its resume ended. */
  readonly onReady: (listener: (id: HostId) => void) => () => void;
  /** Whether `threadBack` said so of this thread since the machine was last owed a resume. */
  readonly isThreadBack: (id: HostId, threadId: ThreadId) => boolean;
  /** A session of this thread waits for the machine's resume: its folders go first. */
  readonly awaiting: (id: HostId, threadId: ThreadId) => void;
  /** The threads a session waits on the machine's resume for, as `awaiting` said. */
  readonly awaited: (id: HostId) => ReadonlySet<ThreadId>;
  /** The stop was taken back: nothing is remembered of it. */
  readonly cancel: (id: HostId) => void;
  /** How many times the machine's stops were taken back. */
  readonly cancels: (id: HostId) => number;
  /** The threads put to rest for the machine's last stop, handed out once. */
  readonly takeRested: (id: HostId) => ReadonlyArray<ThreadId>;
  /** Runs `effect` as something that waits on the machine to be started. */
  readonly wanting: <A, E, R>(id: HostId, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Whether anything waits on the machine to be started now. */
  readonly wanted: (id: HostId) => boolean;
  /** Since when something has waited on the machine to be started, while anything does. */
  readonly wantedSince: (id: HostId) => number | undefined;
  /** The machine was removed: nothing is remembered of it. */
  readonly forget: (id: HostId) => void;
}

/** Adds `threadId` to the machine's set in `map`. */
const add = (map: Map<HostId, Set<ThreadId>>, id: HostId, threadId: ThreadId) => {
  const set = map.get(id) ?? new Set<ThreadId>();
  set.add(threadId);
  map.set(id, set);
};

/** One folder of one thread, as a key. */
const folder = (threadId: ThreadId, cwd: string) => `${threadId}\0${cwd}`;

export const makeStopMarks = (
  now: () => number = Date.now,
  holdMs: number = STOP_HOLD_MS,
  /** Told when a machine starts or stops being waited on (`wantedSince`). */
  onWanted: (id: HostId) => void = () => {},
  stallMs: number = RESUME_STALL_MS,
  /**
   * Where the marks are kept across a restart: those kept before, and where each change goes,
   * every machine's at once. Kept in memory alone when left out.
   */
  persisted?: {
    readonly initial: MachineMarksByHost;
    /** Throws when the marks couldn't be kept; they are tried again at the next change. */
    readonly save: (all: MachineMarksByHost) => void;
    readonly failed?: (error: unknown) => void;
  },
): StopMarks => {
  const marks = new Map<HostId, { readonly at: number; left: boolean }>();
  const last = new Map<HostId, number>();
  const rested = new Map<HostId, ReadonlyArray<ThreadId>>();
  const waiting = new Map<HostId, number>();
  const waitingSince = new Map<HostId, number>();
  const cancels = new Map<HostId, number>();
  const kept = new Map<HostId, Map<string, KeptRecord>>();
  /**
   * Owed a resume: since when the last progress was made, how many resumes run now, the
   * generation it was owed under, and whether a resume of that generation completed.
   */
  const owed = new Map<
    HostId,
    { progress: number; running: number; generation: number; completed: boolean }
  >();
  /** Machines `hello` owed a resume for their new disk, which the `back` after it keeps. */
  const helloOwed = new Set<HostId>();
  /** The last generation each machine was owed a resume under (`resumeStarted`). */
  const generations = new Map<HostId, number>();
  /** Owes the machine a resume afresh: a new generation, nothing back, no stall. */
  const owe = (id: HostId) => {
    const generation = (generations.get(id) ?? 0) + 1;
    generations.set(id, generation);
    owed.set(id, { progress: now(), running: 0, generation, completed: false });
    stalls.delete(id);
    threadsBack.delete(id);
  };
  /**
   * Whether a result for `generation` is still the machine's: no resume was owed afresh since it
   * started (or it names none). A resume of a machine that owed none counts as the last one's.
   */
  const current = (id: HostId, generation: number | undefined) =>
    generation === undefined ||
    (owed.get(id)?.generation ?? generations.get(id) ?? 0) === generation;
  const stalls = new Map<HostId, number>();
  const blocks = new Map<HostId, Map<ThreadId, string>>();
  const readyListeners = new Set<(id: HostId) => void>();
  const ready = (id: HostId) => {
    for (const listener of readyListeners) {
      try {
        listener(id);
      } catch {
        // A listener's failure is its own.
      }
    }
  };
  /** Told to come back on another disk (`expect`), since when. */
  const expected = new Map<HostId, number>();
  const threadsBack = new Map<HostId, Set<ThreadId>>();
  const threadsAwaiting = new Map<HostId, Set<ThreadId>>();
  const disks = new Map<HostId, { id: string; boot?: string; at: number }>();
  const retired = new Map<HostId, ReadonlyArray<string>>();

  /** What is kept of each machine, as last saved. */
  const stored = new Map<HostId, MachineMarks>();
  /** Machines whose marks changed and aren't kept yet: a save that failed is tried again. */
  const unsaved = new Set<HostId>();
  const snapshot = (id: HostId): MachineMarks | undefined => {
    const mark = marks.get(id);
    const owing = owed.get(id);
    const back = threadsBack.get(id);
    const reasons = blocks.get(id);
    const records = kept.get(id);
    const disk = disks.get(id);
    const generation = generations.get(id);
    const was = retired.get(id);
    const value: MachineMarks = {
      ...(mark === undefined ? {} : { stop: { at: mark.at, left: mark.left } }),
      ...(last.has(id) ? { last: last.get(id)! } : {}),
      ...((rested.get(id)?.length ?? 0) > 0 ? { rested: rested.get(id)! } : {}),
      ...(expected.has(id) ? { expected: expected.get(id)! } : {}),
      ...(owing === undefined ? {} : { owed: { progress: owing.progress } }),
      ...(generation === undefined ? {} : { generation }),
      ...(stalls.has(id) ? { stalled: stalls.get(id)! } : {}),
      ...(back === undefined || back.size === 0 ? {} : { back: [...back] }),
      ...(reasons === undefined || reasons.size === 0
        ? {}
        : { blocks: Object.fromEntries(reasons) }),
      ...(records === undefined || records.size === 0
        ? {}
        : {
            kept: Object.fromEntries(
              [...records].map(([key, record]) => {
                const { saved: _, ...bare } = record;
                return [key, bare];
              }),
            ),
          }),
      ...(disk === undefined ? {} : { disk }),
      ...(was === undefined || was.length === 0 ? {} : { retired: was }),
    };
    return Object.keys(value).length === 0 ? undefined : value;
  };
  /**
   * Keeps the machine's marks as they are now, when they changed, with any whose save failed
   * before: every machine's at once, in one write. One that fails leaves them to the next change.
   */
  const persist = (id: HostId) => {
    if (persisted === undefined) return;
    const next = snapshot(id);
    if (JSON.stringify(next) !== JSON.stringify(stored.get(id))) unsaved.add(id);
    if (unsaved.size === 0) return;
    const all = new Map(stored);
    for (const each of unsaved) {
      const value = each === id ? next : snapshot(each);
      if (value === undefined) all.delete(each);
      else all.set(each, value);
    }
    try {
      persisted.save(Object.fromEntries(all));
    } catch (error) {
      persisted.failed?.(error);
      return;
    }
    stored.clear();
    for (const [each, value] of all) stored.set(each, value);
    unsaved.clear();
  };
  for (const [key, value] of Object.entries(persisted?.initial ?? {})) {
    const id = key as HostId;
    stored.set(id, value);
    if (value.stop !== undefined) marks.set(id, { ...value.stop });
    if (value.last !== undefined) last.set(id, value.last);
    if (value.rested !== undefined) rested.set(id, value.rested);
    if (value.expected !== undefined) expected.set(id, value.expected);
    if (value.generation !== undefined) generations.set(id, value.generation);
    // No resume runs in this process yet: one that ran before the restart is owed again, and the
    // time this Gram was down isn't time the resume made no progress in.
    if (value.owed !== undefined)
      owed.set(id, {
        progress: now(),
        running: 0,
        generation: value.generation ?? 0,
        completed: false,
      });
    if (value.stalled !== undefined) stalls.set(id, value.stalled);
    if (value.back !== undefined) threadsBack.set(id, new Set(value.back));
    if (value.blocks !== undefined)
      blocks.set(id, new Map(Object.entries(value.blocks) as Array<[ThreadId, string]>));
    if (value.kept !== undefined) kept.set(id, new Map(Object.entries(value.kept)));
    if (value.disk !== undefined) disks.set(id, { ...value.disk });
    if (value.retired !== undefined) retired.set(id, value.retired);
  }

  const settle = (id: HostId) => {
    owed.delete(id);
    threadsBack.delete(id);
    threadsAwaiting.delete(id);
  };
  /** The mark, unless its hold ran out with the machine there all along. */
  const markOf = (id: HostId) => {
    const mark = marks.get(id);
    if (mark === undefined || mark.left || now() - mark.at < holdMs) return mark;
    marks.delete(id);
    rested.delete(id);
    persist(id);
    return undefined;
  };
  /** Runs `change` on the machine's marks, then keeps them. */
  const changing =
    <A extends ReadonlyArray<unknown>, B>(change: (id: HostId, ...rest: A) => B) =>
    (id: HostId, ...rest: A): B => {
      const result = change(id, ...rest);
      persist(id);
      return result;
    };
  return {
    hello: changing(
      (
        id,
        said: { readonly diskId?: string | undefined; readonly bootId?: string | undefined },
      ): DiskVerdict => {
        if (said.diskId === undefined) return { kind: "unknown" };
        const was = retired.get(id) ?? [];
        if (was.includes(said.diskId)) return { kind: "fenced", why: "replaced" };
        const known = disks.get(id);
        const told = expected.get(id);
        // Told it comes back on another disk: the host of the one it leaves isn't it.
        if (known?.id === said.diskId && told !== undefined && now() - told < EXPECT_FOR_MS)
          return { kind: "fenced", why: "expected" };
        disks.set(id, {
          id: said.diskId,
          ...(said.bootId === undefined ? {} : { boot: said.bootId }),
          at: now(),
        });
        if (known === undefined) return { kind: "first" };
        if (known.id !== said.diskId) {
          // Its folders aren't on this disk: owed a resume before any session opens, kept in the
          // same write as the disk, so a restart never finds the one without the other.
          retired.set(
            id,
            [...was.filter((disk) => disk !== known.id), known.id].slice(-RETIRED_DISKS_KEPT),
          );
          owe(id);
          helloOwed.add(id);
          expected.delete(id);
          return { kind: "replaced", was: known.id };
        }
        return known.boot !== undefined && known.boot === said.bootId
          ? { kind: "redial" }
          : { kind: "restarted" };
      },
    ),
    disk: (id) => disks.get(id)?.id,
    keep: changing((id, threadId: ThreadId, cwd: string, record: KeptRecord) => {
      const records = kept.get(id) ?? new Map<string, KeptRecord>();
      const key = folder(threadId, cwd);
      records.delete(key);
      records.set(key, record);
      // The oldest kept first: past the limit, they go.
      for (const oldest of records.keys()) {
        if (records.size <= KEPT_FOLDERS_MAX) break;
        records.delete(oldest);
      }
      kept.set(id, records);
    }),
    keptOf: (id, threadId, cwd) => kept.get(id)?.get(folder(threadId, cwd)),
    stopped: changing((id, threads: ReadonlyArray<ThreadId>) => {
      // Readied again while still readied adds to the threads at rest; a new stop starts over.
      const before = markOf(id) === undefined ? [] : (rested.get(id) ?? []);
      marks.set(id, { at: now(), left: false });
      last.set(id, now());
      rested.set(id, [...new Set([...before, ...threads])]);
    }),
    stoppedAt: (id) => markOf(id)?.at,
    holding: (id) => markOf(id)?.left === false,
    recently: (id) => {
      const at = last.get(id);
      return at !== undefined && now() - at < holdMs + STOPPED_RECENTLY_MS;
    },
    away: changing((id) => {
      const mark = markOf(id);
      if (mark !== undefined) mark.left = true;
    }),
    back: changing((id) => {
      const told = expected.get(id);
      expected.delete(id);
      // Owed afresh: a resume that ran for the generation before counts for nothing now. One
      // `hello` already owed, for a new disk, isn't owed twice.
      const owedAtHello = helloOwed.delete(id);
      if (
        !owedAtHello &&
        (markOf(id)?.left === true || (told !== undefined && now() - told < EXPECT_FOR_MS))
      )
        owe(id);
      marks.delete(id);
    }),
    expect: changing((id) => {
      expected.set(id, now());
    }),
    resuming: (id) => {
      const state = owed.get(id);
      if (state === undefined || stalls.has(id)) return false;
      if (now() - state.progress < stallMs) return true;
      // No progress for too long: given up on, and said so (`stalled`), never opened silently.
      // Still owed: only a resume that completes settles it.
      stalls.set(id, now());
      persist(id);
      return false;
    },
    owes: (id) => owed.has(id),
    resumeRunning: (id) => (owed.get(id)?.running ?? 0) > 0,
    stalled: (id) => stalls.get(id),
    resumeStarted: changing((id) => {
      const state = owed.get(id);
      if (state === undefined) return generations.get(id) ?? 0;
      state.running++;
      state.progress = now();
      stalls.delete(id);
      return state.generation;
    }),
    progress: changing((id, generation?: number) => {
      const state = owed.get(id);
      if (state !== undefined && current(id, generation)) state.progress = now();
    }),
    resumed: (id, generation, completed = true) => {
      const state = owed.get(id);
      // Not owed, or owed afresh since it started (another disk): nothing of it counts.
      if (state === undefined || !current(id, generation)) return;
      state.running = Math.max(0, state.running - 1);
      if (completed) state.completed = true;
      if (state.running > 0 || !state.completed) {
        persist(id);
        return;
      }
      settle(id);
      stalls.delete(id);
      persist(id);
      ready(id);
    },
    threadBack: (id, threadId, generation) => {
      if (!current(id, generation)) return;
      blocks.get(id)?.delete(threadId);
      const before = threadsBack.get(id)?.has(threadId) === true;
      add(threadsBack, id, threadId);
      persist(id);
      if (!before) ready(id);
    },
    block: changing((id, threadId: ThreadId, reason: string, generation?: number) => {
      if (!current(id, generation)) return;
      threadsBack.get(id)?.delete(threadId);
      const reasons = blocks.get(id) ?? new Map<ThreadId, string>();
      reasons.set(threadId, reason);
      blocks.set(id, reasons);
    }),
    blocked: (id, threadId) => blocks.get(id)?.get(threadId),
    onReady: (listener) => {
      readyListeners.add(listener);
      return () => void readyListeners.delete(listener);
    },
    isThreadBack: (id, threadId) => threadsBack.get(id)?.has(threadId) === true,
    awaiting: (id, threadId) => add(threadsAwaiting, id, threadId),
    awaited: (id) => threadsAwaiting.get(id) ?? new Set(),
    cancel: changing((id) => {
      marks.delete(id);
      settle(id);
      stalls.delete(id);
      expected.delete(id);
      rested.delete(id);
      last.delete(id);
      cancels.set(id, (cancels.get(id) ?? 0) + 1);
    }),
    cancels: (id) => cancels.get(id) ?? 0,
    takeRested: changing((id) => {
      markOf(id);
      const threads = rested.get(id) ?? [];
      rested.delete(id);
      return threads;
    }),
    wanting: (id, effect) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const before = waiting.get(id) ?? 0;
          waiting.set(id, before + 1);
          if (before > 0) return;
          waitingSince.set(id, now());
          onWanted(id);
        }),
        () => effect,
        () =>
          Effect.sync(() => {
            const left = (waiting.get(id) ?? 1) - 1;
            if (left > 0) return void waiting.set(id, left);
            waiting.delete(id);
            waitingSince.delete(id);
            onWanted(id);
          }),
      ),
    wanted: (id) => (waiting.get(id) ?? 0) > 0,
    wantedSince: (id) => waitingSince.get(id),
    forget: changing((id) => {
      marks.delete(id);
      settle(id);
      stalls.delete(id);
      blocks.delete(id);
      expected.delete(id);
      last.delete(id);
      rested.delete(id);
      cancels.delete(id);
      kept.delete(id);
      disks.delete(id);
      retired.delete(id);
      generations.delete(id);
    }),
  };
};
