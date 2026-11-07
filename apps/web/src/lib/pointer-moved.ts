/**
 * Whether a hover came from the pointer moving, rather than from something appearing (or moving)
 * under a pointer that was resting. A browser sends `mouseover` and `mousemove` when the layout
 * changes under a still pointer: a panel opening, a row growing, a tab folding to its glyph. A hint
 * opened by those covers what is around it though nobody pointed at anything.
 *
 * One listener per window records where the pointer was, when it last changed position and what it
 * was over then; a hover is the pointer's own if it came within a frame or two of such a change and
 * that move was onto the hovered element. A click's own move doesn't count for what the click makes
 * appear under it a moment later: that move was onto the button.
 */

/** A real movement's events (pointer and mouse, over and move) arrive within this of each other. */
const SAME_MOVE_MS = 48;

/**
 * Where the pointer was, by the kind of event that said so. A pointer event's position is fractional
 * and its mouse twin's whole pixels, so the pair the browser sends for one layout change under a
 * still pointer differ: each is compared with the last of its own kind, or every pair would read as
 * a move, while a move of under a pixel still is one.
 */
const last = new Map<"pointer" | "mouse", { x: number; y: number }>();
let movedAt = Number.NEGATIVE_INFINITY;
/** What the pointer was over at its last change of position. */
let movedOver: EventTarget | null = null;
let listening = false;

const record = (event: MouseEvent) => {
  const { clientX: x, clientY: y } = event;
  const kind = event.type.startsWith("pointer") ? "pointer" : "mouse";
  // The first of a kind has only the other kind's last to go on.
  const was = last.get(kind) ?? last.get(kind === "pointer" ? "mouse" : "pointer");
  if (was === undefined || was.x !== x || was.y !== y) {
    movedAt = event.timeStamp;
    movedOver = event.target;
  }
  last.set(kind, { x, y });
};

/** Starts recording; idempotent. Called by the first tooltip, so pages without one pay nothing. */
export function trackPointerMoves(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  for (const type of ["pointermove", "mousemove", "pointerover", "mouseover", "pointerdown"])
    window.addEventListener(type, record as EventListener, { capture: true, passive: true });
}

/**
 * Whether `event`, a hover's, was the pointer moving onto `on` (by default the element the event is
 * for): it moved within a frame or two, and that move was over `on`. An event with no position (a
 * synthetic one at the origin, as a test environment sends) counts as moving: there is nothing to
 * compare.
 */
export function pointerMovedFor(event: Event | undefined, on?: Element | null): boolean {
  if (!(event instanceof MouseEvent)) return true;
  if (event.clientX === 0 && event.clientY === 0) return true;
  if (Math.abs(event.timeStamp - movedAt) > SAME_MOVE_MS) return false;
  const target = on ?? event.currentTarget ?? event.target;
  // A move recorded before anything it was over can be told apart, or onto nothing: as it was.
  if (!(target instanceof Node) || !(movedOver instanceof Node)) return true;
  return target.contains(movedOver);
}

/** For tests: forget what was recorded. */
export function resetPointerMoves(): void {
  last.clear();
  movedAt = Number.NEGATIVE_INFINITY;
  movedOver = null;
}
