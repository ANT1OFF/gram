import { useSyncExternalStore } from "react";

/**
 * Changes to what voice input has installed (the switch, a download), one at a time across every
 * mount of Settings: an on that follows an off waits until the off has deleted everything. The
 * composer neither starts nor prewarms a session while one is under way.
 */
let lifecycle: Promise<void> = Promise.resolve();
let queued = 0;
let epoch = 0;
const lifecycleListeners = new Set<() => void>();
const lifecycleChanged = () => {
  for (const listener of lifecycleListeners) listener();
};
/** Every change to what's installed (the switch, a download) runs in this one queue. */
export const inOrder = (step: () => Promise<void>): Promise<void> => {
  queued += 1;
  epoch += 1;
  lifecycleChanged();
  const next = lifecycle.then(step).finally(() => {
    queued -= 1;
    lifecycleChanged();
  });
  lifecycle = next.catch(() => undefined);
  return next;
};
/** Whether a change is queued or under way, now. */
export const lifecyclePending = (): boolean => queued > 0;

/**
 * A mark that moves whenever a change is queued. Work that awaited something checks it still holds
 * before reaching the speech process, so a lookup begun before a turn-off can't restart it after
 * that turn-off's `shutdown`.
 */
export const lifecycleMark = (): number => epoch;

/** Whether nothing has been queued since `mark` and nothing is under way. */
export const lifecycleUnchanged = (mark: number): boolean => epoch === mark && queued === 0;

/** Whether a change is queued or under way, which holds every control that makes another. */
export const useLifecyclePending = (): boolean =>
  useSyncExternalStore(
    (listener) => {
      lifecycleListeners.add(listener);
      return () => lifecycleListeners.delete(listener);
    },
    () => queued > 0,
  );
