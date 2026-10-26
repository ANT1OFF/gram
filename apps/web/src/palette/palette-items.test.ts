import { describe, expect, it } from "vitest";

import {
  buildSections,
  flattenSections,
  matchItems,
  parsePaletteQuery,
  type PaletteItem,
} from "./palette-items";

const item = (id: string, label: string, extra: Partial<PaletteItem> = {}): PaletteItem => ({
  id,
  label,
  run: () => {},
  ...extra,
});

const sources = {
  threads: [
    item("t1", "Fix flaky retry test", { hint: "api", keywords: "fix/flaky-retry" }),
    item("t2", "Rewrite the README", { hint: "docs" }),
  ],
  projects: [item("p1", "api"), item("p2", "docs")],
  actions: [item("a1", "New thread"), item("a2", "Settings")],
};

describe("parsePaletteQuery", () => {
  it("switches to actions on a leading >", () => {
    expect(parsePaletteQuery("> set")).toEqual({ mode: "actions", text: "set" });
    expect(parsePaletteQuery(" readme ")).toEqual({ mode: "search", text: "readme" });
  });
});

describe("matchItems", () => {
  it("ranks label prefix, then substring, then hint/keywords", () => {
    const items = [
      item("a", "Deploy api"),
      item("b", "api docs"),
      item("c", "Other", { keywords: "api" }),
    ];
    expect(matchItems(items, "api").map((i) => i.id)).toEqual(["b", "a", "c"]);
  });

  it("keeps the original order for an empty query", () => {
    expect(matchItems(sources.actions, "").map((i) => i.id)).toEqual(["a1", "a2"]);
  });
});

describe("buildSections", () => {
  it("searches threads and projects, dropping empty sections", () => {
    const sections = buildSections("docs", sources);
    expect(sections.map((s) => [s.id, s.items.map((i) => i.id)])).toEqual([
      ["threads", ["t2"]],
      ["projects", ["p2"]],
    ]);
  });

  it("matches branch keywords", () => {
    expect(flattenSections(buildSections("fix/flaky", sources)).map((i) => i.id)).toEqual(["t1"]);
  });

  it("shows only actions after >", () => {
    expect(buildSections(">sett", sources).map((s) => [s.id, s.items.map((i) => i.id)])).toEqual([
      ["actions", ["a2"]],
    ]);
  });
});
