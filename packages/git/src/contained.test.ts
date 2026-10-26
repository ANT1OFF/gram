import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { writeInside } from "./contained.ts";
import { removeDir, tempDir } from "./test-utils.ts";

const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});
const dir = () => {
  const made = tempDir();
  dirs.push(made);
  return made;
};
const text = (data: string) => (fd: number) => fs.writeFileSync(fd, data);

/** Runs `body` with `fs.renameSync` replaced, the ESM view of `node:fs` included. */
const withRename = (
  rename: (real: typeof fs.renameSync) => typeof fs.renameSync,
  body: () => void,
) => {
  const real = fs.renameSync;
  fs.renameSync = rename(real);
  syncBuiltinESMExports();
  try {
    body();
  } finally {
    fs.renameSync = real;
    syncBuiltinESMExports();
  }
};

/** Moves `root/race` to `outside/moved` and leaves a link to it in its place. */
const swap = (root: string, outside: string) => {
  fs.renameSync(nodePath.join(root, "race"), nodePath.join(outside, "moved"));
  fs.symlinkSync(nodePath.join(outside, "moved"), nodePath.join(root, "race"));
};

describe("writeInside", () => {
  it("replaces only the file it was told it replaces", () => {
    const root = dir();
    const path = nodePath.join(root, "a.txt");
    fs.writeFileSync(path, "read");
    const stat = fs.lstatSync(path, { bigint: true });
    writeInside(root, "a.txt", text("first"), { replacing: stat });
    expect(fs.readFileSync(path, "utf8")).toBe("first");
    expect(() => writeInside(root, "a.txt", text("second"), { replacing: stat })).toThrow(
      /changed since it was read/,
    );
    expect(fs.readFileSync(path, "utf8")).toBe("first");
  });

  // A symlink on Windows needs a privilege CI doesn't have.
  describe.skipIf(process.platform === "win32")("a parent swapped for a link mid-write", () => {
    it("is refused before the rename when it happens while the file is filled", () => {
      const root = dir();
      const outside = dir();
      fs.mkdirSync(nodePath.join(root, "race"));
      expect(() =>
        writeInside(root, "race/result.txt", (fd) => {
          fs.writeFileSync(fd, "data");
          swap(root, outside);
        }),
      ).toThrow(/leaves the checkout/);
      expect(fs.readdirSync(nodePath.join(outside, "moved"))).toEqual([]);
    });

    // The rename resolves the parent again after the last check; Node has no `renameat` to stop a
    // swap in that gap, so what this holds it to is that the write is never reported as done.
    it("is detected when it happens after the last check", () => {
      const root = dir();
      const outside = dir();
      fs.mkdirSync(nodePath.join(root, "race"));
      const destination = nodePath.join(root, "race/result.txt");
      withRename(
        (real) => (from, to) => {
          if (to === destination) swap(root, outside);
          real(from, to);
        },
        () => {
          expect(() => writeInside(root, "race/result.txt", text("data"))).toThrow(
            /leaves the checkout/,
          );
        },
      );
    });
  });
});
