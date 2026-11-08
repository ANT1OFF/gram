/**
 * How the composer's toolbar fits its width. Each measured control (the composer's choices chip)
 * says its values in full ("Claude Opus · High · Auto") while the row has room; short of it, in
 * their compact forms ("Opus · High · Auto"), from the right, and tighter, its value alone ("Opus").
 * Still short, the controls move up to a row of their own above Send and Stop, in full, compact or
 * value-alone words, rather than lose their values. Only when even that can't fit do they drop to
 * glyphs on one row, from the right. A block marked `foldable` would then fold away; the choices
 * chip is not, so nothing in the composer folds. Pure, so the arithmetic is tested without a
 * browser; `use-toolbar-layout.ts` measures and `composer.tsx` renders it.
 */

/**
 * How a control shows its value: in full, in its compact form, as its compact value alone beside
 * its glyph, or as its glyph alone.
 */
export type LabelSize = "full" | "short" | "value" | "icon";

/** A control that can shorten its label, give it up or fold away, in toolbar order. */
export interface ToolbarBlock {
  readonly id: string;
  /** Width with its full label, its gap and separator included. */
  readonly full: number;
  /** Width with its compact label; the same as `full` when the two are one word. */
  readonly short: number;
  /** Width as its glyph and compact value; `short` when the two read the same (the model's). */
  readonly value?: number;
  /** Width as a glyph alone; the same as `full` for a control with no label. */
  readonly icon: number;
  /** Whether it may move into the "…" menu. The model picker stays, as a glyph at least. */
  readonly foldable: boolean;
}

export interface ToolbarLayout {
  /** How each block shows its value; a block not named shows it in full. */
  readonly sizes: ReadonlyMap<string, LabelSize>;
  /** Blocks moved into the "…" menu, in toolbar order. */
  readonly folded: readonly string[];
  /** The blocks have a row of their own, above what sits past them (Send and Stop). */
  readonly wrapped: boolean;
}

const widthAt = (block: ToolbarBlock, size: LabelSize) =>
  size === "full"
    ? block.full
    : size === "short"
      ? block.short
      : size === "value"
        ? (block.value ?? block.short)
        : block.icon;

const fits = (
  space: number,
  blocks: readonly ToolbarBlock[],
  sizes: ReadonlyMap<string, LabelSize>,
  folded: ReadonlySet<string>,
  overflow: number,
  room: number,
): boolean => {
  let width = folded.size > 0 ? overflow : 0;
  let worded = false;
  for (const block of blocks) {
    if (folded.has(block.id)) continue;
    const size = sizes.get(block.id) ?? "full";
    width += widthAt(block, size);
    if (size !== "icon" && block.short > block.icon) worded = true;
  }
  return width + (worded ? room : 0) <= space;
};

/**
 * The widest arrangement of `blocks`. On one row they share `space` with what sits past them, and
 * `overflow` is the width of the "…" button once anything folds; words keep `room` free beside
 * them, so they never run up against Send and Stop, and glyphs alone need none. With `row`, the
 * width of a row of their own, they may move up to it before they give up their words. When even
 * the narrowest doesn't fit, the narrowest.
 */
export function toolbarLayout(
  space: number,
  blocks: readonly ToolbarBlock[],
  overflow: number,
  room = 0,
  row?: number,
): ToolbarLayout {
  const sizes = new Map<string, LabelSize>(blocks.map((block) => [block.id, "full"]));
  const folded = new Set<string>();
  const result = (wrapped = false): ToolbarLayout => ({
    sizes: new Map(sizes),
    folded: blocks.filter((block) => folded.has(block.id)).map((block) => block.id),
    wrapped,
  });
  const oneRow = () => fits(space, blocks, sizes, folded, overflow, room);
  if (oneRow()) return result();

  // Each block, from the right, at `size`, until `check` passes. A value alone no narrower than
  // the compact words (the model's name, a word that is its own value) keeps the words.
  const step = (size: LabelSize, check: () => boolean) => {
    for (const block of blocks.toReversed()) {
      if (size === "value" && (block.value ?? block.short) >= block.short) continue;
      sizes.set(block.id, size);
      if (check()) return true;
    }
    return false;
  };
  // Compact words, then values alone beside their glyphs, from the right, on the one row: the
  // composer keeps one row while every value still shows.
  if (step("short", oneRow) || step("value", oneRow)) return result();

  // A row of their own, in full words, then compact ones, then values alone.
  if (row !== undefined) {
    for (const block of blocks) sizes.set(block.id, "full");
    const ownRow = () => fits(row, blocks, sizes, folded, overflow, 0);
    if (ownRow() || step("short", ownRow) || step("value", ownRow)) return result(true);
  }

  // Glyphs, from the right, the blocks left of them keeping their values alone; then the "…" menu.
  for (const block of blocks.toReversed()) {
    sizes.set(block.id, "icon");
    if (oneRow()) return result();
  }
  for (const block of blocks.toReversed()) {
    if (!block.foldable) continue;
    folded.add(block.id);
    if (oneRow()) return result();
  }
  return result();
}

/** Two layouts that render the same, so a re-measure that changes nothing doesn't re-render. */
export const sameLayout = (a: ToolbarLayout, b: ToolbarLayout): boolean =>
  a.wrapped === b.wrapped &&
  a.folded.length === b.folded.length &&
  a.folded.every((id, index) => b.folded[index] === id) &&
  a.sizes.size === b.sizes.size &&
  [...a.sizes].every(([id, size]) => b.sizes.get(id) === size);
