import { useLayoutEffect, useState, type RefObject } from "react";

/** Which of the panel's tabs show their names: all, only the open one, or none. */
export type TabLabelFit = "all" | "active" | "none";

export interface TabWidths {
  /** The tab without its name: its icon, padding and any count. */
  readonly bare: number;
  /** What its name adds, the space before it included. */
  readonly label: number;
  readonly active: boolean;
}

/**
 * The most names that fit `available` px, with `gap` px between tabs: every tab named, else only
 * the open one, else none. The strip scrolls only once even the bare icons don't fit.
 */
export function tabLabelFit(
  available: number,
  gap: number,
  tabs: readonly TabWidths[],
): TabLabelFit {
  const gaps = gap * Math.max(0, tabs.length - 1);
  const bare = tabs.reduce((sum, t) => sum + t.bare, gaps);
  const named = tabs.reduce((sum, t) => sum + t.label, bare);
  const open = tabs.reduce((sum, t) => sum + (t.active ? t.label : 0), bare);
  // A pixel spare absorbs rounding, so a strip that just fits never scrolls.
  if (named + 1 <= available) return "all";
  if (open + 1 <= available) return "active";
  return "none";
}

const px = (value: string) => Number.parseFloat(value) || 0;

/**
 * Measures the tab strip in `list` and says how many names it has room for, again whenever it or a
 * tab changes size. Each tab is a `[data-panel-tab]` holding its name in a `[data-tab-label]` that
 * collapses to no width when hidden, around a `[data-tab-label-text]` that keeps its natural width,
 * so a hidden name is measured as readily as a shown one. `tabs` are their values, comma-separated.
 */
export function useTabLabelFit(
  list: RefObject<HTMLElement | null>,
  active: string,
  tabs: string,
): TabLabelFit {
  const [fit, setFit] = useState<TabLabelFit>("all");
  useLayoutEffect(() => {
    const strip = list.current;
    if (!strip) return;
    const els = tabs
      .split(",")
      .flatMap((value) => strip.querySelector<HTMLElement>(`[data-panel-tab="${value}"]`) ?? []);
    const measure = () => {
      const style = getComputedStyle(strip);
      const available = strip.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
      const widths = els.map((tab) => {
        const label = tab.querySelector<HTMLElement>("[data-tab-label]");
        const shown = label?.getBoundingClientRect().width ?? 0;
        return {
          bare: tab.getBoundingClientRect().width - shown,
          label: label?.scrollWidth ?? 0,
          active: tab.dataset.panelTab === active,
        };
      });
      setFit(tabLabelFit(available, px(style.columnGap), widths));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    for (const tab of els) {
      observer.observe(tab);
      const text = tab.querySelector("[data-tab-label-text]");
      if (text) observer.observe(text);
    }
    return () => observer.disconnect();
  }, [list, active, tabs]);
  return fit;
}
