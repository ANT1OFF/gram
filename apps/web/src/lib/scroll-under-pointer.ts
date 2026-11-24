const SCROLLED_UNDER_POINTER = "data-scrolled-under-pointer";

let listening = false;

/**
 * Marks `<html data-scrolled-under-pointer>` from a scroll until the pointer next changes position.
 * A browser moves `:hover` onto whatever slides under a still pointer, so a hover-revealed control
 * (a code block's or a table's buttons) would fade in and out over every block a scroll passes:
 * flicker nobody pointed at. CSS that reveals on `:hover` stays hidden while the attribute is there
 * (see `globals.css`); keyboard focus still shows it. Positions are compared because a browser may
 * send a `pointermove` at an unchanged position after a scroll, which is not the pointer moving.
 *
 * Idempotent; the markdown renderer starts it, so pages without one pay nothing.
 */
export function trackScrollUnderPointer(win: Window = window): void {
  if (listening) return;
  listening = true;
  const root = win.document.documentElement;
  let last: { x: number; y: number } | undefined;
  win.addEventListener(
    "scroll",
    () => {
      if (!root.hasAttribute(SCROLLED_UNDER_POINTER)) root.setAttribute(SCROLLED_UNDER_POINTER, "");
    },
    { capture: true, passive: true },
  );
  win.addEventListener(
    "pointermove",
    (event) => {
      const { clientX: x, clientY: y } = event;
      const moved = last === undefined || last.x !== x || last.y !== y;
      last = { x, y };
      if (moved) root.removeAttribute(SCROLLED_UNDER_POINTER);
    },
    { capture: true, passive: true },
  );
}
