import { describe, expect, it } from "@effect/vitest";
import { InvalidState } from "@gram/contracts";
import { Proc, ProcLive, ProcTimeout } from "@gram/git";
import * as Effect from "effect/Effect";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "../git/test-repo.ts";
import { parseGrep, searchFiles, type SearchOptions } from "./search.ts";

const tempTree = Effect.acquireRelease(Effect.sync(tempDir), (dir) =>
  Effect.sync(() => removeDir(dir)),
);

const PAGE: SearchOptions = { offset: 0, limit: 200 };

const where = (result: {
  readonly matches: ReadonlyArray<{ relativePath: string; line: number }>;
}) => result.matches.map((match) => `${match.relativePath}:${match.line}`);

/** A repo with tracked, untracked, ignored and binary files that all mention `retry`. */
const fixture = Effect.gen(function* () {
  const repo = makeRepo(yield* tempTree);
  write(join(repo, ".gitignore"), "dist/\n*.log\n");
  write(join(repo, "src/retry.ts"), "export const retry = 1;\n// Retry once more\n");
  write(join(repo, "src/sleep.ts"), "export const sleep = retry;\r\n");
  run(repo, "add", ".gitignore", "src/retry.ts");
  run(repo, "commit", "-qm", "src");
  write(join(repo, "notes.md"), "retry later\n");
  write(join(repo, "dist/retry.js"), "retry\n");
  write(join(repo, "debug.log"), "retry\n");
  writeFileSync(join(repo, "logo.bin"), Buffer.from([0x72, 0x65, 0x74, 0x72, 0x79, 0, 1, 2]));
  return repo;
});

describe.skipIf(!hasGit)("fs.search", () => {
  it.live("finds tracked and untracked text, leaving out ignored and binary files", () =>
    Effect.gen(function* () {
      const repo = yield* fixture;
      const result = yield* searchFiles(repo, "retry", PAGE);
      expect(where(result)).toEqual([
        "notes.md:1",
        "src/retry.ts:1",
        "src/retry.ts:2",
        "src/sleep.ts:1",
      ]);
      expect(result.matches[2]).toEqual({
        path: join(repo, "src/retry.ts"),
        relativePath: "src/retry.ts",
        line: 2,
        text: "// Retry once more",
        ranges: [{ start: 3, end: 8 }],
      });
      expect(result.matches[3]?.text).toBe("export const sleep = retry;");
      expect(result).not.toHaveProperty("nextOffset");
      expect(result).not.toHaveProperty("limitedBy");
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live("matches case and regexes, and explains a malformed regex", () =>
    Effect.gen(function* () {
      const repo = yield* fixture;
      expect(where(yield* searchFiles(repo, "Retry", { ...PAGE, caseSensitive: true }))).toEqual([
        "src/retry.ts:2",
      ]);
      expect(where(yield* searchFiles(repo, "sle+p|later", { ...PAGE, regex: true }))).toEqual([
        "notes.md:1",
        "src/sleep.ts:1",
      ]);
      expect(where(yield* searchFiles(repo, "sle+p", PAGE))).toEqual([]);
      const error = yield* Effect.flip(searchFiles(repo, "(", { ...PAGE, regex: true }));
      expect(error).toBeInstanceOf(InvalidState);
      expect(error.message).toMatch(/^Invalid regular expression: /);
      expect(yield* Effect.flip(searchFiles(repo, "  ", PAGE))).toBeInstanceOf(InvalidState);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live("pages by offset and stops at the output cap", () =>
    Effect.gen(function* () {
      const repo = yield* fixture;
      const first = yield* searchFiles(repo, "retry", { offset: 0, limit: 3 });
      expect(where(first)).toEqual(["notes.md:1", "src/retry.ts:1", "src/retry.ts:2"]);
      expect(first.nextOffset).toBe(3);
      const second = yield* searchFiles(repo, "retry", { offset: 3, limit: 3 });
      expect(where(second)).toEqual(["src/sleep.ts:1"]);
      expect(second).not.toHaveProperty("nextOffset");

      const capped = yield* searchFiles(repo, "retry", { ...PAGE, maxBytes: 40 });
      expect(capped.limitedBy).toBe("bytes");
      expect(capped.matches.length).toBeLessThan(4);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live("searches a folder that isn't a repository", () =>
    Effect.gen(function* () {
      const folder = yield* tempTree;
      write(join(folder, "plan.txt"), "first\nthen retry\n");
      expect(where(yield* searchFiles(folder, "retry", PAGE))).toEqual(["plan.txt:2"]);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );
});

describe("fs.search limits", () => {
  it.effect("reports a search that ran out of time", () =>
    Effect.gen(function* () {
      const result = yield* searchFiles("/checkout", "retry", PAGE);
      expect(result).toEqual({ matches: [], limitedBy: "time" });
    }).pipe(
      Effect.provideService(Proc, {
        run: (_bin, args) =>
          args[0] === "grep"
            ? Effect.fail(new ProcTimeout({ bin: "git", message: "git grep timed out" }))
            : Effect.succeed({ status: 0, stdout: "/checkout\n", stderr: "", truncated: false }),
      }),
    ),
  );

  it("drops the partial last record of output cut at the cap", () => {
    expect(parseGrep("a.ts\x001\x00retry\nb.ts\x002\x00re", true)).toEqual([
      { relativePath: "a.ts", line: 1, text: "retry" },
    ]);
    expect(parseGrep("a.ts\x001\x00retry\n", false)).toHaveLength(1);
  });
});
