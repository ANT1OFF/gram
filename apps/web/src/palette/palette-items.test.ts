import { describe, expect, it, vi } from "vitest";

import {
  buildSections,
  byRecent,
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

  it("hands finished threads to History in one row under the live ones", () => {
    const history = [item("history:search", "2 finished in History", { keywords: "docs" })];
    expect(shape(buildSections("docs", { ...sources, history }))).toEqual([
      ["threads", ["t2"]],
      ["history", ["history:search"]],
      ["projects", ["p2"]],
    ]);
    expect(
      shape(buildSections("docs", { ...sources, history }, view({ kind: "threads" }))),
    ).toEqual([
      ["threads", ["t2"]],
      ["history", ["history:search"]],
    ]);
    // Untyped, History is a destination of its own; the row is for a search.
    expect(shape(buildSections("", { ...sources, history }))).not.toContainEqual(
      expect.arrayContaining(["history"]),
    );
  });

  it("shows only actions after >", () => {
    expect(buildSections(">sett", sources).map((s) => [s.id, s.items.map((i) => i.id)])).toEqual([
      ["actions", ["a2"]],
    ]);
  });
});

const view = (extra: Partial<Parameters<typeof buildSections>[2] & object> = {}) => ({
  kind: "all" as const,
  recent: [] as string[],
  expanded: new Set<string>(),
  expand: () => {},
  ...extra,
});
const shape = (sections: ReturnType<typeof buildSections>) =>
  sections.map((s) => [s.id, s.items.map((i) => i.id)]);

describe("buildSections, unfiltered", () => {
  const many = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => item(`${prefix}${i}`, `${prefix} ${i}`));
  const destinations = [
    item("go:workers", "Workers"),
    item("go:memory", "Memory"),
    item("go:quiet", "Quiet"),
    item("go:inbox", "Inbox"),
    item("go:history", "History"),
    item("go:usage", "Usage"),
    item("go:settings", "Settings"),
  ];
  const full = {
    destinations,
    threads: many("thread", 12),
    workers: many("worker", 9),
    features: many("feature", 4),
    prs: many("pr", 4),
    projects: many("project", 3),
    actions: many("action", 20),
  };
  it("opens short: destinations, recent first, then threads and workers, each capped", () => {
    const sections = buildSections("", full, view({ recent: ["go:settings"] }));
    expect(shape(sections)).toEqual([
      ["destinations", ["go:settings", "go:workers", "go:memory", "go:quiet", "more:destinations"]],
      ["threads", ["thread0", "thread1", "thread2", "more:threads"]],
      ["workers", ["worker0", "worker1", "worker2", "more:workers"]],
    ]);
    expect(sections[0]!.label).toBe("Go to");
    // The recent one says so; the rest are suggested.
    expect(sections[0]!.items.map((i) => i.hint)).toEqual([
      "Recent",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const more = sections[1]!.items.at(-1)!;
    expect(more).toMatchObject({ label: "Show 9 more", more: true, stay: true });
  });

  it("lists a group in full once its Show more is picked", () => {
    const expand = vi.fn();
    const capped = buildSections("", full, view({ expand }));
    flattenSections(capped)
      .find((i) => i.id === "more:workers")!
      .run();
    expect(expand).toHaveBeenCalledWith("workers");
    const open = buildSections("", full, view({ expanded: new Set(["workers"]) }));
    expect(open.find((s) => s.id === "workers")!.items).toHaveLength(9);
  });

  it("never hides a single row behind Show more", () => {
    const sections = buildSections("", { ...full, workers: many("worker", 4) }, view());
    expect(sections.find((s) => s.id === "workers")!.items.map((i) => i.id)).toEqual([
      "worker0",
      "worker1",
      "worker2",
      "worker3",
    ]);
  });

  it("matches destinations first when typed, recent ones ahead", () => {
    const sections = buildSections("m", full, view({ recent: ["go:memory"] }));
    expect(sections[0]).toMatchObject({ id: "destinations", label: "Go to" });
    expect(sections[0]!.items.map((i) => i.id)).toEqual(["go:memory"]);
  });

  it("lists one kind alone under its filter, and actions with the destinations", () => {
    expect(shape(buildSections("", full, view({ kind: "workers" })))).toEqual([
      ["workers", full.workers.map((i) => i.id)],
    ]);
    const threads = buildSections("", full, view({ kind: "threads" }));
    expect(threads.map((s) => s.id)).toEqual(["threads"]);
    expect(threads[0]!.items).toHaveLength(12);
    const actions = buildSections("", full, view({ kind: "actions" }));
    expect(actions.map((s) => s.id)).toEqual(["destinations", "actions"]);
    expect(actions[1]!.items.at(-1)!.label).toBe("Show 12 more");
    // A leading > is the Actions filter, whatever is picked.
    expect(buildSections(">", full, view({ kind: "threads" })).map((s) => s.id)).toEqual([
      "destinations",
      "actions",
    ]);
  });
});

describe("byRecent", () => {
  it("puts the most recently gone to first and keeps the rest in order", () => {
    const items = [item("a", "A"), item("b", "B"), item("c", "C"), item("d", "D")];
    expect(byRecent(items, ["c", "a"]).map((i) => [i.id, i.hint])).toEqual([
      ["c", "Recent"],
      ["a", "Recent"],
      ["b", undefined],
      ["d", undefined],
    ]);
  });
});
