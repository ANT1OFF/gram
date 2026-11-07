/** A box on screen, in CSS px from the viewport's top left. */
export interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** What `clearRightEdge` weighs: the trigger, the cards that ask, and the popup's size. */
export interface ClearInput {
  readonly trigger: Box;
  /** Cards that ask for a decision (an approval, a question), as they are on screen. */
  readonly cards: readonly Box[];
  readonly width: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** Room kept from the viewport's edges. */
  readonly margin?: number;
}

const overlaps = (a: Box, b: Box): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Where a popover dropped under a title bar control lines its right edge up so it covers no card
 * that asks for a decision: under its trigger when that is clear, else at the viewport's right
 * edge (over a side panel, say), else at its left. `undefined` while the trigger's own spot is
 * clear, or when no spot is: then the popover keeps its place under the trigger and gives way to a
 * click on the card instead. The popover is taken as tall as the room under the trigger.
 */
export function clearRightEdge({
  trigger,
  cards,
  width,
  viewportWidth,
  viewportHeight,
  margin = 8,
}: ClearInput): number | undefined {
  const top = trigger.bottom;
  const at = (right: number): Box => ({ left: right - width, right, top, bottom: viewportHeight });
  const clear = (right: number) => !cards.some((card) => overlaps(at(right), card));
  // Under the trigger, kept on screen as the positioner keeps it.
  const own = Math.min(viewportWidth - margin, Math.max(trigger.right, width + margin));
  if (clear(own)) return undefined;
  return [viewportWidth - margin, width + margin].find(clear);
}
