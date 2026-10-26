import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { snapshotCandidate, sweepStaleCandidateDirs } from "./native-snapshot.ts";

const DAY = 24 * 60 * 60_000;

describe("snapshot crash cleanup", () => {
  it("sweeps only old private owned candidate directories, without following symlinks", async () => {
    const temp = await mkdtemp(join(tmpdir(), "gram-snapshot-sweep-test-"));
    const now = Date.now();
    const old = new Date(now - 2 * DAY);
    try {
      for (const name of [
        "gram-native-candidate-old",
        "gram-native-candidate-new",
        "gram-native-candidate-shared",
        "unrelated",
      ]) {
        const path = join(temp, name);
        await mkdir(path, { mode: 0o700 });
        await writeFile(join(path, "candidate.zip"), "synthetic bytes");
        if (name !== "gram-native-candidate-new") await utimes(path, old, old);
      }
      await chmod(join(temp, "gram-native-candidate-shared"), 0o755);
      await symlink(join(temp, "unrelated"), join(temp, "gram-native-candidate-link"));
      await writeFile(join(temp, "gram-native-candidate-file"), "not a directory");
      const uid = process.getuid!();
      const otherOwner = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
      try {
        expect(await sweepStaleCandidateDirs(temp, now)).toBe(0);
      } finally {
        otherOwner.mockRestore();
      }
      expect(await sweepStaleCandidateDirs(temp, now)).toBe(1);
      expect((await readdir(temp)).toSorted()).toEqual([
        "gram-native-candidate-file",
        "gram-native-candidate-link",
        "gram-native-candidate-new",
        "gram-native-candidate-shared",
        "unrelated",
      ]);
      expect((await lstat(join(temp, "gram-native-candidate-link"))).isSymbolicLink()).toBe(true);
      expect(await sweepStaleCandidateDirs(join(temp, "missing"), now)).toBe(0);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("bounds removal per startup", async () => {
    const temp = await mkdtemp(join(tmpdir(), "gram-snapshot-sweep-test-"));
    const now = Date.now();
    const old = new Date(now - 2 * DAY);
    try {
      for (let i = 0; i < 40; i++) {
        const path = join(temp, `gram-native-candidate-${i}`);
        await mkdir(path, { mode: 0o700 });
        await utimes(path, old, old);
      }
      expect(await sweepStaleCandidateDirs(temp, now)).toBe(32);
      expect(await readdir(temp)).toHaveLength(8);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("owns a 0700 directory and joins repeated snapshot closes", async () => {
    const temp = await mkdtemp(join(tmpdir(), "gram-snapshot-close-test-"));
    try {
      const source = join(temp, "source.zip");
      await writeFile(source, "synthetic bytes");
      const snapshot = await snapshotCandidate(source, temp);
      const dir = join(snapshot.path, "..");
      expect((await lstat(dir)).mode & 0o777).toBe(0o700);
      await Promise.all([snapshot.close(), snapshot.close()]);
      await expect(lstat(snapshot.path)).rejects.toThrow();
      await expect(snapshot.deliver(async () => {})).rejects.toThrow(/closed/);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
