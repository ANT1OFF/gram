import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Which of the panel's tabs show their names: all; the primary ones (Diff, PR and Files) and the
 * open one; only the open one; or none.
 */
export type TabLabelFit = "all" | "primary" | "active" | "none";

export interface TabWidths {
  /** The tab without its name: its icon, padding and any count. */
  readonly bare: number;
  /** What its name adds, the space before it included. */
  readonly label: number;
  readonly active: boolean;
  /** Named before the other tabs once not every name fits. */
  readonly primary: boolean;
}

export interface LabelFit {
  readonly tabs: TabLabelFit;
  /** Whether the action beside the tabs shows its words, not only its icon. */
  readonly action: boolean;
}

/** The order names give way in: the action's words outlast every name but the open tab's. */
const TIERS: readonly LabelFit[] = [
  { tabs: "all", action: true },
  { tabs: "primary", action: true },
  { tabs: "active", action: true },
  { tabs: "primary", action: false },
  { tabs: "active", action: false },
  { tabs: "none", action: false },
];

/** Whether a tab's name shows under `fit`. */
export const tabNamed = (fit: TabLabelFit, active: boolean, primary: boolean): boolean =>
  fit === "all" || (fit !== "none" && active) || (fit === "primary" && primary);

/**
 * The most names that fit `available` px, with `gap` px between tabs and `action` px for the words
 * of an action beside them (0 for none): every tab named, else the primary tabs and the open one,
 * else only the open one, else none; the action's words go before any name but the open tab's.
 * The strip scrolls only once even the bare icons don't fit.
 */
export function tabLabelFit(
  available: number,
  gap: number,
  tabs: readonly TabWidths[],
  action = 0,
): LabelFit {
  const bare = tabs.reduce((sum, t) => sum + t.bare, gap * Math.max(0, tabs.length - 1));
  const width = ({ tabs: fit, action: words }: LabelFit) =>
    tabs.reduce((sum, t) => sum + (tabNamed(fit, t.active, t.primary) ? t.label : 0), bare) +
    (words ? action : 0);
  // A pixel spare absorbs rounding, so a strip that just fits never scrolls.
  const fit = TIERS.find((tier) => width(tier) + 1 <= available) ?? TIERS.at(-1)!;
  return { tabs: fit.tabs, action: fit.action && action > 0 };
}

const px = (value: string) => Number.parseFloat(value) || 0;

/**
 * Measures the tab strip in `list` and the row it shares, and says how many names it has room for,
 * again whenever the row, a tab or anything beside the strip changes size or content. Each tab is a
 * `[data-panel-tab]`, primary with `[data-primary]`, holding its name in a `[data-tab-label]` that
 * collapses to no width when hidden, around a `[data-tab-label-text]` that keeps its natural width,
 * so a hidden name is measured as readily as a shown one. An action beside the strip holds its words
 * the same way, in a `[data-action-label]` around a `[data-action-label-text]`. `tabs` are the tabs'
 * values, comma-separated.
 */
export function useTabLabelFit(
  list: RefObject<HTMLElement | null>,
  active: string,
  tabs: string,
): LabelFit {
  const [fit, setFit] = useState<LabelFit>({ tabs: "all", action: true });
  useLayoutEffect(() => {
    const strip = list.current;
    const row = strip?.parentElement;
    if (!strip || !row) return;
    const els = tabs
      .split(",")
      .flatMap((value) => strip.querySelector<HTMLElement>(`[data-panel-tab="${value}"]`) ?? []);
    const besideStrip = () => [...row.children].filter((el) => el !== strip);
    const measure = () => {
      const rowStyle = getComputedStyle(row);
      const style = getComputedStyle(strip);
      const beside = besideStrip();
      const action = row.querySelector<HTMLElement>("[data-action-label]");
      // What the row leaves the strip and the action's words: its width but for its padding, the
      // gaps between its children, and everything beside the strip as it stands without its words.
      const words = action?.getBoundingClientRect().width ?? 0;
      const besides = beside.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0);
      const available =
        row.clientWidth -
        px(rowStyle.paddingLeft) -
        px(rowStyle.paddingRight) -
        px(rowStyle.columnGap) * beside.length -
        (besides - words) -
        px(style.paddingLeft) -
        px(style.paddingRight);
      const widths = els.map((tab) => {
        const label = tab.querySelector<HTMLElement>("[data-tab-label]");
        const shown = label?.getBoundingClientRect().width ?? 0;
        return {
          bare: tab.getBoundingClientRect().width - shown,
          label: label?.scrollWidth ?? 0,
          active: tab.dataset.panelTab === active,
          primary: tab.dataset.primary !== undefined,
        };
      });
      const next = tabLabelFit(available, px(style.columnGap), widths, action?.scrollWidth ?? 0);
      setFit((prev) => (prev.tabs === next.tabs && prev.action === next.action ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const resized = new ResizeObserver(measure);
    resized.observe(row);
    for (const tab of els) {
      resized.observe(tab);
      const text = tab.querySelector("[data-tab-label-text]");
      if (text) resized.observe(text);
    }
    // What sits beside the strip comes and goes with the open tab, and its words change: follow it.
    const observeBeside = () => {
      for (const el of besideStrip()) resized.observe(el);
      const text = row.querySelector("[data-action-label-text]");
      if (text) resized.observe(text);
    };
    observeBeside();
    const changed = new MutationObserver(() => {
      observeBeside();
      measure();
    });
    changed.observe(row, { childList: true, subtree: true, characterData: true });
    return () => {
      resized.disconnect();
      changed.disconnect();
    };
  }, [list, active, tabs]);
  return fit;
}
