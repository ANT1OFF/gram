import { applySettingsPatch, DEFAULT_SETTINGS } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { navigationCurrent, routeProblem, shellFor, shownNavigation } from "./store";

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

  it("leave out empty and repeated groups, and destinations that are no path", () => {
    expect(
      shownNavigation([
        { id: "govern", label: "Govern", items: [item("a"), item("a"), item("b", "https://x")] },
        { id: "govern", label: "Again", items: [item("c")] },
        { id: "empty", label: "Empty", items: [] },
      ]),
    ).toEqual([{ id: "govern", label: "Govern", items: [item("a")] }]);
  });
});
