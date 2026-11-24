import type { Virtualizer } from "@tanstack/react-virtual";

/** The nearest viewport which will consume vertical input, respecting native wheel chaining. */
export function scrollOwner(
  target: EventTarget | null,
  transcript: HTMLElement,
  direction: number,
): HTMLElement | undefined {
  let element = target instanceof Element ? target : null;
  while (element && element !== transcript) {
    if (element instanceof HTMLElement) {
      const style = getComputedStyle(element);
      if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight) {
        const canScroll =
          direction === 0 ||
          (direction < 0
            ? element.scrollTop > 0
            : element.scrollHeight - element.clientHeight - element.scrollTop > 1);
        if (canScroll) return element;
        if (style.overscrollBehaviorY === "contain" || style.overscrollBehaviorY === "none")
          return undefined;
      }
    }
    element = element.parentElement;
  }
  return element === transcript ? transcript : undefined;
}

type Viewport = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight" | "clientWidth">;

/** An outer reading gesture can resume follow only through its own unchanged-layout movement. */
export interface ScrollGesture {
  kind: "wheel" | "key" | "pointer" | "touch";
  height: number;
  clientHeight: number;
  clientWidth: number;
  revision: number;
  expiresAt: number;
}

export function beginScrollGesture(
  kind: ScrollGesture["kind"],
  viewport: Viewport,
  revision: number,
  now: number,
): ScrollGesture {
  return {
    kind,
    height: viewport.scrollHeight,
    clientHeight: viewport.clientHeight,
    clientWidth: viewport.clientWidth,
    revision,
    expiresAt: now + (kind === "wheel" ? 300 : 600),
  };
}

export function consumeScrollGesture(
  gesture: ScrollGesture | undefined,
  viewport: Viewport,
  previousTop: number,
  revision: number,
  now: number,
): { resume: boolean; gesture: ScrollGesture | undefined } {
  if (
    !gesture ||
    now > gesture.expiresAt ||
    gesture.revision !== revision ||
    gesture.height !== viewport.scrollHeight ||
    gesture.clientHeight !== viewport.clientHeight ||
    gesture.clientWidth !== viewport.clientWidth ||
    viewport.scrollTop < previousTop
  )
    return { resume: false, gesture: undefined };
  const resume =
    viewport.scrollTop > previousTop &&
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 1;
  return { resume, gesture: resume || gesture.kind === "wheel" ? undefined : gesture };
}

/**
 * Ends every scroll the virtualizer still means to make, so the rows stay where the reader sees
 * them. `cancelScroll` stops a scroll command, but not a correction the browser clamped: rows that
 * grew before the list did ask for more than the list can scroll yet, and the virtualizer writes
 * the rest on a later update (virtual-core 3.19.11). A press can be that update, and move the rows
 * between pressing and releasing. Writing where the list is now replaces the correction. Where the
 * list is, not the virtualizer's `scrollOffset`: a clamped write that moved nothing leaves that at
 * the correction's target. For a press or a key that doesn't scroll; a wheel, a touch or a
 * scrollbar drag moves the list, and the virtualizer drops the correction on that scroll itself.
 */
export function holdStill(
  virtualizer: Pick<Virtualizer<Element, Element>, "scrollToOffset" | "cancelScroll">,
  list: Pick<Element, "scrollTop">,
): void {
  virtualizer.scrollToOffset(list.scrollTop);
  virtualizer.cancelScroll();
}
