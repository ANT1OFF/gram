import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PIN_KEY,
  PRERELEASE_KEY,
  PREFS_FILE,
  readPrereleaseChannel,
  readUpdatePrefs,
  updatePrefsWriter,
  writeUpdatePrefs,
  type UpdatePrefs,
} from "./prerelease-flag.ts";

const writePrereleaseFlag = (dir: string, channel: UpdatePrefs["channel"]) =>
  writeUpdatePrefs(dir, { channel });

/** The flag as the file holds it on prerelease. */
const AUDIT_PATTERN = /"gram\.updatePrerelease"\s*:\s*"1"/;

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const tempDir = () => (dir = mkdtempSync(join(tmpdir(), "gram-prefs-")));
const read = () => readFileSync(join(dir, PREFS_FILE), "utf8");

describe("writeUpdatePrefs", () => {
  it("writes the flag on prerelease and removes it on stable, keeping other keys", async () => {
    tempDir();
    writeFileSync(join(dir, PREFS_FILE), JSON.stringify({ "other.key": "x", nested: { a: 1 } }));

    await writePrereleaseFlag(dir, "prerelease");
    expect(read()).toMatch(AUDIT_PATTERN);
    expect(JSON.parse(read())).toEqual({
      "other.key": "x",
      nested: { a: 1 },
      [PRERELEASE_KEY]: "1",
    });

    await writePrereleaseFlag(dir, "stable");
    expect(read()).not.toMatch(AUDIT_PATTERN);
    expect(JSON.parse(read())).toEqual({ "other.key": "x", nested: { a: 1 } });
  });

  it("creates the data dir and file when they don't exist", async () => {
    tempDir();
    const nested = join(dir, "gram-state");
    await writePrereleaseFlag(nested, "prerelease");
    expect(JSON.parse(readFileSync(join(nested, PREFS_FILE), "utf8"))).toEqual({
      [PRERELEASE_KEY]: "1",
    });
  });

  it("leaves a file that isn't a JSON object untouched and rejects", async () => {
    tempDir();
    for (const content of ["{not json", "[1,2]"]) {
      writeFileSync(join(dir, PREFS_FILE), content);
      await expect(writePrereleaseFlag(dir, "prerelease")).rejects.toThrow();
      expect(read()).toBe(content);
    }
  });

  it("applies queued writes in order", async () => {
    tempDir();
    const writer = updatePrefsWriter(dir);
    const write = (channel: UpdatePrefs["channel"]) => writer({ channel });
    await Promise.all([write("prerelease"), write("stable"), write("prerelease")]);
    expect(read()).toMatch(AUDIT_PATTERN);
    await Promise.all([write("prerelease"), write("stable")]);
    expect(read()).not.toMatch(AUDIT_PATTERN);
  });

  it("writes the pin beside the flag and removes it once there's none", async () => {
    tempDir();
    await writeUpdatePrefs(dir, { channel: "stable", pinnedVersion: "1.2.0" });
    expect(JSON.parse(read())).toEqual({ [PIN_KEY]: "1.2.0" });
    expect(await readUpdatePrefs(dir)).toEqual({ channel: "stable", pinnedVersion: "1.2.0" });
    await writeUpdatePrefs(dir, { channel: "prerelease" });
    expect(JSON.parse(read())).toEqual({ [PRERELEASE_KEY]: "1" });
    expect(await readUpdatePrefs(dir)).toEqual({ channel: "prerelease" });
  });
});

describe("update opt-ins", () => {
  it("requires literal consent for automatic checks and revokes it", async () => {
    tempDir();
    expect(await readUpdatePrefs(dir)).toEqual({ channel: "stable" });
    await writeUpdatePrefs(dir, { channel: "prerelease", automaticChecks: true });
    expect(await readUpdatePrefs(dir)).toEqual({ channel: "prerelease", automaticChecks: true });
    await writeUpdatePrefs(dir, { channel: "stable", automaticChecks: false });
    expect(await readUpdatePrefs(dir)).toEqual({ channel: "stable" });
  });
});

describe("readPrereleaseChannel", () => {
  it("reads back the mirrored channel, stable when there's no readable flag", async () => {
    tempDir();
    expect(await readPrereleaseChannel(dir)).toBe("stable");
    await writePrereleaseFlag(dir, "prerelease");
    expect(await readPrereleaseChannel(dir)).toBe("prerelease");
    await writePrereleaseFlag(dir, "stable");
    expect(await readPrereleaseChannel(dir)).toBe("stable");
    writeFileSync(join(dir, PREFS_FILE), "{");
    expect(await readPrereleaseChannel(dir)).toBe("stable");
  });

  it("reads no pin from garbage or a pin that isn't a string", async () => {
    tempDir();
    for (const content of ["{", "null", JSON.stringify({ [PIN_KEY]: 1 })]) {
      writeFileSync(join(dir, PREFS_FILE), content);
      expect(await readUpdatePrefs(dir), content).toEqual({ channel: "stable" });
    }
  });
});
