import { useEffect, useState, type RefObject } from "react";

import { outOfSight } from "@/motion";

/**
 * One timer per interval, shared by every `useNow` on it: forty sidebar rows on a 30 s clock wake the
 * renderer once every 30 s and render in one commit, not forty times at forty moments. The timers
 * stop while the window is hidden and tick once when it is shown again.
 */
const clocks = new Map<
  number,
  { listeners: Set<() => void>; timer: ReturnType<typeof setInterval> | undefined }
>();

const start = (intervalMs: number) => {
  const clock = clocks.get(intervalMs);
  if (!clock || clock.timer !== undefined) return;
  clock.timer = setInterval(() => {
    for (const listener of clock.listeners) listener();
  }, intervalMs);
};

const stop = (intervalMs: number) => {
  const clock = clocks.get(intervalMs);
  if (clock?.timer === undefined) return;
  clearInterval(clock.timer);
  clock.timer = undefined;
};

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    for (const [intervalMs, clock] of clocks) {
      if (document.hidden) {
        stop(intervalMs);
        continue;
      }
      for (const listener of clock.listeners) listener();
      start(intervalMs);
    }
  });
}

const subscribe = (intervalMs: number, listener: () => void) => {
  let clock = clocks.get(intervalMs);
  if (!clock) {
    clock = { listeners: new Set(), timer: undefined };
    clocks.set(intervalMs, clock);
  }
  clock.listeners.add(listener);
  if (!document.hidden) start(intervalMs);
  return () => {
    clock.listeners.delete(listener);
    if (clock.listeners.size > 0) return;
    stop(intervalMs);
    clocks.delete(intervalMs);
  };
};

/**
 * The current time, re-read every `intervalMs` while `active`; still otherwise. It also holds still
 * while `anchor` is out of sight (a hidden pane stays mounted and must not keep
 * rendering), and catches up on the first tick after it is seen again.
 */
export function useNow(
  active: boolean,
  anchor?: RefObject<Element | null>,
  intervalMs = 1000,
): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    return subscribe(intervalMs, () => {
      if (!outOfSight(anchor?.current ?? null)) setNow(Date.now());
    });
  }, [active, anchor, intervalMs]);
  return now;
}
