import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { noticesPath, openAcknowledgements } from "./acknowledgements.ts";

describe("noticesPath", () => {
  it("reads Resources/ when packaged and the build output in development", () => {
    expect(
      noticesPath({
        isPackaged: true,
        resourcesPath: "/A/Gram.app/Contents/Resources",
        appPath: "/x",
      }),
    ).toBe("/A/Gram.app/Contents/Resources/THIRD-PARTY-NOTICES.txt");
    expect(
      noticesPath({ isPackaged: false, resourcesPath: "/e", appPath: "/repo/apps/desktop" }),
    ).toBe("/repo/out/notices/THIRD-PARTY-NOTICES.txt");
  });
});

describe("openAcknowledgements", () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-notices-"));

  it("opens the notices file", async () => {
    const file = join(dir, "THIRD-PARTY-NOTICES.txt");
    writeFileSync(file, "notices\n");
    const openPath = vi.fn(async () => "");
    expect(await openAcknowledgements(file, openPath)).toBe(true);
    expect(openPath).toHaveBeenCalledWith(file);
  });

  it("reports a missing or empty file, and one the system won't open", async () => {
    const openPath = vi.fn(async () => "");
    expect(await openAcknowledgements(join(dir, "missing.txt"), openPath)).toBe(false);
    const empty = join(dir, "empty.txt");
    writeFileSync(empty, "");
    expect(await openAcknowledgements(empty, openPath)).toBe(false);
    expect(openPath).not.toHaveBeenCalled();

    const file = join(dir, "notices.txt");
    writeFileSync(file, "notices\n");
    expect(await openAcknowledgements(file, async () => "Failed to open")).toBe(false);
  });
});
