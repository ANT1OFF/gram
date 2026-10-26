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
    // Native key/touch/drag movement may span frames. A wheel token is consumed by its first
    // outer scroll; the deadline also retires input which caused no displacement.
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
