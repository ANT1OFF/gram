import { describe, expect, it } from "@effect/vitest";
import { roleAgentsFrom } from "./role-agents.ts";

describe("roleAgentsFrom", () => {
  it("lets a deployment add Grok Build and Antigravity to the roles, and nothing else", () => {
    expect(roleAgentsFrom("grok")).toEqual(["grok"]);
    expect(roleAgentsFrom("antigravity, grok")).toEqual(["grok", "antigravity"]);
    expect(roleAgentsFrom(" Grok , opencode")).toEqual(["grok"]);
    expect(roleAgentsFrom("opencode,claude")).toEqual([]);
    expect(roleAgentsFrom(undefined)).toEqual([]);
  });
});
