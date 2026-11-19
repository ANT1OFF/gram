// What this Gram remembers, while it runs, of the machines it readied to stop (`stop-resume.ts`):
// which are stopped, which threads' sessions it put to rest for the stop, what each stop said it
// kept of a folder, and which stopped machines a thread is waiting on now. Nothing here is kept
// across a restart: a thread asking for a machine that is away says so again, and whoever asks
// for a resume names what the stop kept (its answer) when it is to be held to that.

import {
  effectiveCheckout,
  hostOf,
  LOCAL_HOST_ID,
  type HostId,
  type SavedDiff,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { STOP_HOLD_MS } from "./stop.ts";

/** How long after a readied machine's hold its sessions are still waited for as a stopped one's. */
export const STOPPED_RECENTLY_MS = 15 * 60_000;
/**
 * How long a machine that dialled in after a stop is waited on to have its threads resumed
 * (`resumeHost`) before sessions open on it anyway: a host on another disk gets its folders back
 * there, and a session opened before then finds its folder missing.
 */
export const RESUME_WAIT_MS = 3 * 60_000;

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

export interface StopMarks {
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
   * had left after it was readied is owed a resume from then (`resuming`).
   */
  readonly back: (id: HostId) => void;
  /**
   * The machine will dial in on another disk, whatever this Gram remembers of its stop (none, after
   * a restart): once it is back, it is owed a resume as one that left after a stop is.
   */
  readonly expect: (id: HostId) => void;
  /** Dialled in after a stop, its threads not yet resumed, within `RESUME_WAIT_MS`. */
  readonly resuming: (id: HostId) => boolean;
  /** Its threads were resumed, or the resume gave up: sessions open on it as on any machine. */
  readonly resumed: (id: HostId) => void;
  /**
   * While the machine is `resuming`: this thread's folders are back (or the resume is done with
   * them), so its session may open before the others' are.
   */
  readonly threadBack: (id: HostId, threadId: ThreadId) => void;
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
  resumeWaitMs: number = RESUME_WAIT_MS,
): StopMarks => {
  const marks = new Map<HostId, { readonly at: number; left: boolean }>();
  const last = new Map<HostId, number>();
  const rested = new Map<HostId, ReadonlyArray<ThreadId>>();
  const waiting = new Map<HostId, number>();
  const waitingSince = new Map<HostId, number>();
  const cancels = new Map<HostId, number>();
  const kept = new Map<HostId, Map<string, KeptRecord>>();
  const owed = new Map<HostId, number>();
  /** Told to come back on another disk (`expect`), since when. */
  const expected = new Map<HostId, number>();
  const threadsBack = new Map<HostId, Set<ThreadId>>();
  const threadsAwaiting = new Map<HostId, Set<ThreadId>>();
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
    return undefined;
  };
  return {
    keep: (id, threadId, cwd, record) => {
      const records = kept.get(id) ?? new Map<string, KeptRecord>();
      records.set(folder(threadId, cwd), record);
      kept.set(id, records);
    },
    keptOf: (id, threadId, cwd) => kept.get(id)?.get(folder(threadId, cwd)),
    stopped: (id, threads) => {
      // Readied again while still readied adds to the threads at rest; a new stop starts over.
      const before = markOf(id) === undefined ? [] : (rested.get(id) ?? []);
      marks.set(id, { at: now(), left: false });
      last.set(id, now());
      rested.set(id, [...new Set([...before, ...threads])]);
    },
    stoppedAt: (id) => markOf(id)?.at,
    holding: (id) => markOf(id)?.left === false,
    recently: (id) => {
      const at = last.get(id);
      return at !== undefined && now() - at < holdMs + STOPPED_RECENTLY_MS;
    },
    away: (id) => {
      const mark = markOf(id);
      if (mark !== undefined) mark.left = true;
    },
    back: (id) => {
      const told = expected.get(id);
      expected.delete(id);
      if (markOf(id)?.left === true || (told !== undefined && now() - told < EXPECT_FOR_MS)) {
        owed.set(id, now());
        threadsBack.delete(id);
      }
      marks.delete(id);
    },
    expect: (id) => {
      expected.set(id, now());
    },
    resuming: (id) => {
      const at = owed.get(id);
      if (at === undefined) return false;
      if (now() - at < resumeWaitMs) return true;
      settle(id);
      return false;
    },
    resumed: settle,
    threadBack: (id, threadId) => add(threadsBack, id, threadId),
    isThreadBack: (id, threadId) => threadsBack.get(id)?.has(threadId) === true,
    awaiting: (id, threadId) => add(threadsAwaiting, id, threadId),
    awaited: (id) => threadsAwaiting.get(id) ?? new Set(),
    cancel: (id) => {
      marks.delete(id);
      settle(id);
      expected.delete(id);
      rested.delete(id);
      last.delete(id);
      cancels.set(id, (cancels.get(id) ?? 0) + 1);
    },
    cancels: (id) => cancels.get(id) ?? 0,
    takeRested: (id) => {
      markOf(id);
      const threads = rested.get(id) ?? [];
      rested.delete(id);
      return threads;
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
      marks.delete(id);
      settle(id);
      expected.delete(id);
      last.delete(id);
      rested.delete(id);
      cancels.delete(id);
      kept.delete(id);
    },
  };
};
