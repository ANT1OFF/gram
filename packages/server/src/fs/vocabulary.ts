import {
  distinctiveTerm,
  PROJECT_VOCABULARY_LIMIT,
  type ProjectTerm,
  type ProjectTermKind,
  type ProjectVocabulary,
} from "@gram/contracts";
import { git, type Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/**
 * The names in a project that dictation should spell its way: exported symbols, tracked file and
 * folder names, branches and the words of thread titles. Read from git, kept in memory, never sent
 * anywhere; a log line about it carries counts only.
 */

const GIT_TIMEOUT_MS = 5_000;
const LIST_MAX_BYTES = 16 * 1024 * 1024;
const GREP_MAX_BYTES = 2 * 1024 * 1024;

/** How many of each kind are kept before the whole is capped, so no kind crowds out the rest. */
const KIND_LIMITS: Readonly<Record<ProjectTermKind, number>> = {
  symbol: 1_500,
  file: 1_200,
  folder: 300,
  branch: 150,
  title: 150,
};
const ORDER: readonly ProjectTermKind[] = ["symbol", "file", "folder", "branch", "title"];

/** Top-level exports in TypeScript/JavaScript, Rust and Python, by a line regex and no parser. */
const EXPORT_PATTERNS = [
  String.raw`^export +(default +)?(declare +)?(abstract +)?(async +)?(const|let|var|function\*?|class|interface|type|enum|namespace) +[A-Za-z_$][A-Za-z0-9_$]*`,
  String.raw`^pub(\([a-z]+\))? +(async +)?(fn|struct|enum|trait|type|const|static|mod) +[A-Za-z_][A-Za-z0-9_]*`,
  String.raw`^(async +)?(def|class) +[A-Za-z_][A-Za-z0-9_]*`,
];
const SOURCE_FILES = ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.rs", "*.py"];
/** Commits whose files count as the ones being worked on. */
const RECENT_COMMITS = 200;
const SKIPPED_FILES = [":(exclude)*.d.ts", ":(exclude)*.min.js", ":(exclude)**/vendor/**"];

/** Each `path:declaration` line of `git grep -o` output as the file and the name it declares. */
export const symbolsOf = (lines: string): { path: string; name: string }[] =>
  lines.split("\n").flatMap((line) => {
    const colon = line.indexOf(":");
    const name = /([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(line.slice(colon + 1))?.[1];
    return colon <= 0 || name === undefined ? [] : [{ path: line.slice(0, colon), name }];
  });

/**
 * `items` with those whose path changed most recently first, then the rest in their order: the
 * files a speaker is working on are the ones they name.
 */
export const byRecency = <T>(
  items: readonly T[],
  pathOf: (item: T) => string,
  recent: readonly string[],
): T[] => {
  const rank = new Map<string, number>();
  for (const [index, path] of recent.entries()) if (!rank.has(path)) rank.set(path, index);
  const order = (item: T) => rank.get(pathOf(item)) ?? Number.POSITIVE_INFINITY;
  return items
    .map((item, index) => ({ item, index }))
    .toSorted((a, b) => order(a.item) - order(b.item) || a.index - b.index)
    .map(({ item }) => item);
};

export interface VocabularySources {
  /** Exported names, the most recently changed files' first. */
  readonly symbols: readonly string[];
  /** Tracked paths, `/`-separated, the most recently changed first. */
  readonly files: readonly string[];
  readonly branches: readonly string[];
  readonly titles: readonly string[];
}

/** A title's words that look like names: `sherpa-onnx`, `useDictation`, `v1.4.0`. */
const titleWords = (title: string): string[] =>
  title
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((word) => word !== "");

/**
 * The terms for `sources`: distinctive names only (`distinctiveTerm`), each once, symbols first,
 * at most `limit`.
 */
export const projectTerms = (
  sources: VocabularySources,
  limit: number = PROJECT_VOCABULARY_LIMIT,
): ProjectVocabulary => {
  const byKind: Record<ProjectTermKind, string[]> = {
    symbol: [...sources.symbols],
    file: [],
    folder: [],
    branch: [...sources.branches],
    title: sources.titles.flatMap(titleWords),
  };
  for (const path of sources.files) {
    const segments = path.split("/");
    const name = segments.at(-1) ?? "";
    const dot = name.lastIndexOf(".");
    byKind.file.push(name);
    if (dot > 0) byKind.file.push(name.slice(0, dot));
    byKind.folder.push(...segments.slice(0, -1));
  }

  const seen = new Set<string>();
  const terms: ProjectTerm[] = [];
  let truncated = false;
  for (const kind of ORDER) {
    let kept = 0;
    for (const term of byKind[kind]) {
      if (seen.has(term)) continue;
      seen.add(term);
      if (!distinctiveTerm(term)) continue;
      if (kept >= KIND_LIMITS[kind] || terms.length >= limit) {
        truncated = true;
        break;
      }
      terms.push({ term, kind });
      kept++;
    }
  }
  return { terms, truncated };
};

/** Stdout of `git args` in `root`, or "" when git fails or times out. */
const gitText = (root: string, args: readonly string[], maxOutputBytes = LIST_MAX_BYTES) =>
  git(root, args, { timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes }).pipe(
    // `git grep` exits 1 when nothing matched, which is an empty answer, not a failure.
    Effect.map((out) => (out.status === 0 || out.status === 1 ? out.stdout : "")),
    Effect.orElseSucceed(() => ""),
  );

/** What git knows of `root`'s names; empty for a folder that isn't a repo. */
export const readVocabularySources = (
  root: string,
): Effect.Effect<Omit<VocabularySources, "titles">, never, Proc> =>
  Effect.gen(function* () {
    const [files, grep, branches, log] = yield* Effect.all(
      [
        gitText(root, ["ls-files", "-z"]),
        gitText(
          root,
          [
            "grep",
            "-o",
            "-I",
            "-E",
            ...EXPORT_PATTERNS.flatMap((pattern) => ["-e", pattern]),
            "--",
            ...SOURCE_FILES,
            ...SKIPPED_FILES,
          ],
          GREP_MAX_BYTES,
        ),
        gitText(root, [
          "for-each-ref",
          "--sort=-committerdate",
          "--count=300",
          "--format=%(refname:short)",
          "refs/heads",
        ]),
        gitText(root, ["log", "-n", String(RECENT_COMMITS), "--name-only", "--format="]),
      ],
      { concurrency: 4 },
    );
    const recent = log.split("\n").filter((path) => path !== "");
    const tracked = files
      .split("\0")
      .filter((path) => path !== "" && !path.includes("node_modules/"));
    return {
      files: byRecency(tracked, (path) => path, recent),
      symbols: byRecency(symbolsOf(grep), (symbol) => symbol.path, recent).map(
        (symbol) => symbol.name,
      ),
      branches: branches.split("\n").filter((branch) => branch !== ""),
    };
  });

/**
 * What changes when the names might have: the commit checked out and the index. A branch made
 * elsewhere shows on the next commit or after `VOCABULARY_MAX_AGE_MS`.
 */
const signatureOf = (root: string) =>
  Effect.gen(function* () {
    const [head = "", indexPath = ""] = (yield* gitText(root, [
      "rev-parse",
      "HEAD",
      "--git-path",
      "index",
    ]))
      .trim()
      .split("\n");
    if (indexPath === "") return head;
    const absolute = isAbsolute(indexPath) ? indexPath : join(root, indexPath);
    const modified = yield* Effect.promise(() =>
      stat(absolute).then(
        (info) => info.mtimeMs,
        () => 0,
      ),
    );
    return `${head}\0${modified}`;
  });

/** How long a project's names are kept without looking at git again. */
export const VOCABULARY_MAX_AGE_MS = 10 * 60_000;
/** Projects whose names are kept at once. */
const CACHED_ROOTS = 8;

/**
 * Project names by checkout, read again when the checkout's commit or index changes. Titles are
 * the caller's and cost nothing, so they are added on every call rather than cached.
 */
export const makeVocabularyCache = (now: () => number = Date.now) => {
  const cache = new Map<
    string,
    {
      readonly signature: string;
      readonly at: number;
      readonly sources: Omit<VocabularySources, "titles">;
    }
  >();
  return (root: string, titles: readonly string[]) =>
    Effect.gen(function* () {
      const signature = yield* signatureOf(root);
      const held = cache.get(root);
      let sources = held?.sources;
      if (
        held === undefined ||
        held.signature !== signature ||
        now() - held.at > VOCABULARY_MAX_AGE_MS
      ) {
        sources = yield* readVocabularySources(root);
        cache.delete(root);
        cache.set(root, { signature, at: now(), sources });
        while (cache.size > CACHED_ROOTS) cache.delete(cache.keys().next().value!);
      }
      return projectTerms({ ...sources!, titles });
    });
};
