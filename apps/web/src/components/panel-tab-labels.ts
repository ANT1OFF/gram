import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Which of the panel's tabs show their names: all; the primary ones (Diff, PR, Files and Terminal)
 * and the open one; only the open one; or none.
 */
export type TabLabelFit = "all" | "primary" | "active" | "none";

export interface TabWidths {
  /** The tab without its name: its icon, padding and any count. */
  readonly bare: number;
  /** What its name adds, the space before it included. */
  readonly label: number;
  readonly active: boolean;
  /** Named before the other tabs once not every name fits, and never folded into More. */
  readonly primary: boolean;
  /** Stays in the strip whatever the room: something in it waits on the user. */
  readonly pinned?: boolean;
}

export interface LabelFit {
  readonly tabs: TabLabelFit;
  /** Whether the action beside the tabs shows its words, not only its icon. */
  readonly action: boolean;
  /** Whether the rarer tabs fold into More, all but the open one and those `pinned`. */
  readonly fold: boolean;
}

/**
 * The order names give way in: the action's words outlast every tab's name, the open tab's too, so
 * on a review Focus review stays the one labelled way out of a tight panel. The open tab still
 * reads as open without its name: on its background and underlined, and named on hover.
 */
const TIERS: readonly Omit<LabelFit, "fold">[] = [
  { tabs: "all", action: true },
  { tabs: "primary", action: true },
  { tabs: "active", action: true },
  { tabs: "none", action: true },
  { tabs: "primary", action: false },
  { tabs: "active", action: false },
  { tabs: "none", action: false },
];

/** Whether a tab's name shows under `fit`. */
export const tabNamed = (fit: TabLabelFit, active: boolean, primary: boolean): boolean =>
  fit === "all" || (fit !== "none" && active) || (fit === "primary" && primary);

/** Whether a tab folds into More when the strip folds. */
export const tabFolds = (tab: Pick<TabWidths, "active" | "primary" | "pinned">): boolean =>
  !tab.primary && !tab.active && tab.pinned !== true;

/**
 * The most names that fit `available` px, with `gap` px between tabs, `action` px for the words of
 * an action beside them (0 for none) and `more` px for a More menu that the rarer tabs fold into
 * (0 for none): every tab named, else the primary tabs and the open one, else only the open one,
 * else none; the action's words give way only after every name has. Short of every name, the
 * rarer tabs fold into More wherever that takes less room. The strip scrolls only once even the
 * bare icons don't fit.
 */
export function tabLabelFit(
  available: number,
  gap: number,
  tabs: readonly TabWidths[],
  action = 0,
  more = 0,
): LabelFit {
  const width = ({ tabs: fit, action: words }: Omit<LabelFit, "fold">, fold: boolean) => {
    const shown = fold ? tabs.filter((t) => !tabFolds(t)) : tabs;
    return (
      shown.reduce(
        (sum, t) => sum + t.bare + (tabNamed(fit, t.active, t.primary) ? t.label : 0),
        gap * Math.max(0, shown.length - 1),
      ) +
      (words ? action : 0) +
      (fold ? more : 0)
    );
  };
  const canFold = more > 0 && tabs.some(tabFolds);
  for (const tier of TIERS) {
    const open = width(tier, false);
    const fold = tier.tabs !== "all" && canFold && width(tier, true) < open;
    // A pixel spare absorbs rounding, so a strip that just fits never scrolls.
    if ((fold ? width(tier, true) : open) + 1 <= available) {
      return { tabs: tier.tabs, action: tier.action && action > 0, fold };
    }
  }
  return { tabs: "none", action: false, fold: canFold };
}

const px = (value: string) => Number.parseFloat(value) || 0;

/**
 * Measures the row the tab strip in `list` shares, and says how many names it has room for and
 * whether the rarer tabs fold into More, again whenever the row or anything in it changes size or
 * content. The tabs are measured from a hidden copy in the row, a `[data-tab-measure]` holding a
 * `[data-measure-tab="<value>"]` per tab (`data-primary`, `data-pinned` as they apply), its name
 * in a `[data-tab-label]`, and a `[data-measure-more]` as wide as More: so a folded tab and a hidden
 * name are measured as readily as shown ones. An action beside the strip holds its words in a
 * `[data-action-label]` that collapses rather than unmounts, around a `[data-action-label-text]`;
 * More itself is a `[data-panel-more]`, left out of what sits beside the strip.
 */
export function useTabLabelFit(list: RefObject<HTMLElement | null>, active: string): LabelFit {
  const [fit, setFit] = useState<LabelFit>({ tabs: "all", action: true, fold: false });
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
    const measure = () => {
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
      );
      setFit((prev) =>
        prev.tabs === next.tabs && prev.action === next.action && prev.fold === next.fold
          ? prev
          : next,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const resized = new ResizeObserver(measure);
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
      resized.disconnect();
      changed.disconnect();
    };
  }, [list, active]);
  return fit;
}
