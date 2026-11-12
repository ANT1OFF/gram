import type * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

/** What the clock reads of the page: whether it is shown, and when that changes. */
export interface PageVisibility {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * `base` with its wall time stopped while `page` is hidden: it counts only the time the page is
 * shown. A browser runs a hidden tab's timers late, after a few minutes once a minute, so a
 * heartbeat timed on the real clock reads that delay as a server that stopped answering. Sleeping
 * and the nanosecond readings are `base`'s. `stop` stops following the page.
 */
export const visibleTimeClock = (
  base: Clock.Clock,
  page: PageVisibility,
): { readonly clock: Clock.Clock; readonly stop: () => void } => {
  /** When the page was last hidden, on `base`, while it still is. */
  let hiddenAt: number | undefined;
  /** How long the page was hidden before that. */
  let hiddenFor = 0;
  const follow = () => {
    const now = base.currentTimeMillisUnsafe();
    if (page.visibilityState === "hidden") hiddenAt ??= now;
    else if (hiddenAt !== undefined) {
      hiddenFor += now - hiddenAt;
      hiddenAt = undefined;
    }
    return now;
  };
  const millis = () => {
    // Read the page too: a timer can run before the browser's `visibilitychange` event does.
    const now = follow();
    return (hiddenAt ?? now) - hiddenFor;
  };
  follow();
  page.addEventListener("visibilitychange", follow);
  return {
    clock: {
      currentTimeMillisUnsafe: millis,
      currentTimeMillis: Effect.sync(millis),
      currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe(),
      currentTimeNanos: base.currentTimeNanos,
      monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: base.monotonicTimeNanos,
      sleep: (duration) => base.sleep(duration),
    },
    stop: () => page.removeEventListener("visibilitychange", follow),
  };
};
