import { describe, expect, it } from "vitest";

import { ghSourceCopy, nativeSourceNote } from "./source-copy";

describe("update source copy", () => {
  it("names the repository the signed updater reads, and none without a source", () => {
    expect(nativeSourceNote("o/r")).toContain("o/r");
    expect(nativeSourceNote(undefined)).not.toMatch(/\bgh\b|ANT1OFF/);
  });

  it("says a private repository is private, with the repository the gh updater reads", () => {
    const privately = ghSourceCopy({ repo: "o/r", visibility: "private" }).automaticChecks;
    const publicly = ghSourceCopy({ repo: "o/r", visibility: "public" }).automaticChecks;
    expect(privately).toContain("private o/r");
    expect(publicly).toContain("o/r");
    expect(publicly).not.toContain("private");
    expect(Object.values(ghSourceCopy(undefined)).join(" ")).not.toContain("ANT1OFF");
  });
});
