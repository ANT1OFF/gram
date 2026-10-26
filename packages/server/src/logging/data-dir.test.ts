import { describe, expect, it } from "vitest";
import { defaultDataDir, osDataRoot } from "./data-dir.ts";

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
