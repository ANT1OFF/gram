import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { UPDATE_DIR_PREFIX } from "./config.ts";
import { sweepStaleUpdateDirs } from "./sweep.ts";

describe("sweepStaleUpdateDirs", () => {
  let tmp: string;
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("removes only stale update dirs", async () => {
    tmp = mkdtempSync(join(tmpdir(), "gram-sweep-"));
    const ours = join(tmp, `${UPDATE_DIR_PREFIX}aaaa`);
    const other = join(tmp, "someone-elses-dir");
    const strayFile = join(tmp, `${UPDATE_DIR_PREFIX}file`);
    mkdirSync(ours);
    writeFileSync(join(ours, "x-setup.exe"), "stub");
    mkdirSync(other);
    writeFileSync(strayFile, "not a dir");

    expect(await sweepStaleUpdateDirs(tmp, 3_600_000)).toBe(0);
    expect([ours, other, strayFile].every((p) => existsSync(p))).toBe(true);

    // A later `now`: the dir's sub-millisecond mtime can land after a same-millisecond Date.now().
    expect(await sweepStaleUpdateDirs(tmp, 0, Date.now() + 1_000)).toBe(1);
    expect(existsSync(ours)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(strayFile)).toBe(true);
  });

  it("tolerates a missing temp root", async () => {
    tmp = join(tmpdir(), "gram-sweep-absent-root");
    expect(await sweepStaleUpdateDirs(join(tmp, "nowhere"), 0)).toBe(0);
  });

  it.skipIf(process.platform === "win32")(
    "never follows a symlink named like an update dir",
    async () => {
      tmp = mkdtempSync(join(tmpdir(), "gram-sweep-"));
      const target = join(tmp, "victim");
      mkdirSync(target);
      writeFileSync(join(target, "data"), "keep me");
      const link = join(tmp, `${UPDATE_DIR_PREFIX}link`);
      symlinkSync(target, link);

      await sweepStaleUpdateDirs(tmp, 0);
      expect(existsSync(join(target, "data"))).toBe(true);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    },
  );
});
