import { Focus, X } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";

import { Button } from "@/components/ui/button";
import { useShortcutHint } from "@/keyboard/use-shortcut-hint";
import { fitShell, useLayoutStore } from "@/stores/layout";

/** How long the reading place is held while the panel's width animates into focus and back. */
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

/** The element at the scroller's top edge, a few pixels in, and its offset from that edge. */
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
 * Under a review's tabs while it is held too narrow to read beside the conversation: says so, and
 * offers Focus review, which gives the review the window and leaves the conversation a strip.
 * Dismissed, it stays away until the review has room again and runs short once more.
 */
export function ReviewRoomOffer() {
  const cramped = useLayoutStore((s) => fitShell(s).reviewCramped);
  const toggle = useLayoutStore((s) => s.toggleReviewFocus);
  const hint = useShortcutHint("review.focus");
  const [dismissed, setDismissed] = useState(false);
  // Room again forgets the dismissal, so the next time it runs short it is offered again.
  if (!cramped && dismissed) setDismissed(false);
  if (!cramped || dismissed) return null;
  return (
    <div
      role="status"
      data-testid="review-room-offer"
      className="gram-fade flex min-w-0 items-center gap-2 border-b border-border bg-muted/40 py-1 ps-3 pe-1 text-meta text-muted-foreground"
    >
      <span className="min-w-0 flex-1 text-pretty">
        Too narrow to read beside the conversation.
      </span>
      <Button
        size="xs"
        variant="outline"
        className="shrink-0"
        data-testid="review-room-focus"
        onClick={toggle}
      >
        <Focus aria-hidden />
        Focus review
        {hint && <kbd className="font-sans text-caption text-muted-foreground">{hint}</kbd>}
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        className="shrink-0"
        aria-label="Keep side by side"
        title="Keep side by side"
        onClick={() => setDismissed(true)}
      >
        <X aria-hidden />
      </Button>
    </div>
  );
}
