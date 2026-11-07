import { describe, expect, it } from "vitest";

import { foldOrder, foldedTabs, tabLabelFit, tabNamed, type TabWidths } from "./panel-tab-labels";

// Five 32 px tabs, 4 px apart: 176 px bare. Their names add 30 px each, 150 px in all. The first
// two are primary and the third is open; the last two are rare.
const tabs: TabWidths[] = [0, 1, 2, 3, 4].map((i) => ({
  bare: 32,
  label: 30,
  active: i === 2,
  primary: i < 2,
}));

describe("foldOrder", () => {
  it("folds the rarer tabs together, then the primary ones from the strip's end", () => {
    expect(foldOrder(tabs)).toEqual([[3, 4], [1], [0]]);
  });

  it("never folds the open tab or a pinned one", () => {
    const pinned = tabs.map((t, i) => (i === 1 || i === 4 ? { ...t, pinned: true } : t));
    expect(foldOrder(pinned)).toEqual([[3], [0]]);
    expect(foldedTabs(pinned, 2)).toEqual([true, false, false, true, false]);
  });
});

describe("tabLabelFit without More", () => {
  it("names every tab while they all fit", () => {
    expect(tabLabelFit(327, 4, tabs)).toEqual({ tabs: "all", action: false, folds: 0 });
  });

  it("names only the open tab, then none, when nothing can fold", () => {
    expect(tabLabelFit(326, 4, tabs).tabs).toBe("active");
    expect(tabLabelFit(207, 4, tabs).tabs).toBe("active");
    expect(tabLabelFit(206, 4, tabs).tabs).toBe("none");
  });
});

/** The fit at `available` px with a 40 px More and `action` px of words. */
const fit = (available: number, action = 0) => tabLabelFit(available, 4, tabs, action, 40);

describe("tabLabelFit with More", () => {
  it("keeps the rarer tabs in More even while every name would fit", () => {
    expect(fit(327)).toEqual({ tabs: "all", action: false, folds: 1 });
    expect(fit(2000)).toEqual({ tabs: "all", action: false, folds: 1 });
  });

  it("folds nothing that isn't rare while there's room", () => {
    const primary = tabs.map((t) => ({ ...t, primary: true }));
    expect(tabLabelFit(2000, 4, primary, 0, 40)).toEqual({
      tabs: "all",
      action: false,
      folds: 0,
    });
  });

  it("folds tabs into More before any tab in the strip loses its name", () => {
    // The rare two folded: three named tabs (186 + 8 px of gaps) and More.
    expect(fit(326)).toEqual({ tabs: "all", action: false, folds: 1 });
    expect(fit(235)).toEqual({ tabs: "all", action: false, folds: 1 });
    // Then the second primary tab: two named tabs (124 + 4 px) and More.
    expect(fit(234)).toEqual({ tabs: "all", action: false, folds: 2 });
    expect(fit(169)).toEqual({ tabs: "all", action: false, folds: 2 });
    // Then the first: the open tab alone, named, beside More.
    expect(fit(168)).toEqual({ tabs: "all", action: false, folds: 3 });
    expect(fit(103)).toEqual({ tabs: "all", action: false, folds: 3 });
  });

  it("drops to icons only once the open tab's name doesn't fit beside More", () => {
    expect(fit(102)).toEqual({ tabs: "none", action: false, folds: 3 });
    // Bare icons with no More fit only from 177 px, where the open name beside More fits too.
    expect(fit(73)).toEqual({ tabs: "none", action: false, folds: 3 });
  });

  it("keeps an action's words while only the rarer tabs fold, then gives them up before a primary tab folds", () => {
    // The rare two always folded, the words kept: 234 + 50 px.
    expect(fit(377, 50)).toEqual({ tabs: "all", action: true, folds: 1 });
    expect(fit(376, 50)).toEqual({ tabs: "all", action: true, folds: 1 });
    expect(fit(285, 50)).toEqual({ tabs: "all", action: true, folds: 1 });
    // Short of that, the words go before a primary tab folds.
    expect(fit(284, 50)).toEqual({ tabs: "all", action: false, folds: 1 });
    expect(fit(234, 50)).toEqual({ tabs: "all", action: false, folds: 2 });
    expect(fit(103, 50)).toEqual({ tabs: "all", action: false, folds: 3 });
  });

  it("holds no more tabs in More than its cap, naming only the open tab past it", () => {
    // A cap of two takes the rare pair and no more.
    expect(tabLabelFit(235, 4, tabs, 0, 40, 2)).toEqual({ tabs: "all", action: false, folds: 1 });
    expect(tabLabelFit(234, 4, tabs, 0, 40, 2)).toEqual({
      tabs: "active",
      action: false,
      folds: 1,
    });
    // A cap of one can't take the pair: nothing folds.
    expect(tabLabelFit(326, 4, tabs, 0, 40, 1)).toEqual({
      tabs: "active",
      action: false,
      folds: 0,
    });
  });

  it("counts the open tab's own name, not the longest", () => {
    const long = tabs.map((t, i) => (i === 0 ? { ...t, label: 200 } : t));
    expect(tabLabelFit(103, 4, long, 0, 40)).toEqual({ tabs: "all", action: false, folds: 3 });
  });

  it("keeps a pinned tab in the strip, named while there's room", () => {
    const pinned = tabs.map((t, i) => (i === 4 ? { ...t, pinned: true } : t));
    // The open tab and the pinned one, named, beside More: 32 + 30 + 4 + 32 + 30 + 40.
    expect(tabLabelFit(169, 4, pinned, 0, 40)).toEqual({ tabs: "all", action: false, folds: 3 });
    expect(tabLabelFit(168, 4, pinned, 0, 40).tabs).toBe("active");
  });
});

describe("tabNamed", () => {
  it("names every tab under all, the open one under active, and none under none", () => {
    expect(tabNamed("all", false)).toBe(true);
    expect(tabNamed("active", true)).toBe(true);
    expect(tabNamed("active", false)).toBe(false);
    expect(tabNamed("none", true)).toBe(false);
  });
});
