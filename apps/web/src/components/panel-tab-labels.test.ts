import { describe, expect, it } from "vitest";

import { tabFolds, tabLabelFit, tabNamed, type TabWidths } from "./panel-tab-labels";

// Five 32 px tabs, 4 px apart: 176 px bare. Their names add 30 px each, 150 px in all. The first
// two are primary and the third is open, so the primary tier names three: 90 px.
const tabs: TabWidths[] = [0, 1, 2, 3, 4].map((i) => ({
  bare: 32,
  label: 30,
  active: i === 2,
  primary: i < 2,
}));

/** The names and the action's words at `available` px, with 50 px of words. */
const fit = (available: number) => {
  const { tabs: named, action } = tabLabelFit(available, 4, tabs, 50);
  return { tabs: named, action };
};

describe("tabLabelFit", () => {
  it("names every tab while they all fit", () => {
    expect(tabLabelFit(327, 4, tabs)).toEqual({ tabs: "all", action: false, fold: false });
  });

  it("names the primary tabs and the open one once every name no longer fits", () => {
    expect(tabLabelFit(326, 4, tabs).tabs).toBe("primary");
    expect(tabLabelFit(267, 4, tabs).tabs).toBe("primary");
  });

  it("names only the open tab once the primary names no longer fit", () => {
    expect(tabLabelFit(266, 4, tabs).tabs).toBe("active");
    expect(tabLabelFit(207, 4, tabs).tabs).toBe("active");
  });

  it("names no tab once even the open one's name doesn't fit", () => {
    expect(tabLabelFit(206, 4, tabs).tabs).toBe("none");
    expect(tabLabelFit(60, 4, tabs).tabs).toBe("none");
  });

  it("counts the open tab's own name, not the longest", () => {
    const long = tabs.map((t, i) => (i === 0 ? { ...t, label: 200, primary: false } : t));
    expect(tabLabelFit(207, 4, long).tabs).toBe("active");
  });

  it("keeps an action's words before any name but the open tab's", () => {
    // 50 px of words: every name with them needs 377 px.
    expect(fit(377)).toEqual({ tabs: "all", action: true });
    expect(fit(376)).toEqual({ tabs: "primary", action: true });
    expect(fit(316)).toEqual({ tabs: "active", action: true });
    // Short of the open name and the words, the words fold first, then the other names.
    expect(fit(256)).toEqual({ tabs: "active", action: false });
    expect(fit(206)).toEqual({ tabs: "none", action: false });
  });
});

describe("folding into More", () => {
  // The last two tabs are rare and closed: folded, a 40 px More takes their 68 px.
  it("never folds while every name fits", () => {
    expect(tabLabelFit(327, 4, tabs, 0, 40).fold).toBe(false);
  });

  it("folds the rarer tabs once not every name fits, if More takes less room", () => {
    // Primary, folded: three tabs (104 px with gaps) and their 90 px of names, then More.
    expect(tabLabelFit(326, 4, tabs, 0, 40)).toEqual({
      tabs: "primary",
      action: false,
      fold: true,
    });
    expect(tabLabelFit(235, 4, tabs, 0, 40)).toEqual({
      tabs: "primary",
      action: false,
      fold: true,
    });
    // A More wider than what it would hold stays away.
    expect(tabLabelFit(326, 4, tabs, 0, 200).fold).toBe(false);
  });

  it("keeps the open tab and a pinned one out of More, and never folds a primary one", () => {
    expect(tabFolds({ primary: false, active: false })).toBe(true);
    expect(tabFolds({ primary: false, active: true })).toBe(false);
    expect(tabFolds({ primary: false, active: false, pinned: true })).toBe(false);
    expect(tabFolds({ primary: true, active: false })).toBe(false);
    const pinned = tabs.map((t) => ({ ...t, pinned: true }));
    expect(tabLabelFit(326, 4, pinned, 0, 40).fold).toBe(false);
  });
});

describe("tabNamed", () => {
  it("names a primary tab under the primary tier, and the open tab under any but none", () => {
    expect(tabNamed("primary", false, true)).toBe(true);
    expect(tabNamed("primary", false, false)).toBe(false);
    expect(tabNamed("active", true, false)).toBe(true);
    expect(tabNamed("active", false, true)).toBe(false);
    expect(tabNamed("all", false, false)).toBe(true);
    expect(tabNamed("none", true, true)).toBe(false);
  });
});
