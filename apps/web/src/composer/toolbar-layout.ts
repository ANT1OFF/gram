/**
 * How the composer's toolbar fits its width without wrapping: controls first drop their labels,
 * from the right, then move into a "…" menu, also from the right. Pure, so the arithmetic is
 * tested without a browser; `composer.tsx` measures and renders it.
 */

/** A control that can give up its label or fold away, in toolbar order. */
export interface ToolbarBlock {
  readonly id: string;
  /** Width with its label, its gap and separator included. */
  readonly full: number;
  /** Width as a glyph alone; the same as `full` for a control with no label. */
  readonly icon: number;
  /** Whether it may move into the "…" menu. The model picker stays, as a glyph at least. */
  readonly foldable: boolean;
}

export interface ToolbarLayout {
  /** Blocks that keep their label. */
  readonly labelled: ReadonlySet<string>;
  /** Blocks moved into the "…" menu, in toolbar order. */
  readonly folded: readonly string[];
}

const fits = (
  space: number,
  blocks: readonly ToolbarBlock[],
  labelled: ReadonlySet<string>,
  folded: ReadonlySet<string>,
  overflow: number,
): boolean => {
  let width = folded.size > 0 ? overflow : 0;
  for (const block of blocks) {
    if (folded.has(block.id)) continue;
    width += labelled.has(block.id) ? block.full : block.icon;
  }
  return width <= space;
};

/**
 * The widest arrangement of `blocks` that fits in `space`, with `overflow` the width of the "…"
 * button once anything folds. When even the narrowest doesn't fit, the narrowest.
 */
export function toolbarLayout(
  space: number,
  blocks: readonly ToolbarBlock[],
  overflow: number,
): ToolbarLayout {
  const labelled = new Set(blocks.filter((block) => block.full > block.icon).map((b) => b.id));
  const folded = new Set<string>();
  const result = (): ToolbarLayout => ({
    labelled: new Set(labelled),
    folded: blocks.filter((block) => folded.has(block.id)).map((block) => block.id),
  });
  if (fits(space, blocks, labelled, folded, overflow)) return result();

  for (const block of blocks.toReversed()) {
    if (!labelled.delete(block.id)) continue;
    if (fits(space, blocks, labelled, folded, overflow)) return result();
  }
  for (const block of blocks.toReversed()) {
    if (!block.foldable) continue;
    folded.add(block.id);
    if (fits(space, blocks, labelled, folded, overflow)) return result();
  }
  return result();
}

/** Two layouts that render the same, so a re-measure that changes nothing doesn't re-render. */
export const sameLayout = (a: ToolbarLayout, b: ToolbarLayout): boolean =>
  a.folded.length === b.folded.length &&
  a.folded.every((id, index) => b.folded[index] === id) &&
  a.labelled.size === b.labelled.size &&
  [...a.labelled].every((id) => b.labelled.has(id));
