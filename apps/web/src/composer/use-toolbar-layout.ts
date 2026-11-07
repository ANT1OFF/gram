import { useLayoutEffect, useRef, useState } from "react";

import {
  sameLayout,
  toolbarLayout,
  type LabelSize,
  type ToolbarBlock,
  type ToolbarLayout,
} from "./toolbar-layout";

/** The "…" button and its gap. */
const OVERFLOW_WIDTH = 32;
/** What a label adds besides its text: the trigger's gap between glyph and label. */
const LABEL_GAP = 6;
/**
 * What a control carries only while it says its value in full: the chevron after its words (14 px,
 * `size-icon-chip`, and its gap), and the rule before it (1 px, its margins and the block's gap).
 * Short of room both go, so the words keep the space. Constant, as the measure can't see what isn't
 * drawn: a chevron of another size makes the full and short estimates disagree with what is drawn,
 * and the row flips between them for ever (`toolbar-chevron.test.tsx` holds the two together).
 */
export const CHEVRON = 20;
const SEPARATOR = 9;
/**
 * What a picker's glyph takes beside its words (18 px, `size-icon-bar`, and the gap after it),
 * drawn in full and alone but not in short, where its words keep the room (`PickerTrigger`).
 * Constant for the same reason as `CHEVRON`: the measure can't see it while it isn't drawn.
 */
export const GLYPH = 24;
/** Slack for rounding and the gaps between groups, so a fit is never a pixel short. */
const SLACK = 6;
/**
 * Space kept free while any control shows its words: past it they give way to glyphs, so the row
 * never reads as one run of words into Send and Stop, and a flashed note still has room.
 */
const LABEL_ROOM = 48;

/** Before the first measure: everything in full, so the measure sees full widths. */
const UNMEASURED: ToolbarLayout = { sizes: new Map(), folded: [], wrapped: false };

/**
 * Fits the toolbar `ref` points at. Every `[data-toolbar-block]` in it is a block, measured with
 * its full `[data-toolbar-label]`, its `[data-toolbar-compact]` one and neither; every
 * `[data-toolbar-fixed]` is space the blocks can't have on their row, and every
 * `[data-toolbar-lead]` space before them that stays on their row when it wraps. `blocks` lists the blocks in
 * toolbar order, folded ones too, whose widths are remembered from when they last showed; keep the
 * array stable while they don't change, since a new one measures again. Anything measured resizing
 * measures again too. A block marked `glyph` never shows a word, so the hidden one it carries for
 * screen readers isn't counted as width it could take.
 */
export function useToolbarLayout<T extends HTMLElement = HTMLDivElement>(
  blocks: readonly { id: string; foldable: boolean; glyph?: boolean }[],
) {
  const ref = useRef<T>(null);
  const widths = useRef(new Map<string, { full: number; short: number; icon: number }>());
  const observer = useRef<ResizeObserver | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const [layout, setLayout] = useState<ToolbarLayout>(UNMEASURED);

  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const resize = new ResizeObserver(() => setTick((n) => n + 1));
    observer.current = resize;
    if (ref.current) resize.observe(ref.current);
    return () => resize.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const width = el.clientWidth;
    if (width === 0) return;
    const style = getComputedStyle(el);
    const gap = Number.parseFloat(style.columnGap) || 0;
    const inner =
      width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
    for (const node of el.querySelectorAll<HTMLElement>("[data-toolbar-block]")) {
      observer.current?.observe(node);
      const id = node.dataset["toolbarBlock"]!;
      const glyph = blocks.some((block) => block.id === id && block.glyph === true);
      const size = layout.sizes.get(id) ?? "full";
      const shown = node.offsetWidth + gap;
      // Every block but the first has its rule while it is in full.
      const rule = blocks[0]?.id === id ? 0 : SEPARATOR;
      if (glyph) {
        const bare = shown - (size === "full" ? rule : 0);
        widths.current.set(id, { full: bare + rule, short: bare, icon: bare });
        continue;
      }
      const words = (selector: string) => {
        const label = node.querySelector<HTMLElement>(selector);
        return label === null ? undefined : label.scrollWidth + LABEL_GAP;
      };
      const full = words("[data-toolbar-label]") ?? 0;
      const short = words("[data-toolbar-compact]") ?? full;
      const decor = rule + (node.querySelector('[role="combobox"]') === null ? 0 : CHEVRON);
      // A picker that drops its glyph in short is that much narrower there.
      const glyphless = node.querySelector("[data-toolbar-glyph]") === null ? 0 : GLYPH;
      const bare =
        shown - (size === "full" ? full + decor : size === "short" ? short - glyphless : 0);
      widths.current.set(id, {
        full: bare + full + decor,
        short: bare + short - glyphless,
        icon: bare,
      });
    }
    const sum = (selector: string) => {
      let total = 0;
      for (const node of el.querySelectorAll<HTMLElement>(selector)) {
        observer.current?.observe(node);
        if (node.offsetWidth > 0) total += node.offsetWidth + gap;
      }
      return total;
    };
    const fixed = sum("[data-toolbar-fixed]");
    // Before the blocks, on their row however it wraps: the prompt box's agent picker.
    const lead = sum("[data-toolbar-lead]");
    const measured: ToolbarBlock[] = blocks.flatMap((block) => {
      const known = widths.current.get(block.id);
      return known === undefined ? [] : [{ ...block, ...known }];
    });
    // Each block counts the gap after it, as something always follows it on the shared row. On a
    // row of their own nothing follows the last, so that row gets its gap back: without it the
    // larger type's short words came a pixel or two short at 300 px and fell to glyphs.
    const next = toolbarLayout(
      inner - lead - fixed - SLACK,
      measured,
      OVERFLOW_WIDTH,
      LABEL_ROOM,
      inner - lead - SLACK + gap,
    );
    if (!sameLayout(next, layout)) setLayout(next);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `tick` is the resize signal: something measured changed size
  }, [tick, blocks, layout]);

  return {
    ref,
    /** How `id` shows its value: in full, compact, or its glyph alone. */
    size: (id: string): LabelSize => layout.sizes.get(id) ?? "full",
    folded: layout.folded,
    wrapped: layout.wrapped,
  };
}
