import { describe, expect, it } from "vitest";

import { tabLabelFit, type TabWidths } from "./panel-tab-labels";

// Five 32 px tabs, 4 px apart: 176 px bare. Their names add 30 px each, 150 px in all.
const tabs: TabWidths[] = [0, 1, 2, 3, 4].map((i) => ({
  bare: 32,
  label: 30,
  active: i === 2,
}));

describe("tabLabelFit", () => {
  it("names every tab while they all fit", () => {
    expect(tabLabelFit(327, 4, tabs)).toBe("all");
  });

  it("names only the open tab once every name no longer fits", () => {
    expect(tabLabelFit(326, 4, tabs)).toBe("active");
    expect(tabLabelFit(207, 4, tabs)).toBe("active");
  });

  it("names no tab once even the open one's name doesn't fit", () => {
    expect(tabLabelFit(206, 4, tabs)).toBe("none");
    expect(tabLabelFit(60, 4, tabs)).toBe("none");
  });

  it("counts the open tab's own name, not the longest", () => {
    const long = tabs.map((t, i) => (i === 0 ? { ...t, label: 200 } : t));
    expect(tabLabelFit(207, 4, long)).toBe("active");
  });
});
