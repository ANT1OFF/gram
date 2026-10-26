import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  DIFF_TOO_LARGE_NOTE,
  gitDiff,
  MAX_UNTRACKED_FILES,
  MAX_VIEW_BYTES,
  parseGitDiff,
  parseGitDiffCapped,
  UNTRACKED_BUDGET_NOTE,
  untrackedOverflowNote,
  untrackedTextDiff,
  unquoteGitPath,
} from "./diff.ts";
import { ProcLive } from "./proc.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-utils.ts";

const provide = Effect.provide(ProcLive);

describe("parseGitDiff", () => {
  it("reads the path from the +++ line even with ' b/' in the name", () => {
    const files = parseGitDiff(
      "diff --git a/a b/c.txt b/a b/c.txt\nindex e69de29..0cfbf08 100644\n--- a/a b/c.txt\n+++ b/a b/c.txt\n@@ -0,0 +1 @@\n+2\n",
    );
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "a b/c.txt", added: 1 });
  });

  it("parses a plain modification", () => {
    const files = parseGitDiff(
      "diff --git a/src/main.rs b/src/main.rs\nindex 111..222 100644\n--- a/src/main.rs\n+++ b/src/main.rs\n@@ -1,2 +1,2 @@\n-old\n+new\n keep\n",
    );
    expect(files[0]).toMatchObject({
      path: "src/main.rs",
      status: "modified",
      added: 1,
      removed: 1,
    });
    expect(files[0]?.diff.startsWith("@@ -1,2 +1,2 @@\n")).toBe(true);
  });

  it("takes a rename's path from `rename to`", () => {
    const files = parseGitDiff(
      "diff --git a/old name.txt b/new name.txt\nsimilarity index 100%\nrename from old name.txt\nrename to new name.txt\n",
    );
    expect(files[0]).toMatchObject({ path: "new name.txt", status: "renamed" });
  });

  it("keeps a deletion's path despite +++ /dev/null", () => {
    const files = parseGitDiff(
      "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\nindex 222..000\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n",
    );
    expect(files[0]).toMatchObject({ path: "gone.txt", status: "deleted", removed: 1 });
  });

  it("ignores a +++ line inside a hunk body", () => {
    const files = parseGitDiff(
      "diff --git a/notes.md b/notes.md\nindex 111..222 100644\n--- a/notes.md\n+++ b/notes.md\n@@ -1,1 +1,2 @@\n existing\n+++ b/evil.txt\n",
    );
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("notes.md");
  });

  it("drops the tab git ends a spaced name's ---/+++ lines with", () => {
    const files = parseGitDiff(
      "diff --git a/file with spaces.txt b/file with spaces.txt\nindex 111..222 100644\n--- a/file with spaces.txt\t\n+++ b/file with spaces.txt\t\n@@ -1 +1 @@\n-before\n+after\n",
    );
    expect(files.map((f) => f.path)).toEqual(["file with spaces.txt"]);
  });

  it("unquotes git's C-quoted headers", () => {
    const files = parseGitDiff(
      [
        'diff --git "a/a\\"b.txt" "b/a\\"b.txt"',
        "index 111..222 100644",
        '--- "a/a\\"b.txt"',
        '+++ "b/a\\"b.txt"',
        "@@ -1 +1 @@",
        "-before",
        "+after",
        'diff --git "a/caf\\303\\251\\tx" "b/caf\\303\\251\\tx"',
        "deleted file mode 100644",
        '--- "a/caf\\303\\251\\tx"',
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-gone",
        'diff --git a/plain.txt "b/new\\\\name.txt"',
        "similarity index 100%",
        "rename from plain.txt",
        'rename to "new\\\\name.txt"',
        "",
      ].join("\n"),
    );
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['a"b.txt', "modified"],
      ["café\tx", "deleted"],
      ["new\\name.txt", "renamed"],
    ]);
    expect(unquoteGitPath("plain name")).toBe("plain name");
  });

  it("splits an unrenamed header-only entry in the middle despite ' b/' in its name", () => {
    const files = parseGitDiff(
      "diff --git a/x b/y.bin b/x b/y.bin\nindex 111..222 100644\nBinary files a/x b/y.bin and b/x b/y.bin differ\n",
    );
    expect(files.map((f) => f.path)).toEqual(["x b/y.bin"]);
  });

  it("counts added and removed lines that start like file headers", () => {
    const files = parseGitDiff(
      "diff --git a/n.md b/n.md\nindex 111..222 100644\n--- a/n.md\n+++ b/n.md\n@@ -1 +1 @@\n--- old\n+++ new\n",
    );
    expect(files[0]).toMatchObject({ path: "n.md", added: 1, removed: 1 });
  });

  it("drops over-cap bodies with the shared note", () => {
    expect(
      parseGitDiffCapped("diff --git a/a.txt b/a.txt\n+++ b/a.txt\n@@ -0,0 +1 @@\n+x\n"),
    ).toMatchObject({ note: undefined });
    expect(parseGitDiffCapped("x".repeat(MAX_VIEW_BYTES + 1))).toEqual({
      files: [],
      note: DIFF_TOO_LARGE_NOTE,
    });
    expect(parseGitDiffCapped("small", true)).toEqual({ files: [], note: DIFF_TOO_LARGE_NOTE });
  });

  it("counts untracked lines without a phantom +1", () => {
    expect(untrackedTextDiff("")).toEqual({ added: 0, diff: "@@ -0,0 +1,0 @@\n" });
    expect(untrackedTextDiff("one line\n").added).toBe(1);
    const three = untrackedTextDiff("a\nb\nc");
    expect(three.added).toBe(3);
    expect(three.diff).toBe("@@ -0,0 +1,3 @@\n+a\n+b\n+c");
  });
});

describe.skipIf(!hasGit)("gitDiff", () => {
  const dirs: Array<string> = [];
  const tmp = () => {
    const dir = tempDir();
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  it.live("locks the response shape, including untracked specials", () =>
    Effect.gen(function* () {
      expect(yield* gitDiff(tmp())).toEqual({ repo: false });
      const repo = makeRepo(tmp());
      // Host and repo config may rewrite prefixes; the shape stays classic a/ b/.
      run(repo, "config", "diff.mnemonicPrefix", "true");
      write(nodePath.join(repo, "tracked.txt"), "two\n");
      write(nodePath.join(repo, "newdir", "inner.txt"), "a\nb\n");
      write(nodePath.join(repo, "blob.bin"), "a\0b");
      const d = yield* gitDiff(repo);
      expect(Object.keys(d).toSorted()).toEqual(["branch", "files", "repo", "worktree"]);
      expect(d.files?.map((f) => [f.path, f.status, f.added, f.note])).toEqual([
        ["tracked.txt", "modified", 1, undefined],
        ["blob.bin", "new", 0, "binary"],
        ["newdir/inner.txt", "new", 2, undefined],
      ]);
    }).pipe(provide),
  );

  it.live("diffs a clean tree against the override base, else the repo default", () =>
    Effect.gen(function* () {
      const repo = makeRepo(tmp());
      run(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
      run(repo, "update-ref", "refs/remotes/origin/develop", "HEAD");
      run(repo, "checkout", "-q", "-b", "feat");
      write(nodePath.join(repo, "tracked.txt"), "feat\n");
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "feat work");
      const byDefault = yield* gitDiff(repo);
      expect(byDefault.base).toBe("origin/main");
      expect(byDefault.files).toHaveLength(1);
      const overridden = yield* gitDiff(repo, { baseOverride: "origin/develop" });
      expect(overridden.base).toBe("origin/develop");
      write(nodePath.join(repo, "dirty.txt"), "x\n");
      expect((yield* gitDiff(repo, { baseOverride: "origin/develop" })).base).toBeUndefined();
    }).pipe(provide),
  );

  it.live("caps oversized working-tree and branch diffs", () =>
    Effect.gen(function* () {
      const repo = makeRepo(tmp());
      write(nodePath.join(repo, "other.txt"), "one\n");
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "base");
      run(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
      write(
        nodePath.join(repo, "big.txt"),
        `${"x".repeat(63)}\n`.repeat(MAX_VIEW_BYTES / 64 + 1024),
      );
      write(nodePath.join(repo, "tracked.txt"), "changed\n");
      run(repo, "add", "big.txt");
      write(nodePath.join(repo, "new.txt"), "untracked\n");
      const working = yield* gitDiff(repo);
      expect(working).toMatchObject({ repo: true, files: [], note: DIFF_TOO_LARGE_NOTE });
      expect(working.base).toBeUndefined();
      run(repo, "checkout", "-q", "-b", "feat");
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "huge");
      expect(yield* gitDiff(repo)).toMatchObject({
        files: [],
        note: DIFF_TOO_LARGE_NOTE,
        base: "origin/main",
      });
      write(nodePath.join(repo, "big.txt"), "small again\n");
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "shrink");
      const shrunk = yield* gitDiff(repo);
      expect(shrunk.note).toBeUndefined();
      expect(shrunk.files?.length).toBeGreaterThan(0);
    }).pipe(provide),
  );

  it.live("keeps real git's exact names for spaces and quotes", () =>
    Effect.gen(function* () {
      const repo = makeRepo(tmp());
      const names = ["file with spaces.txt", 'a"b.txt', "back\\slash.txt"];
      if (process.platform === "win32") names.splice(1);
      for (const name of names) write(nodePath.join(repo, name), "before\n");
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "names");
      for (const name of names) write(nodePath.join(repo, name), "after\n");
      write(nodePath.join(repo, "untracked with spaces.txt"), "new\n");
      if (process.platform !== "win32") write(nodePath.join(repo, 'u"q.txt'), "new\n");
      const d = yield* gitDiff(repo);
      expect(
        d.files
          ?.filter((f) => f.status === "modified")
          .map((f) => f.path)
          .toSorted(),
      ).toEqual(names.toSorted());
      expect(
        d.files
          ?.filter((f) => f.status === "new")
          .map((f) => f.path)
          .toSorted(),
      ).toEqual(
        process.platform === "win32"
          ? ["untracked with spaces.txt"]
          : ['u"q.txt', "untracked with spaces.txt"],
      );
    }).pipe(provide),
  );

  it.live("shares one byte budget across untracked files and says when it ran out", () =>
    Effect.gen(function* () {
      const repo = makeRepo(tmp());
      for (let n = 0; n < 3; n++)
        write(nodePath.join(repo, `untracked-${n}.txt`), "x".repeat(1024 * 1024));
      const d = yield* gitDiff(repo);
      expect(Buffer.byteLength(JSON.stringify(d))).toBeLessThanOrEqual(MAX_VIEW_BYTES);
      expect(d.note).toBe(UNTRACKED_BUDGET_NOTE);
      expect(d.files?.map((f) => [f.path, f.note])).toEqual([
        ["untracked-0.txt", undefined],
        ["untracked-1.txt", "too large"],
        ["untracked-2.txt", "too large"],
      ]);
    }).pipe(provide),
  );

  it.live("lists at most MAX_UNTRACKED_FILES untracked files and counts the rest", () =>
    Effect.gen(function* () {
      const repo = makeRepo(tmp());
      const dir = nodePath.join(repo, "many");
      fs.mkdirSync(dir);
      for (let n = 0; n < MAX_UNTRACKED_FILES + 2; n++) {
        fs.writeFileSync(nodePath.join(dir, `f${String(n).padStart(5, "0")}.txt`), "x\n");
      }
      const d = yield* gitDiff(repo);
      expect(d.files).toHaveLength(MAX_UNTRACKED_FILES);
      expect(d.note).toBe(untrackedOverflowNote(2));
    }).pipe(provide),
  );
});

describe.skipIf(!hasGit || process.platform === "win32")("gitDiff and links", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  // `statSync`/`readFileSync` followed an untracked link, so the diff RPC returned the contents of
  // whatever file it pointed at outside the checkout.
  it.live("shows an untracked link's target text, never the target's contents", () =>
    Effect.gen(function* () {
      const tmp = tempDir();
      dirs.push(tmp);
      const repo = makeRepo(tmp);
      const outside = nodePath.join(tmp, "outside.txt");
      fs.writeFileSync(outside, "INVENTED_PRIVATE_DATA_OUTSIDE_CHECKOUT\n");
      fs.symlinkSync(outside, nodePath.join(repo, "link.txt"));
      fs.mkdirSync(nodePath.join(tmp, "outside-dir"));
      fs.writeFileSync(nodePath.join(tmp, "outside-dir", "secret.txt"), "INVENTED_DIR_DATA\n");
      fs.symlinkSync(nodePath.join(tmp, "outside-dir"), nodePath.join(repo, "linked-dir"));
      execFileSync("mkfifo", [nodePath.join(repo, "pipe")]);
      const d = yield* gitDiff(repo);
      const json = JSON.stringify(d);
      expect(json).not.toContain("INVENTED_PRIVATE_DATA_OUTSIDE_CHECKOUT");
      expect(json).not.toContain("INVENTED_DIR_DATA");
      expect(d.files?.map((f) => [f.path, f.diff])).toEqual([
        ["link.txt", `@@ -0,0 +1,1 @@\n+${outside}`],
        ["linked-dir", `@@ -0,0 +1,1 @@\n+${nodePath.join(tmp, "outside-dir")}`],
      ]);
    }).pipe(provide),
  );
});
