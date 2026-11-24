/**
 * Node's timers behind the opaque handles the shell's and main's modules take: `setTimeout` gives
 * a handle of its own, and `clearTimeout` clears only the timer that handle came from.
 */
export const nodeTimers = () => {
  const live = new Map<object, NodeJS.Timeout>();
  return {
    setTimeout: (callback: () => void, ms: number): unknown => {
      const handle = {};
      live.set(
        handle,
        setTimeout(() => {
          live.delete(handle);
          callback();
        }, ms),
      );
      return handle;
    },
    clearTimeout: (handle: unknown): void => {
      if (typeof handle !== "object" || handle === null) return;
      const timer = live.get(handle);
      live.delete(handle);
      if (timer !== undefined) clearTimeout(timer);
    },
  };
};
