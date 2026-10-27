import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** How long "Snooze 1 day" keeps a worker's "Why is it stuck?" away. */
export const STUCK_SNOOZE_MS = 24 * 60 * 60 * 1000;

/** Snoozes remembered at most; the soonest to end go first. */
const SNOOZE_LIMIT = 200;

type Snoozes = Readonly<Record<string, number>>;

/** Only snoozes still running at `now`, as thread id → epoch ms they end, the latest kept. */
export const liveSnoozes = (raw: unknown, now: number): Record<string, number> => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const live = Object.entries(raw as Record<string, unknown>).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > now,
  );
  return Object.fromEntries(live.toSorted((a, b) => a[1] - b[1]).slice(-SNOOZE_LIMIT));
};

/** Whether `threadId`'s card is snoozed at `now`. */
export const snoozed = (snoozes: Snoozes, threadId: ThreadId, now: number): boolean =>
  (snoozes[threadId] ?? 0) > now;

interface StuckSnoozeState {
  /** Thread id → epoch ms its snooze ends. */
  until: Snoozes;
  snooze(threadId: ThreadId, now: number): void;
}

/** Workers whose "Why is it stuck?" is snoozed, kept on this machine only. */
export const useStuckSnoozes = create<StuckSnoozeState>()(
  persist(
    (set) => ({
      until: {},
      snooze: (threadId, now) =>
        set((s) => ({
          until: liveSnoozes({ ...s.until, [threadId]: now + STUCK_SNOOZE_MS }, now),
        })),
    }),
    {
      name: "gram.stuckSnooze",
      version: 1,
      // `window`, not `globalThis`: under Node, reading `globalThis.localStorage` warns that it has no
      // backing file, while a missing `window` throws, which zustand takes as no storage.
      storage: createJSONStorage(() => window.localStorage),
      partialize: ({ until }) => ({ until }),
      merge: (persisted, current) => ({
        ...current,
        until: liveSnoozes((persisted as { until?: unknown } | undefined)?.until, Date.now()),
      }),
    },
  ),
);
