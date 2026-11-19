import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DISK_ID, hostDiskId, hostIdentity, VOLUME_ID_FOLDER } from "./host-config.ts";

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

  it("keeps one id however often it is asked, and a repair leaves no lock behind", () => {
    const at = home();
    // Each start reads back the id made first.
    const ids = new Set(Array.from({ length: 8 }, () => hostDiskId(at)));
    expect(ids.size).toBe(1);
    // A repair of one that isn't an id leaves a valid one alone once it holds the lock.
    writeFileSync(join(at, DISK_ID), "x\n", { mode: 0o600 });
    const repaired = hostDiskId(at);
    expect(hostDiskId(at)).toBe(repaired);
    expect(existsSync(join(at, `${DISK_ID}.lock`))).toBe(false);
  });

  it("says the disk of a work volume of its own too, so swapping that volume is another disk", () => {
    const at = home();
    // Inside the home folder: the home's id alone, as before.
    expect(hostIdentity(at, join(at, "repos"))).toEqual({ diskId: hostDiskId(at) });
    // On storage of its own: both, kept apart.
    const volume = home();
    const both = hostIdentity(at, volume);
    expect(both.unknown).toBeUndefined();
    expect(both.diskId.startsWith(`${hostDiskId(at)}-`)).toBe(true);
    expect(both.diskId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(hostIdentity(at, volume)).toEqual(both);
    // The volume wiped or swapped under a home that stayed: before, that read as a restart.
    rmSync(join(volume, VOLUME_ID_FOLDER), { recursive: true, force: true });
    expect(hostIdentity(at, volume).diskId).not.toBe(both.diskId);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "says a work volume whose id can't be kept is unknown, never guessed",
    () => {
      const at = home();
      const volume = home();
      chmodSync(volume, 0o500);
      try {
        const said = hostIdentity(at, volume);
        expect(said.unknown).toBe(true);
        expect(hostIdentity(at, volume).diskId).not.toBe(said.diskId);
      } finally {
        chmodSync(volume, 0o700);
      }
    },
  );
});
