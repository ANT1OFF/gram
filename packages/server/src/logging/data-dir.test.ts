import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultDataDir, osDataRoot, securePrivateDir } from "./data-dir.ts";

describe("Gram data directory", () => {
  it("honors the explicit Gram directory", () => {
    expect(defaultDataDir({ GRAM_DATA_DIR: "/portable/gram" })).toBe("/portable/gram");
  });

  it("resolves conventional OS roots without filesystem access", () => {
    expect(osDataRoot({ env: {}, platform: "darwin", homeDir: "/Users/me" })).toBe(
      "/Users/me/Library/Application Support",
    );
    expect(
      osDataRoot({
        env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
        platform: "win32",
        homeDir: "C:\\Users\\me",
      }),
    ).toBe("C:\\Users\\me\\AppData\\Roaming");
    expect(
      osDataRoot({ env: { XDG_DATA_HOME: "/data" }, platform: "linux", homeDir: "/home/me" }),
    ).toBe("/data");
    expect(osDataRoot({ env: {}, platform: "linux", homeDir: "/home/me" })).toBe(
      "/home/me/.local/share",
    );
  });

  it("falls back to the home directory, then a relative root", () => {
    expect(osDataRoot({ env: {}, platform: "win32", homeDir: "C:\\Users\\me" })).toBe(
      "C:\\Users\\me",
    );
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(osDataRoot({ env: {}, platform, homeDir: undefined })).toBe(".");
    }
  });
});

describe.skipIf(process.platform === "win32")("securePrivateDir", () => {
  it("creates the data folder owner-only, whatever the umask", () => {
    const root = mkdtempSync(join(tmpdir(), "gram-data-"));
    const previous = process.umask(0o022);
    try {
      const dir = join(root, "nested", "gram-state");
      expect(securePrivateDir(dir)).toBe(false);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previous);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tightens an existing folder others can read or enter", () => {
    const root = mkdtempSync(join(tmpdir(), "gram-data-"));
    try {
      const dir = join(root, "gram-state");
      mkdirSync(dir);
      chmodSync(dir, 0o755);
      expect(securePrivateDir(dir)).toBe(true);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
