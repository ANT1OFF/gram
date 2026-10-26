import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { installerAssetName } from "@gram/shell/modules/update";

describe("installerAssetName", () => {
  // The two are only ever compared on a user's machine, when an update finds no installer.
  it("is the name electron-builder gives the installer", () => {
    const config = readFileSync(join(import.meta.dirname, "../../../electron-builder.yml"), "utf8");
    const artifactName = /^nsis:\n(?:[ #].*\n)*? {2}artifactName: (.+)$/m.exec(config)?.[1];
    expect(artifactName).toBeDefined();
    const installer = artifactName!
      .replace("${version}", "1.2.3-rc.1")
      .replace("${arch}", "x64")
      .replace("${ext}", "exe");
    expect(installer).toBe("gram_1.2.3-rc.1_x64-setup.exe");
    expect(installerAssetName("1.2.3-rc.1")).toBe(installer);
  });
});
