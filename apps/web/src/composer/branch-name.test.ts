import { describe, expect, it } from "vitest";

import { branchRef, randomBranchName } from "./branch-name";

describe("randomBranchName", () => {
  it("builds adjective-animal-hex", () => {
    expect(randomBranchName()).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
  });

  it("is deterministic for a given random source", () => {
    expect(randomBranchName(() => 0)).toBe("amber-otter-0000");
    expect(randomBranchName(() => 0.9999)).toBe("zesty-yak-fff9");
  });
});

describe("branchRef", () => {
  it("joins the prefix and collapses whitespace", () => {
    expect(branchRef("fix", "  flaky retry test ")).toBe("fix/flaky-retry-test");
    expect(branchRef("", "main")).toBe("main");
  });
});
