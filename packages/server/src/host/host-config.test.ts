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
import {
  DISK_ID,
  hostDialToken,
  hostDiskId,
  hostIdentity,
  renewDiskId,
  VOLUME_ID_FOLDER,
} from "./host-config.ts";

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

  it("takes a new id when told, so a disk Gram refuses as replaced comes back as another", () => {
    const at = home();
    const volume = home();
    const before = hostIdentity(at, volume).diskId;
    const old = hostDiskId(at);
    expect(renewDiskId(at)).not.toBe(old);
    expect(hostDiskId(at)).not.toBe(old);
    if (process.platform !== "win32") expect(statSync(join(at, DISK_ID)).mode & 0o077).toBe(0);
    // The id it says changes with its home's, a work volume of its own kept as it is.
    expect(hostIdentity(at, volume).diskId).not.toBe(before);
    expect(hostIdentity(at, volume).diskId.endsWith(before.slice(old.length))).toBe(true);
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

describe("the token a launcher gives the host's dials", () => {
  // Sent as a header: anything but a token's form, a stray line break above all, is never sent.
  it("is read from its file at each dial, and only in a token's form", () => {
    const folder = mkdtempSync(join(tmpdir(), "gram-host-dial-token-"));
    const file = join(folder, "token");
    const token = hostDialToken({ GRAM_HOST_DIAL_TOKEN_FILE: file });
    expect(token?.()).toBeUndefined();
    writeFileSync(file, `${"a".repeat(43)}\n`);
    expect(token?.()).toBe("a".repeat(43));
    writeFileSync(file, "b".repeat(43));
    expect(token?.()).toBe("b".repeat(43));
    for (const bad of [
      "short",
      `${"a".repeat(20)}\r\nx-other: 1${"a".repeat(20)}`,
      "a".repeat(129),
    ]) {
      writeFileSync(file, bad);
      expect(token?.()).toBeUndefined();
    }
    expect(hostDialToken({})).toBeUndefined();
    rmSync(folder, { recursive: true, force: true });
  });
});
