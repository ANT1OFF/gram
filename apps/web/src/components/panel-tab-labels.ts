import { useLayoutEffect, useState, type RefObject } from "react";

import { MENU_CAP } from "@/palette/menu-caps";

/**
 * Which of the tabs left in the strip show their names: all of them; only the open one; or none.
 * Short of room the strip folds tabs into More before it gives up a name, so bare icons are the
 * last resort of a panel too narrow for even the open tab's name beside More.
 */
export type TabLabelFit = "all" | "active" | "none";

export interface TabWidths {
  /** The tab without its name: its icon, padding and any count. */
  readonly bare: number;
  /** What its name adds, the space before it included. */
  readonly label: number;
  readonly active: boolean;
  /** Stays in the strip after the rarer tabs fold into More; folds last, from the strip's end. */
  readonly primary: boolean;
  /** Stays in the strip whatever the room: something in it waits on the user. */
  readonly pinned?: boolean;
}

export interface LabelFit {
  readonly tabs: TabLabelFit;
  /** Whether the action beside the tabs shows its words, not only its icon. */
  readonly action: boolean;
  /** How many steps of `foldOrder` fold into More: 0 for none. */
  readonly folds: number;
}

type FoldFlags = Pick<TabWidths, "active" | "primary" | "pinned">;

/**
 * The order tabs fold into More, by their index: the rarer tabs together first, then the primary
 * ones one at a time from the strip's end (Terminal, Files, PR, Diff, Workers, Thread). The open
 * tab and a pinned one never fold.
 */
export function foldOrder(tabs: readonly FoldFlags[]): number[][] {
  const stays = (t: FoldFlags) => t.active || t.pinned === true;
  const rare = tabs.flatMap((t, i) => (!t.primary && !stays(t) ? [i] : []));
  const primary = tabs.flatMap((t, i) => (t.primary && !stays(t) ? [i] : [])).toReversed();
  return [...(rare.length > 0 ? [rare] : []), ...primary.map((i) => [i])];
}

/** Which tabs `folds` steps of `foldOrder` put in More, by index. */
export function foldedTabs(tabs: readonly FoldFlags[], folds: number): boolean[] {
  const folded = new Set(foldOrder(tabs).slice(0, folds).flat());
  return tabs.map((_, i) => folded.has(i));
}

/** Whether a tab's name shows under `fit`. */
export const tabNamed = (fit: TabLabelFit, active: boolean): boolean =>
  fit === "all" || (fit === "active" && active);

/**
 * The most names that fit `available` px, with `gap` px between tabs, `action` px for the words of
 * an action beside them (0 for none), `more` px for a More menu tabs fold into (0 for none) and at
 * most `held` tabs in that menu. Every tab in the strip keeps its name for as long as folding tabs
 * into More makes room: the rarer tabs first, then the primary ones from the strip's end, never the
 * open or a pinned one. The action keeps its words while only the rarer tabs fold; before a primary
 * tab folds they give way to its glyph. Only once the open tab and More don't fit named, or More
 * would hold more than `held`, do the names go: all but the open one's, then that too. The strip
 * scrolls only once even the bare icons don't fit.
 */
export function tabLabelFit(
  available: number,
  gap: number,
  tabs: readonly TabWidths[],
  action = 0,
  more = 0,
  held = Number.POSITIVE_INFINITY,
): LabelFit {
  const order = more > 0 ? foldOrder(tabs) : [];
  // The steps More may take: as many as keep it to `held` tabs.
  let steps = 0;
  for (let count = 0; steps < order.length; steps++) {
    count += order[steps]!.length;
    if (count > held) break;
  }
  // The rarer tabs, folded together, are the first step when there are any.
  const rare = order.length > 0 && order[0]!.some((i) => !tabs[i]!.primary) ? 1 : 0;
  const width = (fit: TabLabelFit, words: boolean, folds: number) => {
    const folded = foldedTabs(tabs, folds);
    const shown = tabs.filter((_, i) => !folded[i]);
    return (
      shown.reduce(
        (sum, t) => sum + t.bare + (tabNamed(fit, t.active) ? t.label : 0),
        gap * Math.max(0, shown.length - 1),
      ) +
      (words ? action : 0) +
      (folds > 0 ? more : 0)
    );
  };
  const tiers: readonly { tabs: TabLabelFit; action: boolean; folds: number }[] = [
    { tabs: "all", action: true, folds: Math.min(rare, steps) },
    { tabs: "all", action: false, folds: steps },
    { tabs: "active", action: false, folds: steps },
    { tabs: "none", action: false, folds: steps },
  ];
  for (const tier of tiers) {
    if (tier.action && action === 0) continue;
    for (let folds = 0; folds <= tier.folds; folds++) {
      // A pixel spare absorbs rounding, so a strip that just fits never scrolls.
      if (width(tier.tabs, tier.action, folds) + 1 <= available) {
        return { tabs: tier.tabs, action: tier.action, folds };
      }
    }
  }
  return { tabs: "none", action: false, folds: steps };
}

const px = (value: string) => Number.parseFloat(value) || 0;

/**
 * Measures the row the tab strip in `list` shares, and says how many names it has room for and
 * how many tabs fold into More, again whenever the row or anything in it changes size or
 * content. The tabs are measured from a hidden copy in the row, a `[data-tab-measure]` holding a
 * `[data-measure-tab="<value>"]` per tab (`data-primary`, `data-pinned` as they apply), its name
 * in a `[data-tab-label]`, and a `[data-measure-more]` as wide as More: so a folded tab and a hidden
 * name are measured as readily as shown ones. An action beside the strip holds its words in a
 * `[data-action-label]` that collapses rather than unmounts, around a `[data-action-label-text]`;
 * More itself is a `[data-panel-more]`, left out of what sits beside the strip.
 */
export function useTabLabelFit(list: RefObject<HTMLElement | null>, active: string): LabelFit {
  const [fit, setFit] = useState<LabelFit>({ tabs: "all", action: true, folds: 0 });
  useLayoutEffect(() => {
    const strip = list.current;
    const row = strip?.parentElement;
    if (!strip || !row) return;
    const besideStrip = () =>
      [...row.children].filter(
        (el) =>
          el !== strip &&
          !el.hasAttribute("data-tab-measure") &&
          !el.hasAttribute("data-panel-more"),
      );
    // A fit changes the strip, which can move what was measured (a scrollbar, a tab mounted
    // mid-animation): a changed fit is measured again on the next frame, a few times at most, so a
    // reading taken mid-change can't stand once the row has settled.
    let last: LabelFit | undefined;
    let frame = 0;
    let settles = 0;
    const measure = (settling = false) => {
      if (!settling) settles = 0;
      const copy = row.querySelector<HTMLElement>("[data-tab-measure]");
      if (!copy) return;
      const rowStyle = getComputedStyle(row);
      const style = getComputedStyle(strip);
      const action = row.querySelector<HTMLElement>("[data-action-label]");
      // What the row leaves the tabs, More and the action's words: its width but for its padding
      // and everything beside the strip as it stands without its words.
      const words = action?.getBoundingClientRect().width ?? 0;
      const besides = besideStrip().reduce((sum, el) => sum + el.getBoundingClientRect().width, 0);
      const available =
        row.clientWidth -
        px(rowStyle.paddingLeft) -
        px(rowStyle.paddingRight) -
        (besides - words) -
        px(style.paddingLeft) -
        px(style.paddingRight);
      const widths = [...copy.querySelectorAll<HTMLElement>("[data-measure-tab]")].map((tab) => {
        const label = tab.querySelector<HTMLElement>("[data-tab-label]")?.getBoundingClientRect();
        return {
          bare: tab.getBoundingClientRect().width - (label?.width ?? 0),
          label: label?.width ?? 0,
          active: tab.dataset.measureTab === active,
          primary: tab.dataset.primary !== undefined,
          pinned: tab.dataset.pinned !== undefined,
        };
      });
      const more = copy.querySelector("[data-measure-more]")?.getBoundingClientRect().width ?? 0;
      const next = tabLabelFit(
        available,
        px(style.columnGap),
        widths,
        action?.scrollWidth ?? 0,
        more,
        MENU_CAP,
      );
      const same = (a: LabelFit) =>
        a.tabs === next.tabs && a.action === next.action && a.folds === next.folds;
      const moved = last === undefined || !same(last);
      last = next;
      setFit((prev) => (same(prev) ? prev : next));
      if (moved && settles < 3 && typeof requestAnimationFrame !== "undefined") {
        settles += 1;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => measure(true));
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return () => cancelAnimationFrame(frame);
    }
    const resized = new ResizeObserver(() => measure());
    resized.observe(row);
    // The copy's faces resize as fonts load and counts change, and what sits beside the strip comes
    // and goes with the open tab: follow them all.
    const observeAll = () => {
      for (const el of besideStrip()) resized.observe(el);
      for (const el of row.querySelectorAll("[data-measure-tab], [data-measure-more]")) {
        resized.observe(el);
      }
      const text = row.querySelector("[data-action-label-text]");
      if (text) resized.observe(text);
    };
    observeAll();
    const changed = new MutationObserver(() => {
      observeAll();
      measure();
    });
    changed.observe(row, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      changed.disconnect();
    };
  }, [list, active]);
  return fit;
}
