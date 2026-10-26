import { useLayoutEffect, useRef, useState } from "react";

import { sameLayout, toolbarLayout, type ToolbarBlock, type ToolbarLayout } from "./toolbar-layout";

/** The "…" button and its gap. */
const OVERFLOW_WIDTH = 32;
/** What a label adds besides its text: the trigger's gap between glyph and label. */
const LABEL_GAP = 6;
/** Slack for rounding and the gaps between groups, so a fit is never a pixel short. */
const SLACK = 6;

/** Before the first measure: everything as wide as it wants, so the measure sees full widths. */
const UNMEASURED: ToolbarLayout = { labelled: new Set(["*"]), folded: [] };

/**
 * Fits the toolbar `ref` points at. Every `[data-toolbar-block]` in it is a block, measured with
 * and without its `[data-toolbar-label]`; every `[data-toolbar-fixed]` is space the blocks can't
 * have. `blocks` lists the blocks in toolbar order, folded ones too, whose widths are remembered
 * from when they last showed; keep the array stable while they don't change, since a new one
 * measures again. Anything measured resizing measures again too.
 */
export function useToolbarLayout(blocks: readonly { id: string; foldable: boolean }[]) {
  const ref = useRef<HTMLDivElement>(null);
  const widths = useRef(new Map<string, { full: number; icon: number }>());
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
    const labelled = (id: string) => layout.labelled.has("*") || layout.labelled.has(id);
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
      const label = node.querySelector<HTMLElement>("[data-toolbar-label]");
      const extra = label === null ? 0 : label.scrollWidth + LABEL_GAP;
      const shown = node.offsetWidth + gap;
      widths.current.set(
        id,
        labelled(id) && label !== null
          ? { full: shown, icon: shown - extra }
          : { full: shown + extra, icon: shown },
      );
    }
    let fixed = 0;
    for (const node of el.querySelectorAll<HTMLElement>("[data-toolbar-fixed]")) {
      observer.current?.observe(node);
      if (node.offsetWidth > 0) fixed += node.offsetWidth + gap;
    }
    const measured: ToolbarBlock[] = blocks.flatMap((block) => {
      const known = widths.current.get(block.id);
      return known === undefined ? [] : [{ ...block, ...known }];
    });
    const next = toolbarLayout(inner - fixed - SLACK, measured, OVERFLOW_WIDTH);
    if (!sameLayout(next, layout)) setLayout(next);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `tick` is the resize signal: something measured changed size
  }, [tick, blocks, layout]);

  return {
    ref,
    labelled: layout.labelled.has("*") ? ("all" as const) : layout.labelled,
    folded: layout.folded,
  };
}
