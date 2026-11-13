import { applySettingsPatch, DEFAULT_SETTINGS } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  foldable,
  groupOpen,
  hiddenCount,
  itemName,
  navigationAt,
  currentDestination,
  navigationCurrent,
  panelOffered,
  routeProblem,
  shellFor,
  shownCount,
  shownNavigation,
  shownRows,
  toolCardFor,
  toolMatches,
} from "./store";

describe("what a mount takes of the embedding app's additions", () => {
  const shell = { navigation: [{ id: "govern", label: "Govern", items: [] }] };

  it("is nothing while the server's hosted features are off", () => {
    expect(shellFor(DEFAULT_SETTINGS, shell)).toEqual({});
    const off = applySettingsPatch(DEFAULT_SETTINGS, { experimental: { embedding: false } });
    expect(shellFor(off, shell)).toEqual({});
  });

  it("is all of it once they are on", () => {
    const on = applySettingsPatch(DEFAULT_SETTINGS, { experimental: { embedding: true } });
    expect(shellFor(on, shell)).toBe(shell);
    expect(shellFor(on, undefined)).toEqual({});
  });
});

describe("an added page's path", () => {
  it("is a path of its own", () => {
    expect(routeProblem("/govern/policies", new Set())).toBeUndefined();
    expect(routeProblem("/agents/$agentId", new Set())).toBeUndefined();
  });

  it("never takes one of Gram's", () => {
    for (const path of [
      "/",
      "/settings",
      "/settings/about",
      "/t/$threadId",
      "/w/x/files",
      "/usage",
    ])
      expect(routeProblem(path, new Set())).toMatch(/Gram's own/);
  });

  it("is refused when it is no path, or taken", () => {
    expect(routeProblem("govern", new Set())).toMatch(/not a path/);
    expect(routeProblem("//other.example/x", new Set())).toMatch(/not a path/);
    expect(routeProblem("/govern?x=1", new Set())).toMatch(/not a path/);
    expect(routeProblem("/govern", new Set(["/govern"]))).toMatch(/twice/);
  });
});

const item = (id: string, to = `/x/${id}`) => ({ id, label: id, to });

describe("navigation groups", () => {
  it("mark the destination the window is at or under", () => {
    expect(navigationCurrent("/govern/policies", "/govern/policies")).toBe(true);
    expect(navigationCurrent("/govern/policies/p1", "/govern/policies")).toBe(true);
    expect(navigationCurrent("/govern/policies-old", "/govern/policies")).toBe(false);
    expect(navigationCurrent("/usage", "/")).toBe(false);
  });

  it("marks the row whose own path matches before one that only lists the path", () => {
    const threads = { to: "/threads", alsoAt: ["/t", "/new"] };
    const start = { to: "/new" };
    expect(currentDestination("/t/th_1", [threads, start])).toBe("/threads");
    expect(currentDestination("/new", [threads, start])).toBe("/new");
    expect(currentDestination("/new", [threads])).toBe("/threads");
    expect(currentDestination("/threads", [threads, start])).toBe("/threads");
    expect(currentDestination("/usage", [threads, start])).toBeUndefined();
  });

  it("leave out empty and repeated groups, and destinations that are no path", () => {
    expect(
      shownNavigation([
        { id: "govern", label: "Govern", items: [item("a"), item("a"), item("b", "https://x")] },
        { id: "govern", label: "Again", items: [item("c")] },
        { id: "empty", label: "Empty", items: [] },
      ]),
    ).toEqual([{ id: "govern", label: "Govern", items: [item("a")] }]);
  });

  it("list each group at its placement, at the foot when it names none", () => {
    const groups = [
      { id: "foot", label: "Govern", items: [item("a")] },
      { id: "main", placement: "main" as const, items: [item("b")] },
      { id: "foot2", placement: "foot" as const, items: [item("c")] },
    ];
    expect(navigationAt(groups, "main").map((group) => group.id)).toEqual(["main"]);
    expect(navigationAt(groups, "foot").map((group) => group.id)).toEqual(["foot", "foot2"]);
  });

  it("draw a count only above 0, as a whole number", () => {
    expect(shownCount(undefined)).toBeUndefined();
    expect(shownCount(0)).toBeUndefined();
    expect(shownCount(-2)).toBeUndefined();
    expect(shownCount(Number.NaN)).toBeUndefined();
    expect(shownCount(3.7)).toBe(3);
    expect(shownCount(12)).toBe(12);
  });

  it("name a destination with its group's heading, where it has one", () => {
    expect(itemName({ id: "g", label: "Govern", items: [] }, "Policies")).toBe("Govern: Policies");
    expect(itemName({ id: "g", items: [] }, "Policies")).toBe("Policies");
  });
});

describe("where the right panel is offered", () => {
  const home = { threadInView: false, threadInRepo: false };
  const chat = { threadInView: true, threadInRepo: false };
  const code = { threadInView: true, threadInRepo: true };

  it("is everywhere by default, as on Gram's own", () => {
    for (const page of [home, chat, code]) expect(panelOffered("shown", page)).toBe(true);
  });

  it("is only a thread in a repository under `code`", () => {
    expect(panelOffered("code", home)).toBe(false);
    expect(panelOffered("code", chat)).toBe(false);
    expect(panelOffered("code", code)).toBe(true);
  });
});

const First = () => null;
const Second = () => null;

describe("an embedding app's tool cards", () => {
  it("matches a tool by its name, or by a pattern where * is any run of characters", () => {
    expect(toolMatches("Bash", "Bash")).toBe(true);
    expect(toolMatches("Bash", "BashOutput")).toBe(false);
    expect(toolMatches("mcp__*__create_order", "mcp__acme__create_order")).toBe(true);
    expect(toolMatches("mcp__*__create_order", "mcp__acme__create_orders")).toBe(false);
    expect(toolMatches("*create_order", "create_order")).toBe(true);
    expect(toolMatches("mcp__acme__*", "mcp__acme__refund")).toBe(true);
    expect(toolMatches("mcp__acme__*", "mcp__other__refund")).toBe(false);
    expect(toolMatches("a*b*c", "a-b-c")).toBe(true);
    expect(toolMatches("a*b*c", "a-c-b")).toBe(false);
    // The two ends may not share characters.
    expect(toolMatches("ab*ba", "aba")).toBe(false);
  });

  it("uses the first card that matches, and none where none does", () => {
    const cards = [
      { tool: "mcp__acme__create_order", component: First },
      { tool: "mcp__acme__*", component: Second },
    ];
    expect(toolCardFor(cards, "mcp__acme__create_order")).toBe(First);
    expect(toolCardFor(cards, "mcp__acme__refund")).toBe(Second);
    expect(toolCardFor(cards, "Bash")).toBeUndefined();
    expect(toolCardFor([], "Bash")).toBeUndefined();
  });
});

describe("a collapsible navigation group", () => {
  const items = [
    { id: "connections", label: "Connections", to: "/connections", count: 2 },
    { id: "servers", label: "MCP servers", to: "/mcp-servers" },
    { id: "access", label: "Access", to: "/access", count: 1 },
  ];
  const govern = { id: "govern", label: "Govern", collapsible: true, collapsed: true, items };

  it("folds only when asked and when it has a heading to fold under", () => {
    expect(foldable(govern)).toBe(true);
    expect(foldable({ id: "govern", label: "Govern", items })).toBe(false);
    expect(foldable({ id: "govern", collapsible: true, items })).toBe(false);
    expect(foldable({ ...govern, label: "  " })).toBe(false);
  });

  it("starts as the embedding app says, then as the person left it", () => {
    expect(groupOpen(govern, undefined)).toBe(false);
    expect(groupOpen({ id: "govern", label: "Govern", collapsible: true, items }, undefined)).toBe(
      true,
    );
    expect(groupOpen(govern, true)).toBe(true);
    expect(groupOpen({ ...govern, collapsed: false }, false)).toBe(false);
    // A group that does not fold is always open, whatever was kept for its id.
    expect(groupOpen({ ...govern, collapsible: false }, false)).toBe(true);
  });

  it("closed, keeps the row the window is at and counts what it hides", () => {
    expect(shownRows(govern, true, "/access")).toEqual(items);
    expect(shownRows(govern, false, undefined)).toEqual([]);
    expect(shownRows(govern, false, "/access").map((row) => row.id)).toEqual(["access"]);
    expect(hiddenCount(govern, false, undefined)).toBe(3);
    expect(hiddenCount(govern, false, "/access")).toBe(2);
    expect(hiddenCount(govern, false, "/connections")).toBe(1);
    expect(hiddenCount(govern, true, undefined)).toBeUndefined();
    expect(hiddenCount({ ...govern, items: [items[1]!] }, false, undefined)).toBeUndefined();
  });
});
