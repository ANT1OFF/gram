import { describe, expect, it } from "@effect/vitest";
import { ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import { join } from "node:path";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "../git/test-repo.ts";
import { byRecency, makeVocabularyCache, projectTerms, symbolsOf } from "./vocabulary.ts";

const tempTree = Effect.acquireRelease(Effect.sync(tempDir), (dir) =>
  Effect.sync(() => removeDir(dir)),
);

const termsOf = (result: { terms: ReadonlyArray<{ term: string; kind: string }> }) =>
  result.terms.map(({ term, kind }) => `${kind}:${term}`);

describe("symbolsOf", () => {
  it("takes the declared name off each `path:declaration` line", () => {
    expect(
      symbolsOf(
        [
          "src/a.ts:export const useDictation",
          "src/b.ts:export default async function createSpeechService",
          "lib/c.rs:pub(crate) fn load_model",
          "tool/d.py:class VocabularyCache",
          "",
          "no colon here",
        ].join("\n"),
      ),
    ).toEqual([
      { path: "src/a.ts", name: "useDictation" },
      { path: "src/b.ts", name: "createSpeechService" },
      { path: "lib/c.rs", name: "load_model" },
      { path: "tool/d.py", name: "VocabularyCache" },
    ]);
  });
});

describe("byRecency", () => {
  it("puts recently changed paths first and keeps the rest in order", () => {
    expect(byRecency(["a", "b", "c", "d"], (path) => path, ["c", "a", "c"])).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });
});

describe("projectTerms", () => {
  it("keeps distinctive names only, each once, symbols first", () => {
    const result = projectTerms({
      symbols: ["useDictation", "setState", "Effect", "useDictation", "loadSherpaRuntime"],
      files: [
        "apps/web/src/use-dictation.ts",
        "README.md",
        "src/index.ts",
        "speech-process/main.ts",
      ],
      branches: ["main", "feat/voice-vocab"],
      titles: ["Fix sherpa-onnx loading", "Tidy the sidebar"],
    });
    expect(termsOf(result)).toEqual([
      "symbol:useDictation",
      "symbol:loadSherpaRuntime",
      "file:use-dictation.ts",
      "file:use-dictation",
      "file:README.md",
      "file:index.ts",
      "file:main.ts",
      "branch:feat/voice-vocab",
      "title:sherpa-onnx",
    ]);
    expect(result.truncated).toBe(false);
  });

  it("caps the whole and says so", () => {
    const symbols = Array.from({ length: 50 }, (_, i) => `someName${i}`);
    const result = projectTerms({ symbols, files: [], branches: [], titles: [] }, 10);
    expect(result.terms).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });
});

describe.skipIf(!hasGit)("project vocabulary from git", () => {
  it.live("reads tracked names and exports, and again after a commit", () =>
    Effect.gen(function* () {
      const repo = makeRepo(yield* tempTree);
      write(join(repo, "src/speech-service.ts"), "export const createSpeechService = 1;\n");
      write(join(repo, "untracked-thing.ts"), "export const notTracked = 1;\n");
      run(repo, "add", "src/speech-service.ts");
      run(repo, "commit", "-qm", "speech");
      const vocabulary = makeVocabularyCache();

      const first = termsOf(yield* vocabulary(repo, []));
      expect(first).toContain("file:speech-service.ts");
      // Only common words without a dot, so not names dictation would replace; untracked files
      // aren't read.
      expect(first.join(" ")).not.toMatch(
        /createSpeechService|file:speech-service |untracked-thing|notTracked/,
      );
      expect(first).not.toContain("file:speech-service");

      write(join(repo, "src/sherpa.ts"), "export function loadSherpaRuntime() {}\n");
      run(repo, "add", "src/sherpa.ts");
      run(repo, "commit", "-qm", "sherpa");
      expect(termsOf(yield* vocabulary(repo, []))).toEqual(
        expect.arrayContaining(["symbol:loadSherpaRuntime", "file:sherpa.ts"]),
      );
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live("is empty for a folder that isn't a repo", () =>
    Effect.gen(function* () {
      const dir = yield* tempTree;
      write(join(dir, "use-dictation.ts"), "export const useDictation = 1;\n");
      expect((yield* makeVocabularyCache()(dir, [])).terms).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );
});
