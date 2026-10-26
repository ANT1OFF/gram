import { describe, expect, it } from "vitest";

import { ghSourceCopy, nativeSourceNote } from "./source-copy";

describe("update source copy", () => {
  it("says the signed updater reads anonymously, and names no repository without a source", () => {
    expect(nativeSourceNote("o/r")).toBe(
      "Releases are read anonymously from the public o/r repository; no sign-in is needed.",
    );
    expect(nativeSourceNote(undefined)).not.toMatch(/\bgh\b|ANT1OFF/);
  });

  it("keeps the gh updater's wording, with the repository it reads", () => {
    expect(ghSourceCopy({ repo: "o/r", visibility: "private" })).toEqual({
      automaticChecks:
        "Check for private o/r releases with your gh login. Never installs or interrupts agents.",
    });
    expect(ghSourceCopy({ repo: "o/r", visibility: "public" }).automaticChecks).toBe(
      "Check for o/r releases with your gh login. Never installs or interrupts agents.",
    );
    expect(Object.values(ghSourceCopy(undefined)).join(" ")).not.toContain("ANT1OFF");
  });
});
