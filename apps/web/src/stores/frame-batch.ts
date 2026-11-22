/** Calls `run` later (`nextFrame`); returns what cancels it. */
export type Schedule = (run: () => void) => () => void;

const FALLBACK_MS = 50;

const nextTask: Schedule = (run) => {
  const channel = new MessageChannel();
  let live = true;
  channel.port1.addEventListener(
    "message",
    () => {
      channel.port1.close();
      if (live) run();
    },
    { once: true },
  );
  channel.port1.start();
  channel.port2.postMessage(undefined);
  return () => {
    live = false;
    channel.port1.close();
  };
};

/**
 * The next frame, or 50 ms where frames are late. A hidden window draws no frames and holds its
 * timers to a second or more, while its events (a notification to raise, the dock badge) must
 * still land at once: there, and once the window hides, the batch runs in a task of its own.
 */
export const nextFrame: Schedule = (run) => {
  if (typeof document === "undefined" || typeof requestAnimationFrame !== "function") {
    const timer = setTimeout(run, 0);
    return () => clearTimeout(timer);
  }
  if (document.visibilityState === "hidden") return nextTask(run);
  let cancelTask: (() => void) | undefined;
  const hidden = () => {
    if (document.visibilityState === "hidden") cancelTask ??= nextTask(run);
  };
  const frame = requestAnimationFrame(run);
  const timer = setTimeout(run, FALLBACK_MS);
  document.addEventListener("visibilitychange", hidden);
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    cancelTask?.();
    document.removeEventListener("visibilitychange", hidden);
  };
};

export interface FrameBatch<T> {
  /** Queues `item` behind every item already queued, and schedules a flush if none is. */
  push(item: T): void;
  /** Applies everything queued now, in the order it came. */
  flush(): void;
}

/**
 * A queue `apply` drains once a frame, inside `around`. An `apply` that throws on one item has it
 * logged and goes on with the next, so one bad event costs only itself.
 */
export function createFrameBatch<T>(
  apply: (item: T) => void,
  schedule: Schedule = nextFrame,
  around: (applyAll: () => void) => void = (applyAll) => applyAll(),
): FrameBatch<T> {
  let queued: T[] = [];
  let cancel: (() => void) | undefined;
  const flush = () => {
    cancel?.();
    cancel = undefined;
    const items = queued;
    queued = [];
    if (items.length === 0) return;
    around(() => {
      for (const item of items) {
        try {
          apply(item);
        } catch (error) {
          console.error("server event failed to apply", error);
        }
      }
    });
  };
  return {
    push(item) {
      queued.push(item);
      cancel ??= schedule(flush);
    },
    flush,
  };
}
