import { useEffect, useRef, useState, type RefObject } from "react";

/** How long a count-up takes, however large the jump, and how often the shown number moves. */
export const COUNT_UP_MS = 1400;
export const COUNT_UP_STEP_MS = 100;

/** Where a count-up from `from` to `to` stands at `progress` in [0, 1]: fast at first, easing out. */
export const countUpAt = (from: number, to: number, progress: number): number => {
  const t = Math.min(1, Math.max(0, progress));
  return from + (to - from) * (1 - (1 - t) ** 3);
};

/**
 * Whether nobody can see `element`: the window is in the background, or the element is under
 * `display: none`, which is how the thread grid keeps a maximized-away pane mounted. An element not
 * attached yet, or an engine without `checkVisibility`, counts as seen.
 */
export const outOfSight = (element: Element | null): boolean =>
  document.hidden || element?.checkVisibility?.() === false;

/**
 * `value`, approached in steps instead of jumped to, so a figure that is reported a few times a turn
 * reads as a meter running rather than a number being replaced. The figures stay exact: every
 * count-up ends on the reported value, and a new report mid-way starts from whatever is showing, so
 * it never snaps back. The first value is shown as it is, with nothing to count up from.
 *
 * Steps are coarse (ten a second) on purpose. Each one is handed to a rolling-digit display, which
 * animates between them itself; a value per frame would only queue animations it has to drop.
 *
 * Out of sight (`outOfSight(anchor.current)`) it doesn't run: animation pauses in hidden panes,
 * and every thread's meters stay mounted. A count-up that starts or finds itself there goes
 * straight to the value and drops its timer, so a pane coming back shows the latest figure and
 * replays nothing.
 */
export function useCountUp(
  value: number,
  enabled: boolean,
  anchor?: RefObject<Element | null>,
): number {
  const [shown, setShown] = useState(value);
  // What is showing, for the effect below to start from. Kept in an effect of its own, declared
  // first so it has run by then: a ref may not be written during render.
  const current = useRef(value);
  useEffect(() => {
    current.current = shown;
  }, [shown]);

  useEffect(() => {
    const from = current.current;
    const unseen = () => outOfSight(anchor?.current ?? null);
    if (!enabled || from === value || unseen()) {
      setShown(value);
      return;
    }
    const started = performance.now();
    const timer = setInterval(() => {
      const progress = unseen() ? 1 : (performance.now() - started) / COUNT_UP_MS;
      setShown(progress >= 1 ? value : countUpAt(from, value, progress));
      if (progress >= 1) clearInterval(timer);
    }, COUNT_UP_STEP_MS);
    return () => clearInterval(timer);
  }, [value, enabled, anchor]);

  return enabled ? shown : value;
}
