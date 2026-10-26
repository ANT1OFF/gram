import { describe, expect, it } from "@effect/vitest";
import { ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import { join } from "node:path";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "../git/test-repo.ts";
import { listFileNames, namesResult } from "./names.ts";

const tempTree = Effect.acquireRelease(Effect.sync(tempDir), (dir) =>
  Effect.sync(() => removeDir(dir)),
);

const paths = (result: { readonly entries: ReadonlyArray<{ path: string; kind: string }> }) =>
  result.entries.map((entry) => (entry.kind === "dir" ? `${entry.path}/` : entry.path));

describe("namesResult", () => {
  it("adds the folders above the files, sorted by path", () => {
    expect(paths(namesResult(["src/b/c.ts", "README.md", "src/a.ts"], 10))).toEqual([
      "README.md",
      "src/",
      "src/a.ts",
      "src/b/",
      "src/b/c.ts",
    ]);
  });

  it("leaves out .git and node_modules, and caps the files", () => {
    const result = namesResult(["a.ts", "node_modules/x/index.js", ".git/HEAD", "b.ts"], 1);
    expect(paths(result)).toEqual(["a.ts"]);
    expect(result.truncated).toBe(true);
  });
});

describe.skipIf(!hasGit)("fs.files", () => {
  it.live("lists tracked and untracked files, leaving out ignored ones and node_modules", () =>
    Effect.gen(function* () {
      const repo = makeRepo(yield* tempTree);
      write(join(repo, ".gitignore"), "dist/\n*.log\n");
      write(join(repo, "src/retry.ts"), "export const retry = 1;\n");
      run(repo, "add", ".gitignore", "src/retry.ts");
      run(repo, "commit", "-qm", "src");
      write(join(repo, "src/nested/sleep.ts"), "export const sleep = 1;\n");
      write(join(repo, "dist/retry.js"), "retry\n");
      write(join(repo, "debug.log"), "retry\n");
      write(join(repo, "node_modules/left-pad/index.js"), "module.exports = 1;\n");

      const result = yield* listFileNames(repo);
      expect(paths(result)).toEqual(
        expect.arrayContaining(["src/", "src/nested/", "src/retry.ts"]),
      );
      expect(paths(result)).toContain("src/nested/sleep.ts");
      expect(paths(result).filter((path) => /dist|debug\.log|node_modules/.test(path))).toEqual([]);
      expect(result.truncated).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live("walks a folder that isn't a repo", () =>
    Effect.gen(function* () {
      const dir = yield* tempTree;
      write(join(dir, "notes/todo.md"), "- retry\n");
      write(join(dir, "node_modules/x/index.js"), "1\n");
      const result = yield* listFileNames(dir);
      expect(paths(result)).toEqual(["notes/", "notes/todo.md"]);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );
});
