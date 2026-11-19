// What this Gram remembers of each joined machine's stops and restores (`stop-resume.ts`): one
// record per machine, for the disk and start of its host last seen (`HostHello.diskId`, `bootId`),
// holding whether it was readied to stop, which threads' sessions it put to rest, what each stop
// kept of a folder, and the resume it owes: under which generation, which threads' folders are
// confirmed back, which couldn't be, and which folders a resume set out to put back and didn't
// finish with. The record is kept across a restart of this Gram (`persisted`), written whole.
//
// The rules that keep a session from opening over folders that aren't there:
// - What lifts a debt (a thread's folders confirmed back, a resume completed, a thread at rest
//   reopened) is written before it is taken as so: when the write fails, nothing changes.
// - So is a host dialling in (`arrive`): a disk the record can't keep is refused, never admitted.
// - What only adds caution (a stop, a lost connection, an `expect`) holds at once, and its write
//   is tried again at the next change.
// - A record that can't be read is a debt (`unknown`): its threads wait for a resume.
// What waits on a machine now (`wanting`, `awaiting`), how many resumes run, and the diff behind a
// save are this process's alone.

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
import { RESUME_STALL_MS } from "./budgets.ts";
import { STOP_HOLD_MS } from "./stop.ts";

/** How long after a readied machine's hold its sessions are still waited for as a stopped one's. */
export const STOPPED_RECENTLY_MS = 15 * 60_000;
/**
 * How long a machine owed a resume may go with no restore progress (no resume started, no folder
 * done) before the sessions waiting on it give up, and say so. A resume under way always makes
 * progress sooner: each folder is done within `RESTORE_WITHIN` (20 minutes) of being started.
 * Only the end of its resume opens the machine to sessions; this never does.
 */
export { RESUME_STALL_MS };

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
 * How many disks a machine is remembered to have been replaced from, newest kept. Only remembered
 * for now: what would refuse a host that says one of them comes later, and finds them there.
 */
export const RETIRED_DISKS_KEPT = 64;

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
  /**
   * Owed a resume: when it last made progress, the generation it is owed under, and whether it is
   * owed because what was kept of the machine couldn't be read (`unknown`).
   */
  owed: Schema.optionalKey(
    Schema.Struct({
      progress: Schema.Number,
      generation: Schema.optionalKey(Schema.Int),
      unknown: Schema.optionalKey(Schema.Literal(true)),
      /** Owed for a disk other than the one its folders were last seen on: none is taken as is. */
      replaced: Schema.optionalKey(Schema.Literal(true)),
      /**
       * Folders a resume of this generation confirmed back (`folderDone`): checked once, never
       * again until the machine is owed afresh, though a resume after them didn't complete.
       */
      confirmed: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
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
  /** Disks it was replaced from, oldest first. */
  retired: Schema.optionalKey(Schema.Array(HostDiskId)),
  /** Folders a resume set out to put back and didn't finish with (`folderOwed`). */
  owedFolders: Schema.optionalKey(Schema.Array(Schema.String)),
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
 *   a resume puts them back. It is owed one from then, in the same change that remembers the disk.
 */
export type DiskVerdict =
  | { readonly kind: "unknown" | "first" | "redial" | "restarted" }
  | { readonly kind: "replaced"; readonly was: string };

/** What a change that lifts a debt, or a host's arrival, does when its record can't be written. */
export class MarksNotKept extends Error {
  constructor(cause: unknown) {
    super("The machine's stop and restore record couldn't be kept.", { cause });
  }
}

/** A record kept for a machine, before it is read: given to `makeStopMarks` for one unreadable. */
export const UNKNOWN_MARKS = (at: number): MachineMarks => ({
  owed: { progress: at, generation: 1, unknown: true },
  generation: 1,
});

export interface StopMarks {
  /**
   * A host of the machine dialled in and said this of its disk: what that makes it, and the
   * machine is no longer stopped (`back`), in one write. Owes it a resume on another disk, or
   * after it left while readied to stop, or when told it comes back on another disk. Throws
   * `MarksNotKept` when the record can't be written: the host is then not to come online.
   */
  readonly arrive: (
    id: HostId,
    said: {
      readonly diskId?: string | undefined;
      readonly bootId?: string | undefined;
      readonly diskUnknown?: true | undefined;
    },
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
   * The machine takes work again: it is no longer stopped. The threads rested for it are kept. One
   * that had left after it was readied, or was told to come back on another disk, is owed a
   * resume from then (`resuming`). As `arrive`, for a stop taken back or released.
   */
  readonly back: (id: HostId) => void;
  /**
   * The machine will dial in on another disk, whatever this Gram remembers of its stop (none, after
   * a restart): once it is back, it is owed a resume as one that left after a stop is. Throws
   * `MarksNotKept` when that can't be written.
   */
  readonly expect: (id: HostId) => void;
  /**
   * Its sessions wait for its resume: dialled in after a stop, or on another disk, and its threads
   * not yet resumed, until a resume of it completes on that disk. No timer and no cancel opens it.
   * When it goes `RESUME_STALL_MS` with no restore progress, `stalled` says since when, so what
   * waits on it is told rather than kept waiting; the gate stays shut.
   */
  readonly resuming: (id: HostId) => boolean;
  /** As `resuming`, without noting a stall: what whoever starts machines reads (`stopStatus`). */
  readonly owes: (id: HostId) => boolean;
  /** A resume of the machine, for the generation it owes now, runs. */
  readonly resumeRunning: (id: HostId) => boolean;
  /**
   * A resume of `generation` went through every folder: the machine owes nothing now, written
   * first. A no-op when it owes nothing or is owed afresh since; throws `MarksNotKept` when the
   * write fails, and it stays owed.
   */
  readonly settle: (id: HostId, generation: number) => void;
  /** Some thread's folders couldn't be put back on the machine (`block`), owed or not. */
  readonly anyBlocked: (id: HostId) => boolean;
  /**
   * The resume owed is for a disk the machine's folders weren't last seen on (replaced, unknown,
   * or what was kept couldn't be read): a folder there is checked against what was kept, never
   * taken as back for being there.
   */
  readonly onOtherDisk: (id: HostId) => boolean;
  /** Whether a resume that started under `generation` is still the machine's (`resumeStarted`). */
  readonly isCurrent: (id: HostId, generation: number) => boolean;
  /**
   * Since when the machine's owed resume has made no progress for `RESUME_STALL_MS`, while it is
   * owed and no resume has started since: sessions wanting it are told so at once, never opened.
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
   * While the machine is `resuming`: this thread's folders are confirmed back, so its session may
   * open before the others' are. Lifts a block a resume before put on it. Throws `MarksNotKept`
   * when that can't be written: the thread then stays owed.
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
  /**
   * A resume found the folder `cwd` missing and set out to put it back: until a resume is done
   * with it (`folderDone`), a later one asks the host for it again, though the path is there by
   * then. Another folder's restore may have made it (a worktree makes its clone) without the
   * thread's own work in it.
   */
  readonly folderOwed: (id: HostId, cwd: string, generation?: number) => void;
  /**
   * A resume confirmed the folder back, put back or there: no longer owed, and, while the machine
   * owes this generation, not checked again (`isFolderConfirmed`). Throws `MarksNotKept` when that
   * can't be written: it stays owed, and is checked again.
   */
  readonly folderDone: (id: HostId, cwd: string, generation?: number) => void;
  /** Whether a resume set out to put the folder back and didn't finish with it. */
  readonly isFolderOwed: (id: HostId, cwd: string) => boolean;
  /** Whether a resume of the generation the machine owes now confirmed the folder back. */
  readonly isFolderConfirmed: (id: HostId, cwd: string) => boolean;
  /** A session of this thread waits for the machine's resume: its folders go first. */
  readonly awaiting: (id: HostId, threadId: ThreadId) => void;
  /** The threads a session waits on the machine's resume for, as `awaiting` said. */
  readonly awaited: (id: HostId) => ReadonlySet<ThreadId>;
  /** The stop was taken back: nothing is remembered of it, but a resume owed stays owed. */
  readonly cancel: (id: HostId) => void;
  /** How many times the machine's stops were taken back. */
  readonly cancels: (id: HostId) => number;
  /** The threads put to rest for the machine's last stop, until each is reopened (`restedDone`). */
  readonly restedOf: (id: HostId) => ReadonlyArray<ThreadId>;
  /**
   * A resume of `generation` reopened the thread put to rest (or found it gone): it leaves the
   * list. Throws `MarksNotKept` when that can't be written, and nothing changes.
   */
  readonly restedDone: (id: HostId, threadId: ThreadId, generation: number) => void;
  /** Runs `effect` as something that waits on the machine to be started. */
  readonly wanting: <A, E, R>(id: HostId, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Whether anything waits on the machine to be started now. */
  readonly wanted: (id: HostId) => boolean;
  /** Since when something has waited on the machine to be started, while anything does. */
  readonly wantedSince: (id: HostId) => number | undefined;
  /** The machine was removed: nothing is remembered of it. */
  readonly forget: (id: HostId) => void;
}

/** One folder of one thread, as a key. */
const folder = (threadId: ThreadId, cwd: string) => `${threadId}\0${cwd}`;

/** A record as kept: what is empty left out, nothing at all when nothing is kept. */
const tidy = (record: MachineMarks): MachineMarks | undefined => {
  const value: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(record)) {
    if (field === undefined) continue;
    if (Array.isArray(field) && field.length === 0) continue;
    if (typeof field === "object" && !Array.isArray(field) && Object.keys(field).length === 0)
      continue;
    value[key] = field;
  }
  return Object.keys(value).length === 0 ? undefined : (value as MachineMarks);
};

export const makeStopMarks = (
  now: () => number = Date.now,
  holdMs: number = STOP_HOLD_MS,
  /** Told when a machine starts or stops being waited on (`wantedSince`). */
  onWanted: (id: HostId) => void = () => {},
  stallMs: number = RESUME_STALL_MS,
  /**
   * Where the records are kept across a restart: those kept before, and where each change goes,
   * every machine's at once. Kept in memory alone when left out.
   */
  persisted?: {
    readonly initial: MachineMarksByHost;
    /** Throws when the records couldn't be kept. */
    readonly save: (all: MachineMarksByHost) => void;
    readonly failed?: (error: unknown) => void;
  },
): StopMarks => {
  /** Each machine's record, as this process holds it. */
  const records = new Map<HostId, MachineMarks>();
  /** How many resumes run now, by machine and by the generation each runs for. */
  const running = new Map<HostId, Map<number, number>>();
  const savedDiffs = new Map<HostId, Map<string, SavedDiff>>();
  const waiting = new Map<HostId, number>();
  const waitingSince = new Map<HostId, number>();
  const cancels = new Map<HostId, number>();
  const threadsAwaiting = new Map<HostId, Set<ThreadId>>();
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
  for (const [key, value] of Object.entries(persisted?.initial ?? {})) {
    // The time this Gram was down isn't time a resume made no progress in.
    records.set(
      key as HostId,
      value.owed === undefined ? value : { ...value, owed: { ...value.owed, progress: now() } },
    );
  }

  const get = (id: HostId): MachineMarks => records.get(id) ?? {};
  const put = (into: Map<HostId, MachineMarks>, id: HostId, next: MachineMarks) => {
    const value = tidy(next);
    if (value === undefined) into.delete(id);
    else into.set(id, value);
  };
  /** Writes every record, with the machine's as `next`; throws when that fails. */
  const save = (id: HostId, next: MachineMarks) => {
    const all = new Map(records);
    put(all, id, next);
    persisted?.save(Object.fromEntries(all));
  };
  /**
   * A change that lifts a debt, or a host's arrival: written first, and only then taken as so.
   * When the write fails, nothing changes and `MarksNotKept` is thrown.
   */
  const commit = (id: HostId, next: MachineMarks) => {
    try {
      save(id, next);
    } catch (error) {
      persisted?.failed?.(error);
      throw new MarksNotKept(error);
    }
    put(records, id, next);
  };
  /**
   * A change that only adds caution: it holds at once. A write that fails leaves it to the next
   * write, which writes every record as this process holds it.
   */
  const note = (id: HostId, next: MachineMarks) => {
    put(records, id, next);
    try {
      save(id, get(id));
    } catch (error) {
      persisted?.failed?.(error);
    }
  };

  /** The stop mark, unless its hold ran out with the machine there all along. */
  const stopOf = (record: MachineMarks) => {
    const stop = record.stop;
    return stop === undefined || stop.left || now() - stop.at < holdMs ? stop : undefined;
  };
  /** The threads at rest, unless the stop they were put to rest for didn't hold. */
  const restedIn = (record: MachineMarks): ReadonlyArray<ThreadId> =>
    record.stop !== undefined && stopOf(record) === undefined ? [] : (record.rested ?? []);
  const generationOf = (record: MachineMarks) => record.owed?.generation ?? record.generation ?? 0;
  const current = (id: HostId, generation: number | undefined) =>
    generation === undefined || generationOf(get(id)) === generation;
  /** The record owing a resume afresh: a new generation, nothing back yet, no stall. */
  const owe = (record: MachineMarks): MachineMarks => {
    const generation = (record.generation ?? 0) + 1;
    const { back: _, stalled: __, ...rest } = record;
    return { ...rest, generation, owed: { progress: now(), generation } };
  };
  /** As `owe`, for a disk its folders weren't last seen on. */
  const oweOnOtherDisk = (record: MachineMarks): MachineMarks => {
    const owing = owe(record);
    return { ...owing, owed: { ...owing.owed!, replaced: true } };
  };
  /** The record once the machine takes work again (`back`). */
  const backOf = (record: MachineMarks): MachineMarks => {
    const told = record.expected;
    const { stop: _, expected: __, ...rest } = record;
    const owes =
      record.owed === undefined &&
      (stopOf(record)?.left === true || (told !== undefined && now() - told < EXPECT_FOR_MS));
    // The threads at rest stay for the resume, unless the stop they were for didn't hold.
    const kept = { ...rest, rested: restedIn(record) };
    return owes ? owe(kept) : kept;
  };

  const stopMarks: StopMarks = {
    arrive: (id, said) => {
      let record = get(id);
      let verdict: DiskVerdict = { kind: "unknown" };
      if (said.diskId !== undefined) {
        const known = record.disk;
        record = {
          ...record,
          disk: {
            id: said.diskId,
            ...(said.bootId === undefined ? {} : { boot: said.bootId }),
            at: now(),
          },
        };
        if (known === undefined) verdict = { kind: "first" };
        else if (known.id !== said.diskId) {
          // Its folders aren't on this disk: owed a resume before any session opens, in the same
          // write as the disk, so a restart never finds the one without the other.
          const { expected: _, ...rest } = record;
          record = oweOnOtherDisk({
            ...rest,
            retired: [...(rest.retired ?? []).filter((disk) => disk !== known.id), known.id].slice(
              -RETIRED_DISKS_KEPT,
            ),
          });
          verdict = { kind: "replaced", was: known.id };
        } else
          verdict =
            known.boot !== undefined && known.boot === said.bootId
              ? { kind: "redial" }
              : { kind: "restarted" };
        // A disk the host can't say is the same from one start to the next owes a resume at each
        // start, the first one too; a redial of the same start only picks up its connection.
        if (said.diskUnknown === true && verdict.kind !== "redial" && record.owed === undefined)
          record = oweOnOtherDisk(record);
      }
      commit(id, backOf(record));
      return verdict;
    },
    disk: (id) => get(id).disk?.id,
    keep: (id, threadId, cwd, record) => {
      const key = folder(threadId, cwd);
      const { saved, ...bare } = record;
      const diffs = savedDiffs.get(id) ?? new Map<string, SavedDiff>();
      if (saved === undefined) diffs.delete(key);
      else diffs.set(key, saved);
      savedDiffs.set(id, diffs);
      // The oldest kept first: past the limit, they go.
      const entries = Object.entries(get(id).kept ?? {}).filter(([each]) => each !== key);
      entries.push([key, bare]);
      note(id, { ...get(id), kept: Object.fromEntries(entries.slice(-KEPT_FOLDERS_MAX)) });
    },
    keptOf: (id, threadId, cwd) => {
      const key = folder(threadId, cwd);
      const bare = get(id).kept?.[key];
      if (bare === undefined) return undefined;
      const saved = savedDiffs.get(id)?.get(key);
      return saved === undefined ? bare : { ...bare, saved };
    },
    stopped: (id, threads) => {
      const record = get(id);
      // Readied again while still readied adds to the threads at rest; a new stop starts over.
      const before = stopOf(record) === undefined ? [] : (record.rested ?? []);
      note(id, {
        ...record,
        stop: { at: now(), left: false },
        last: now(),
        rested: [...new Set([...before, ...threads])],
      });
    },
    stoppedAt: (id) => stopOf(get(id))?.at,
    holding: (id) => stopOf(get(id))?.left === false,
    recently: (id) => {
      const at = get(id).last;
      return at !== undefined && now() - at < holdMs + STOPPED_RECENTLY_MS;
    },
    away: (id) => {
      const record = get(id);
      const stop = stopOf(record);
      if (stop !== undefined && !stop.left) note(id, { ...record, stop: { ...stop, left: true } });
    },
    back: (id) => note(id, backOf(get(id))),
    // Written first: whoever said it is told when it didn't hold.
    expect: (id) => commit(id, { ...get(id), expected: now() }),
    resuming: (id) => {
      const record = get(id);
      if (record.owed === undefined) return false;
      // No progress for too long: said (`stalled`), so whatever waits on it stops waiting. The
      // gate stays shut: only a resume that completes opens it.
      if (record.stalled === undefined && now() - record.owed.progress >= stallMs)
        note(id, { ...record, stalled: now() });
      return true;
    },
    owes: (id) => get(id).owed !== undefined,
    resumeRunning: (id) => (running.get(id)?.get(generationOf(get(id))) ?? 0) > 0,
    settle: (id, generation) => {
      const record = get(id);
      if (record.owed === undefined || !current(id, generation)) return;
      const { owed: _, back: __, stalled: ___, ...rest } = record;
      commit(id, rest);
      threadsAwaiting.delete(id);
      ready(id);
    },
    anyBlocked: (id) => Object.keys(get(id).blocks ?? {}).length > 0,
    onOtherDisk: (id) => {
      const owed = get(id).owed;
      return owed?.replaced === true || owed?.unknown === true;
    },
    isCurrent: (id, generation) => current(id, generation),
    stalled: (id) => (get(id).owed === undefined ? undefined : get(id).stalled),
    resumeStarted: (id) => {
      const record = get(id);
      const generation = generationOf(record);
      const runs = running.get(id) ?? new Map<number, number>();
      runs.set(generation, (runs.get(generation) ?? 0) + 1);
      running.set(id, runs);
      if (record.owed !== undefined) {
        const { stalled: _, ...rest } = record;
        note(id, { ...rest, owed: { ...record.owed, progress: now() } });
      }
      return generation;
    },
    progress: (id, generation) => {
      const record = get(id);
      if (record.owed !== undefined && current(id, generation))
        note(id, { ...record, owed: { ...record.owed, progress: now() } });
    },
    resumed: (id, generation, completed = true) => {
      // Counted off the generation it ran for, whatever the machine owes now: a resume of a disk
      // the machine has since left never keeps the next one from starting.
      const runs = running.get(id);
      const of = generation ?? generationOf(get(id));
      const count = (runs?.get(of) ?? 1) - 1;
      if (runs !== undefined) {
        if (count > 0) runs.set(of, count);
        else runs.delete(of);
        if (runs.size === 0) running.delete(id);
      }
      if (!completed) return;
      try {
        if (generation !== undefined) stopMarks.settle(id, generation);
        else stopMarks.settle(id, of);
      } catch {
        // Not written, so still owed: the next resume settles it.
      }
    },
    threadBack: (id, threadId, generation) => {
      if (!current(id, generation)) return;
      const record = get(id);
      const before = record.back?.includes(threadId) === true;
      const { [threadId]: _, ...blocks } = record.blocks ?? {};
      commit(id, {
        ...record,
        blocks,
        back: before ? record.back : [...(record.back ?? []), threadId],
      });
      if (!before) ready(id);
    },
    block: (id, threadId, reason, generation) => {
      if (!current(id, generation)) return;
      const record = get(id);
      note(id, {
        ...record,
        back: (record.back ?? []).filter((each) => each !== threadId),
        blocks: { ...record.blocks, [threadId]: reason },
      });
    },
    blocked: (id, threadId) => get(id).blocks?.[threadId],
    onReady: (listener) => {
      readyListeners.add(listener);
      return () => void readyListeners.delete(listener);
    },
    isThreadBack: (id, threadId) => get(id).back?.includes(threadId) === true,
    folderOwed: (id, cwd, generation) => {
      if (!current(id, generation)) throw new MarksNotKept("The machine is owed afresh.");
      const record = get(id);
      if (record.owedFolders?.includes(cwd) === true) return;
      // Written before anything is put back there: a restart finds it owed, whatever was made.
      commit(id, { ...record, owedFolders: [...(record.owedFolders ?? []), cwd] });
    },
    folderDone: (id, cwd, generation) => {
      if (!current(id, generation)) return;
      const record = get(id);
      const owedThere = record.owedFolders?.includes(cwd) === true;
      // Only where a folder there is checked (`onOtherDisk`): elsewhere being there is enough.
      const owed = record.owed;
      const confirm =
        owed !== undefined &&
        (owed.replaced === true || owed.unknown === true) &&
        owed.confirmed?.includes(cwd) !== true;
      if (!owedThere && !confirm) return;
      // Lifts a debt: written first, the folder and its confirmation together.
      commit(id, {
        ...record,
        ...(owedThere
          ? { owedFolders: (record.owedFolders ?? []).filter((each) => each !== cwd) }
          : {}),
        ...(confirm && record.owed !== undefined
          ? { owed: { ...record.owed, confirmed: [...(record.owed.confirmed ?? []), cwd] } }
          : {}),
      });
    },
    isFolderOwed: (id, cwd) => get(id).owedFolders?.includes(cwd) === true,
    isFolderConfirmed: (id, cwd) => get(id).owed?.confirmed?.includes(cwd) === true,
    awaiting: (id, threadId) => {
      const set = threadsAwaiting.get(id) ?? new Set<ThreadId>();
      set.add(threadId);
      threadsAwaiting.set(id, set);
    },
    awaited: (id) => threadsAwaiting.get(id) ?? new Set(),
    cancel: (id) => {
      // The stop is taken back; a resume the machine owes stays owed: its folders may not be
      // there, whatever became of the stop.
      const { stop: _, expected: __, rested: ___, last: ____, ...rest } = get(id);
      cancels.set(id, (cancels.get(id) ?? 0) + 1);
      commit(id, rest);
    },
    cancels: (id) => cancels.get(id) ?? 0,
    restedOf: (id) => restedIn(get(id)),
    restedDone: (id, threadId, generation) => {
      if (!current(id, generation)) throw new MarksNotKept("The machine is owed afresh.");
      const record = get(id);
      commit(id, { ...record, rested: restedIn(record).filter((each) => each !== threadId) });
    },
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
    forget: (id) => {
      cancels.delete(id);
      running.delete(id);
      savedDiffs.delete(id);
      threadsAwaiting.delete(id);
      // What was kept of a machine removed: one left in the file is dropped at the next start.
      note(id, {});
    },
  };
  return stopMarks;
};
