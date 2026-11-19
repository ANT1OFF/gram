import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DISK_ID, hostDiskId } from "./host-config.ts";

describe("the id of the host's disk", () => {
  const homes: Array<string> = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });
  const home = () => {
    const made = mkdtempSync(join(tmpdir(), "gram-host-disk-"));
    homes.push(made);
    return made;
  };

  it("is made once, owner-only, and kept from then on", () => {
    const at = home();
    const id = hostDiskId(at);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(hostDiskId(at)).toBe(id);
    if (process.platform !== "win32") expect(statSync(join(at, DISK_ID)).mode & 0o077).toBe(0);
    // Another disk, which has the key and join but not this file, says another id.
    expect(hostDiskId(home())).not.toBe(id);
  });

  it("replaces one that isn't an id, so the host reads as on another disk", () => {
    const at = home();
    writeFileSync(join(at, DISK_ID), "not an id\n", { mode: 0o600 });
    const id = hostDiskId(at);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(readFileSync(join(at, DISK_ID), "utf8").trim()).toBe(id);
  });
});
