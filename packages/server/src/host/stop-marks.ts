// What this Gram remembers, while it runs, of the machines it readied to stop (`stop-resume.ts`):
// which are stopped, which threads' sessions it put to rest for the stop, what each stop said it
// kept of a folder, and which stopped machines a thread is waiting on now. Nothing here is kept
// across a restart: a thread asking for a machine that is away says so again, and whoever asks
// for a resume names what the stop kept (its answer) when it is to be held to that.

import type { HostId, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { STOP_HOLD_MS } from "./stop.ts";

/** How long after a readied machine's hold its sessions are still waited for as a stopped one's. */
export const STOPPED_RECENTLY_MS = 15 * 60_000;

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
  /** The machine dialled in: it is no longer stopped. The threads rested for it are kept. */
  readonly back: (id: HostId) => void;
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
  /** The machine was removed: nothing is remembered of it. */
  readonly forget: (id: HostId) => void;
}

/** One folder of one thread, as a key. */
const folder = (threadId: ThreadId, cwd: string) => `${threadId}\0${cwd}`;

export const makeStopMarks = (
  now: () => number = Date.now,
  holdMs: number = STOP_HOLD_MS,
): StopMarks => {
  const marks = new Map<HostId, { readonly at: number; left: boolean }>();
  const last = new Map<HostId, number>();
  const rested = new Map<HostId, ReadonlyArray<ThreadId>>();
  const waiting = new Map<HostId, number>();
  const cancels = new Map<HostId, number>();
  const kept = new Map<HostId, Map<string, KeptRecord>>();
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
      markOf(id);
      marks.delete(id);
    },
    cancel: (id) => {
      marks.delete(id);
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
        Effect.sync(() => void waiting.set(id, (waiting.get(id) ?? 0) + 1)),
        () => effect,
        () =>
          Effect.sync(() => {
            const left = (waiting.get(id) ?? 1) - 1;
            if (left <= 0) waiting.delete(id);
            else waiting.set(id, left);
          }),
      ),
    wanted: (id) => (waiting.get(id) ?? 0) > 0,
    forget: (id) => {
      marks.delete(id);
      last.delete(id);
      rested.delete(id);
      cancels.delete(id);
      kept.delete(id);
    },
  };
};
