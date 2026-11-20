import { describe, expect, it } from "@effect/vitest";
import { isSharedPath } from "./shared-folder.ts";

describe("isSharedPath", () => {
  it("never carries what would make a folder a repository on the machine it lands on", () => {
    for (const path of [
      ".git/config",
      "app/.git/hooks/post-merge",
      "app/.GIT/config",
      "HEAD",
      "bare/HEAD",
    ])
      expect(isSharedPath(path)).toBe(false);
    for (const path of ["notes.md", "app/.gitignore", "app/.github/workflows/ci.yml", "HEADER.md"])
      expect(isSharedPath(path)).toBe(true);
  });
});
