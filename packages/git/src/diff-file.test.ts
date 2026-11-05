import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FILE_DIFF_GIT_ARGS, fileDiffPaths, selectFilePatch } from "./diff-file.ts";
import { git } from "./exec.ts";
import { ProcLive } from "./proc.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-utils.ts";

const provide = Effect.provide(ProcLive);

const fileDiff = (
  repo: string,
  range: Array<string>,
  paths: Array<string>,
  maxOutputBytes?: number,
) =>
  git(
    repo,
    [...FILE_DIFF_GIT_ARGS, "diff", ...range, "--no-color", "--", ...paths],
    maxOutputBytes === undefined ? {} : { maxOutputBytes },
  );

describe("selectFilePatch", () => {
  it("picks the file's section out of several, by its new path or a deletion's old one", () => {
    const text = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-a",
      "+A",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-x",
      "-y",
      "",
    ].join("\n");
    expect(selectFilePatch(text, "gone.txt")).toMatchObject({
      status: "deleted",
      binary: false,
      patch: "@@ -1,2 +0,0 @@\n-x\n-y\n",
      additions: 0,
      deletions: 2,
    });
    expect(selectFilePatch(text, "a.txt")?.patch).toBe("@@ -1 +1 @@\n-a\n+A\n");
    expect(selectFilePatch(text, "other.txt")).toBeUndefined();
  });

  it("drops the partial last line of output git's read cap cut, and fingerprints the cut apart", () => {
    const text =
      "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1,3 @@\n+one\n+two\n+thr";
    const cut = selectFilePatch(text, "a.txt", true);
    expect(cut?.patch).toBe("@@ -0,0 +1,3 @@\n+one\n+two\n");
    expect(cut?.fingerprint).not.toBe(selectFilePatch(`${text}ee\n`, "a.txt")?.fingerprint);
  });

  it("names a rename's two sides", () => {
    expect(fileDiffPaths("new.txt", "old.txt")).toEqual(["old.txt", "new.txt"]);
    expect(fileDiffPaths("same.txt", "same.txt")).toEqual(["same.txt"]);
    expect(fileDiffPaths("only.txt")).toEqual(["only.txt"]);
  });
});

describe.skipIf(!hasGit)("selectFilePatch over real git", () => {
  const dirs: Array<string> = [];
  const tmp = () => {
    const dir = tempDir();
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  it.live("marks a binary file, and pairs a rename when both paths are given", () =>
    Effect.gen(function* () {
      const repo = makeRepo(tmp());
      const body = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
      write(nodePath.join(repo, "old name.txt"), `${body}\n`);
      fs.writeFileSync(nodePath.join(repo, "image.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "base");
      fs.writeFileSync(nodePath.join(repo, "image.bin"), Buffer.from([0, 9, 9, 9, 0, 255]));
      run(repo, "mv", "old name.txt", "new name.txt");
      write(nodePath.join(repo, "new name.txt"), `${body}\nline 50\n`);
      run(repo, "add", "-A");

      const binary = yield* fileDiff(repo, ["HEAD"], ["image.bin"]);
      expect(selectFilePatch(binary.stdout, "image.bin")).toMatchObject({
        binary: true,
        patch: "",
        status: "modified",
      });

      const renamed = yield* fileDiff(
        repo,
        ["HEAD"],
        fileDiffPaths("new name.txt", "old name.txt"),
      );
      expect(selectFilePatch(renamed.stdout, "new name.txt")).toMatchObject({
        status: "renamed",
        binary: false,
        additions: 1,
        deletions: 0,
      });
      // Without the old path git can't pair the sides: the new file reads as all-added.
      const alone = yield* fileDiff(repo, ["HEAD"], ["new name.txt"]);
      expect(selectFilePatch(alone.stdout, "new name.txt")).toMatchObject({
        status: "new",
        additions: 51,
      });
    }).pipe(provide),
  );

  it.live("reads a file past the read cap in part", () =>
    Effect.gen(function* () {
      const repo = makeRepo(tmp());
      write(nodePath.join(repo, "big.txt"), `${"x".repeat(99)}\n`.repeat(2000));
      run(repo, "add", "-A");
      const out = yield* fileDiff(repo, ["HEAD"], ["big.txt"], 64 * 1024);
      expect(out.truncated).toBe(true);
      const file = selectFilePatch(out.stdout, "big.txt", out.truncated);
      expect(file?.additions).toBeGreaterThan(500);
      expect(file?.additions).toBeLessThan(2000);
      expect(file?.patch.endsWith(`${"x".repeat(99)}\n`)).toBe(true);
    }).pipe(provide),
  );
});
