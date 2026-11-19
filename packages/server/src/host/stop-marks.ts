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
  /**
   * Dialled in after a stop and its threads not yet resumed: until its resume ends, or it goes
   * `RESUME_STALL_MS` with no restore progress (`stalled` then says since when).
   */
  readonly resuming: (id: HostId) => boolean;
  /**
   * When the machine's owed resume was given up on for making no progress, while nothing newer
   * is owed: the sessions that waited for it are told so, rather than opened.
   */
  readonly stalled: (id: HostId) => number | undefined;
  /** A resume of the machine starts: its folders are being put back. */
  readonly resumeStarted: (id: HostId) => void;
  /** One of the machine's folders is done with by its resume, put back or not. */
  readonly progress: (id: HostId) => void;
  /**
   * A resume of the machine ended. Once none is running, sessions open on it as on any machine,
   * but those of `blocked` threads.
   */
  readonly resumed: (id: HostId) => void;
  /**
   * While the machine is `resuming`: this thread's folders are back, so its session may open
   * before the others' are. Lifts a block a resume before put on it.
   */
  readonly threadBack: (id: HostId, threadId: ThreadId) => void;
  /**
   * A resume couldn't put this thread's folder back (missing, or refused): its session doesn't open
   * on the machine, now or once the resume ends, until a later resume puts it back.
   */
  readonly block: (id: HostId, threadId: ThreadId, reason: string) => void;
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
): StopMarks => {
  const marks = new Map<HostId, { readonly at: number; left: boolean }>();
  const last = new Map<HostId, number>();
  const rested = new Map<HostId, ReadonlyArray<ThreadId>>();
  const waiting = new Map<HostId, number>();
  const waitingSince = new Map<HostId, number>();
  const cancels = new Map<HostId, number>();
  const kept = new Map<HostId, Map<string, KeptRecord>>();
  /** Owed a resume: since when the last progress was made, and how many resumes run now. */
  const owed = new Map<HostId, { progress: number; running: number }>();
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
        // A resume already running for it goes on counting.
        owed.set(id, { progress: now(), running: owed.get(id)?.running ?? 0 });
        stalls.delete(id);
        threadsBack.delete(id);
      }
      marks.delete(id);
    },
    expect: (id) => {
      expected.set(id, now());
    },
    resuming: (id) => {
      const state = owed.get(id);
      if (state === undefined) return false;
      if (now() - state.progress < stallMs) return true;
      // No progress for too long: given up on, and said so (`stalled`), never opened silently.
      settle(id);
      stalls.set(id, now());
      return false;
    },
    stalled: (id) => stalls.get(id),
    resumeStarted: (id) => {
      const state = owed.get(id);
      if (state === undefined) return;
      state.running++;
      state.progress = now();
    },
    progress: (id) => {
      const state = owed.get(id);
      if (state !== undefined) state.progress = now();
    },
    resumed: (id) => {
      const state = owed.get(id);
      if (state !== undefined && state.running > 1) {
        state.running--;
        state.progress = now();
        return;
      }
      const was = state !== undefined;
      settle(id);
      stalls.delete(id);
      if (was) ready(id);
    },
    threadBack: (id, threadId) => {
      blocks.get(id)?.delete(threadId);
      const before = threadsBack.get(id)?.has(threadId) === true;
      add(threadsBack, id, threadId);
      if (!before) ready(id);
    },
    block: (id, threadId, reason) => {
      threadsBack.get(id)?.delete(threadId);
      const reasons = blocks.get(id) ?? new Map<ThreadId, string>();
      reasons.set(threadId, reason);
      blocks.set(id, reasons);
    },
    blocked: (id, threadId) => blocks.get(id)?.get(threadId),
    onReady: (listener) => {
      readyListeners.add(listener);
      return () => void readyListeners.delete(listener);
    },
    isThreadBack: (id, threadId) => threadsBack.get(id)?.has(threadId) === true,
    awaiting: (id, threadId) => add(threadsAwaiting, id, threadId),
    awaited: (id) => threadsAwaiting.get(id) ?? new Set(),
    cancel: (id) => {
      marks.delete(id);
      settle(id);
      stalls.delete(id);
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
      stalls.delete(id);
      blocks.delete(id);
      expected.delete(id);
      last.delete(id);
      rested.delete(id);
      cancels.delete(id);
      kept.delete(id);
    },
  };
};
