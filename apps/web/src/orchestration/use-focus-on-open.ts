import { useEffect, useRef, type RefObject } from "react";

/** How many frames a focus that didn't hold is tried again before it is given up. */
const FOCUS_ATTEMPTS = 30;

export interface FocusWhenAbleOptions {
  readonly attempts?: number;
  /** `requestAnimationFrame` and its cancel, injectable so a test steps the frames itself. */
  readonly frame?: (callback: () => void) => number;
  readonly cancelFrame?: (handle: number) => void;
}

/**
 * Focuses `element` as soon as it can take focus, and returns what stops trying.
 *
 * `focus()` on an element under an `inert` ancestor does nothing and says nothing. `ExpandPresence`
 * mounts its children inert until React commits the render after its first frame, and on a slow
 * machine that commit is several frames away: a focus sent a fixed two frames after mounting was
 * lost for good there, which left the form open with no caret in it (the Windows runner, and macOS
 * CI for a form opened from a menu). So nothing here counts frames to guess when `inert` goes:
 * while an ancestor is inert the attribute is watched, and the focus is sent when it is lifted.
 * Every focus is checked against `document.activeElement`, and one that didn't hold for another
 * reason is tried again on the next frame, `attempts` times at most. An element that has left the
 * page ends it.
 */
export function focusWhenAble(
  element: HTMLElement,
  {
    attempts = FOCUS_ATTEMPTS,
    frame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (handle) => cancelAnimationFrame(handle),
  }: FocusWhenAbleOptions = {},
): () => void {
  let left = attempts;
  let pending: number | undefined;
  let observer: MutationObserver | undefined;

  const stop = () => {
    if (pending !== undefined) cancelFrame(pending);
    pending = undefined;
    observer?.disconnect();
    observer = undefined;
  };

  const attempt = () => {
    stop();
    if (!element.isConnected) return;
    const blocker = element.closest("[inert]");
    if (blocker !== null) {
      observer = new MutationObserver(attempt);
      observer.observe(blocker, { attributes: true, attributeFilter: ["inert"] });
      return;
    }
    element.focus();
    if (document.activeElement === element) return;
    left -= 1;
    if (left > 0) pending = frame(attempt);
  };

  attempt();
  return stop;
}

/**
 * A ref whose element takes focus once it can; see `focusWhenAble` for why that isn't at once.
 * `shared` is used in place of a ref of its own, for a field something else has to reach too.
 */
export function useFocusOnOpen<T extends HTMLElement>(
  shared?: RefObject<T | null>,
): RefObject<T | null> {
  const own = useRef<T>(null);
  const ref = shared ?? own;
  useEffect(() => (ref.current === null ? undefined : focusWhenAble(ref.current)), [ref]);
  return ref;
}
