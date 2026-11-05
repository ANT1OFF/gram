/**
 * Whether a hover came from the pointer moving, rather than from something appearing (or moving)
 * under a pointer that was resting. A browser sends `mouseover` and `mousemove` when the layout
 * changes under a still pointer: a panel opening, a row growing, a tab folding to its glyph. A hint
 * opened by those covers what is around it though nobody pointed at anything.
 *
 * One listener per window records where the pointer was and when it last changed position; a hover
 * is the pointer's own if it came within a frame or two of such a change.
 */

/** A real movement's events (pointer and mouse, over and move) arrive within this of each other. */
const SAME_MOVE_MS = 48;

let last: { x: number; y: number } | undefined;
let movedAt = Number.NEGATIVE_INFINITY;
let listening = false;

const record = (event: MouseEvent) => {
  const { clientX: x, clientY: y } = event;
  if (last === undefined || last.x !== x || last.y !== y) movedAt = event.timeStamp;
  last = { x, y };
};

/** Starts recording; idempotent. Called by the first tooltip, so pages without one pay nothing. */
export function trackPointerMoves(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  for (const type of ["pointermove", "mousemove", "pointerover", "mouseover", "pointerdown"])
    window.addEventListener(type, record as EventListener, { capture: true, passive: true });
}

/**
 * Whether `event`, a hover's, was the pointer moving onto its target. An event with no position
 * (a synthetic one at the origin, as a test environment sends) counts as moving: there is nothing
 * to compare.
 */
export function pointerMovedFor(event: Event | undefined): boolean {
  if (!(event instanceof MouseEvent)) return true;
  if (event.clientX === 0 && event.clientY === 0) return true;
  return Math.abs(event.timeStamp - movedAt) <= SAME_MOVE_MS;
}

/** For tests: forget what was recorded. */
export function resetPointerMoves(): void {
  last = undefined;
  movedAt = Number.NEGATIVE_INFINITY;
}
