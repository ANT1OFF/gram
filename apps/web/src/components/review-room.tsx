import { useEffect, type RefObject } from "react";
import { create } from "zustand";

import { fitShell, useLayoutStore, type LayoutState } from "@/stores/layout";

const HOLD_MS = 600;

/** A place in a scroller: the element at its top edge and how far below that edge it starts. */
export interface ReadingPlace {
  readonly element: Element;
  readonly offset: number;
}

/**
 * The scroller in `root` the user reads in: of those scrolled away from their top, the tallest.
 * `undefined` when nothing is scrolled, so there is no place to keep.
 */
export const readingScroller = (root: HTMLElement): HTMLElement | undefined => {
  let best: HTMLElement | undefined;
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    if (el.scrollTop <= 0 || el.scrollHeight <= el.clientHeight) continue;
    if (best === undefined || el.clientHeight > best.clientHeight) best = el;
  }
  return best;
};

/** How far to scroll so `place` sits where it was: its top now, less where it started. */
export const placeShift = (place: ReadingPlace, scrollerTop: number): number =>
  place.element.getBoundingClientRect().top - scrollerTop - place.offset;

const placeIn = (scroller: HTMLElement): ReadingPlace | undefined => {
  const box = scroller.getBoundingClientRect();
  const element = document.elementFromPoint?.(box.left + box.width / 2, box.top + 4);
  if (element === null || element === undefined || !scroller.contains(element)) return undefined;
  return { element, offset: element.getBoundingClientRect().top - box.top };
};

/**
 * Keeps the line being read in the panel `root` at its place while a review goes into focus and back:
 * the width changes, lines rewrap, and the scroll position alone would land elsewhere. Held for the
 * width's animation, and let go as soon as the user scrolls themselves.
 */
export function useKeepReadingPlace(root: RefObject<HTMLElement | null>) {
  useEffect(
    () =>
      useLayoutStore.subscribe((s, prev) => {
        if (s.reviewFocus === prev.reviewFocus || root.current === null) return;
        const scroller = readingScroller(root.current);
        const place = scroller === undefined ? undefined : placeIn(scroller);
        if (scroller === undefined || place === undefined) return;
        const until = performance.now() + HOLD_MS;
        let frame = 0;
        const stop = () => {
          cancelAnimationFrame(frame);
          scroller.removeEventListener("wheel", stop);
          scroller.removeEventListener("keydown", stop);
          scroller.removeEventListener("pointerdown", stop);
        };
        const hold = () => {
          if (!place.element.isConnected) return stop();
          const shift = placeShift(place, scroller.getBoundingClientRect().top);
          if (Math.abs(shift) >= 1) scroller.scrollTop += shift;
          if (performance.now() < until) frame = requestAnimationFrame(hold);
          else stop();
        };
        scroller.addEventListener("wheel", stop, { passive: true });
        scroller.addEventListener("keydown", stop);
        scroller.addEventListener("pointerdown", stop);
        frame = requestAnimationFrame(hold);
      }),
    [root],
  );
}

/**
 * How a review held too narrow is answered, for this run of the window: Focus review is entered for
 * it until the user leaves focus (`declined`), which lasts until the review has room again. Not
 * remembered across launches.
 */
export const useReviewRoom = create<{ declined: boolean }>()(() => ({
  declined: false,
}));

const SETTLE_MS = 400;

/**
 * A review that comes to be held too narrow to read beside the conversation (its panel dragged
 * wide, the window narrowed, a review opened in a narrow window) goes into Focus review on its own,
 * which gives it the window and leaves the conversation a strip (Esc or Restore gives it back). It
 * waits for the layout to settle, so a drag of the panel's edge or the window's ends first. A window
 * that opens that way, or a thread come to that way, is left as it was, with Focus review offered
 * beside the tabs: the conversation is what a launch or a thread shows first. Left while still short of room, focus is not taken again until the review has had
 * room. Mounted once, by the shell.
 */
export function useAutoReviewFocus() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pressed = false;
    let armed = false;
    const due = () => {
      const fit = fitShell(useLayoutStore.getState());
      return armed && !fit.reviewFocus && fit.reviewCramped && !useReviewRoom.getState().declined;
    };
    const take = () => {
      timer = undefined;
      if (pressed || !due()) return;
      armed = false;
      useLayoutStore.getState().setReviewFocus(true);
    };
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = due() ? setTimeout(take, SETTLE_MS) : undefined;
    };
    const apply = (s: LayoutState, prev: LayoutState) => {
      const fit = fitShell(s);
      const before = fitShell(prev);
      if (fit.reviewFocus) {
        armed = false;
        return;
      }
      const room = useReviewRoom.getState();
      if (before.reviewFocus) {
        if (fit.reviewCramped && !room.declined) useReviewRoom.setState({ declined: true });
        return;
      }
      if (!fit.reviewCramped) {
        armed = false;
        if (room.declined) useReviewRoom.setState({ declined: false });
      } else if (!before.reviewCramped) {
        armed =
          s.threadInView === prev.threadInView &&
          s.threadQuiet === prev.threadQuiet &&
          s.panelBarred === prev.panelBarred;
      }
      schedule();
    };
    const down = () => {
      pressed = true;
    };
    const up = () => {
      pressed = false;
      schedule();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    const unsubscribe = useLayoutStore.subscribe(apply);
    return () => {
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  }, []);
}
