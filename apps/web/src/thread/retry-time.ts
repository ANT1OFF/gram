import type { ModelRef, ThreadError } from "@gram/contracts";
import { create } from "zustand";

import { currentLimit, LIMIT_WINDOWS, limitSpent, type UsageLimits } from "@/stores/usage-limits";

/**
 * When a rate-limited turn may go through again, as the provider said it: the reset of the
 * subscription window the provider reported spent for the thread's agent. The latest such reset,
 * since a turn needs every spent window back. `undefined` when no time is known: another failure, a
 * thread on a gateway profile (whose quota the subscription readings don't describe), or no spent
 * window with a reset still ahead. Never a guess: a 429 the provider gave no time for stays
 * unknown.
 */
export function retryTimeOf(
  error: Pick<ThreadError, "kind">,
  model: Pick<ModelRef, "agent" | "profileId"> | undefined,
  limits: UsageLimits,
  now: number,
): number | undefined {
  if (error.kind !== "rateLimit" || model === undefined || model.profileId !== undefined) return;
  const windows = limits[model.agent];
  if (windows === undefined) return undefined;
  let latest: number | undefined;
  for (const window of LIMIT_WINDOWS) {
    const limit = currentLimit(windows[window], now);
    if (limit === undefined || !limitSpent(limit) || limit.resetsAt === undefined) continue;
    if (limit.resetsAt <= now) continue;
    latest = latest === undefined ? limit.resetsAt : Math.max(latest, limit.resetsAt);
  }
  return latest;
}

/** A failed turn's key for a scheduled retry: the thread and the failure's own time. */
export const retryKey = (threadId: string, error: Pick<ThreadError, "at">): string =>
  `${threadId}:${error.at}`;

/** Past the reset by this much, so the retry doesn't land a moment before the window opens. */
export const AFTER_RESET_MS = 30_000;

/** How long "Retry automatically" waits before it sends a rate-limited turn again. */
export const AUTO_RETRY_MS = 30_000;

/** The longest `setTimeout` takes; a later time is waited for in steps. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

const timers = new Map<string, ReturnType<typeof setTimeout>>();

interface RetrySchedule {
  /** By `retryKey`, when the retry is due, epoch ms. */
  readonly due: Readonly<Record<string, number>>;
  /**
   * Runs `run` once `at` and `margin` after it have passed (by default `AFTER_RESET_MS`, as `at` is
   * a provider's reset), while Gram stays open: an app that quits forgets it, and the card says so.
   * Replaces an earlier schedule for the same key.
   */
  schedule(key: string, at: number, run: () => void, margin?: number): void;
  cancel(key: string): void;
}

/**
 * Retries the user set on a failed turn's card: at a provider's reset ("Retry at 11:15"), or
 * `AUTO_RETRY_MS` from now ("Retry automatically in 30 s"). Kept outside the card, so a transcript
 * row scrolled out of view, which unmounts, doesn't drop it.
 */
export const useRetrySchedule = create<RetrySchedule>()((set, get) => ({
  due: {},
  schedule: (key, at, run, margin = AFTER_RESET_MS) => {
    get().cancel(key);
    const due = at + margin;
    const wait = () => {
      const left = due - Date.now();
      if (left > 0) {
        timers.set(key, setTimeout(wait, Math.min(left, MAX_TIMEOUT_MS)));
        return;
      }
      timers.delete(key);
      set((s) => {
        const { [key]: _done, ...rest } = s.due;
        return { due: rest };
      });
      run();
    };
    set((s) => ({ due: { ...s.due, [key]: due } }));
    wait();
  },
  cancel: (key) => {
    const timer = timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(key);
    if (get().due[key] === undefined) return;
    set((s) => {
      const { [key]: _gone, ...rest } = s.due;
      return { due: rest };
    });
  },
}));
