/**
 * Checks of a whole memory set that a single write can't make: links that lead nowhere, two notes
 * on one subject, notes the index doesn't name, and an index grown past what is worth loading into
 * every session. Pure: no filesystem, no clock.
 *
 * A dream runs these with `dream_check` while it rewrites memory, and Gram runs them again when it
 * says it is done: what is still wrong then goes back to it once, and what it leaves goes to the
 * reviewer in its report. They never refuse a set; `checkMemorySet` does that.
 */
import { MEMORY_INDEX, MEMORY_INDEX_MAX_BYTES } from "./memory.ts";

/**
 * The index size a dream aims under: half the hard cap, so the index stays a table of contents
 * that every session can afford, with room for the entries written between dreams.
 */
export const MEMORY_INDEX_TARGET_BYTES = Math.floor(MEMORY_INDEX_MAX_BYTES / 2);
/** Longer than this, an index line is a note's content, not its pointer. */
export const MEMORY_INDEX_LINE_MAX_CHARS = 200;
/** The most problems a check reports, so one broken index can't flood a context. */
const PROBLEMS_MAX = 60;

export type MemoryLintKind =
  | "dangling_link"
  | "duplicate_note"
  | "duplicate_description"
  | "not_in_index"
  | "index_over_target"
  | "index_line_long"
  | "no_description";

export interface MemoryLintProblem {
  readonly kind: MemoryLintKind;
  /** The file the problem is in, relative to the memory root. */
  readonly path: string;
  readonly message: string;
}

export interface MemoryLintFile {
  readonly path: string;
  readonly content: string;
}

/**
 * The kinds worth a second look before a dream's output reaches the reviewer: a broken link, a
 * subject split in two, an index past its target. The rest are tidiness `dream_check` reports.
 */
export const SERIOUS_LINT_KINDS: ReadonlySet<MemoryLintKind> = new Set([
  "dangling_link",
  "duplicate_note",
  "duplicate_description",
  "index_over_target",
]);

/** `text` without fenced code blocks and inline code, where `[[x]]` is an example, not a link. */
const withoutCode = (text: string): string => {
  const kept: Array<string> = [];
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const opens = /^\s*(```|~~~)/.exec(line);
    if (fence !== undefined) {
      if (opens?.[1] === fence) fence = undefined;
      continue;
    }
    if (opens !== null) {
      fence = opens[1];
      continue;
    }
    kept.push(line.replace(/`[^`]*`/g, ""));
  }
  return kept.join("\n");
};

/** The `[[target]]` links of `text`, outside code, each once, without an `|alias` or `#heading`. */
export const memoryLinks = (text: string): ReadonlyArray<string> => {
  const found = new Set<string>();
  for (const match of withoutCode(text).matchAll(/\[\[([^\]\n]{1,200})\]\]/g)) {
    const target = match[1]!.split("|")[0]!.split("#")[0]!.trim();
    if (target !== "") found.add(target);
  }
  return [...found];
};

/** A note's flat front matter (`key: value` lines between `---` fences); empty when it has none. */
export const frontMatterOf = (text: string): Readonly<Record<string, string>> => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (match === null) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (field === null) continue;
    fields[field[1]!.toLowerCase()] = field[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return fields;
};

/** A name as a link, a file name and front matter can all spell it: `Repo_API` is `repo-api`. */
const keyOf = (name: string): string =>
  name
    .normalize("NFC")
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[\s_]+/g, "-");

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const plainDescription = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * What is wrong with `files` as a whole, as a list a dream can work through, worst first. A link
 * resolves to a note by its path, its file name or its front matter `name`, with or without `.md`.
 */
export const lintMemory = (
  files: ReadonlyArray<MemoryLintFile>,
): ReadonlyArray<MemoryLintProblem> => {
  const problems: Array<MemoryLintProblem> = [];
  const notes = files.filter((file) => file.path.endsWith(".md"));
  const index = notes.find((file) => file.path === MEMORY_INDEX);
  const others = notes.filter((file) => file.path !== MEMORY_INDEX);

  // Every key a note answers to, and the notes that answer to each.
  const byKey = new Map<string, Set<string>>();
  const keysOf = new Map<string, ReadonlyArray<string>>();
  const answer = (key: string, path: string) => {
    const paths = byKey.get(key) ?? new Set<string>();
    paths.add(path);
    byKey.set(key, paths);
  };
  for (const note of notes) {
    const name = frontMatterOf(note.content).name;
    const keys = [
      ...new Set([
        keyOf(note.path),
        keyOf(baseName(note.path)),
        ...(name === undefined || name === "" ? [] : [keyOf(name)]),
      ]),
    ];
    keysOf.set(note.path, keys);
    for (const key of keys) answer(key, note.path);
  }

  for (const note of notes) {
    for (const link of memoryLinks(note.content)) {
      if (byKey.has(keyOf(link))) continue;
      problems.push({
        kind: "dangling_link",
        path: note.path,
        message: `[[${link}]] names no note. Point it at the note that holds the subject, write that note, or drop the link.`,
      });
    }
  }

  // Two notes on one subject: one's name is another's, or they describe themselves alike.
  const reported = new Set<string>();
  for (const [key, paths] of byKey) {
    if (paths.size < 2) continue;
    const pair = [...paths].toSorted();
    const id = pair.join("\0");
    if (reported.has(id)) continue;
    reported.add(id);
    problems.push({
      kind: "duplicate_note",
      path: pair[0]!,
      message: `${pair.join(" and ")} both answer to the name "${key}". Merge them into one note and point every link at it.`,
    });
  }
  const byDescription = new Map<string, Array<string>>();
  for (const note of others) {
    const description = plainDescription(frontMatterOf(note.content).description ?? "");
    if (description.length < 12) continue;
    byDescription.set(description, [...(byDescription.get(description) ?? []), note.path]);
  }
  for (const paths of byDescription.values()) {
    if (paths.length < 2) continue;
    problems.push({
      kind: "duplicate_description",
      path: paths[0]!,
      message: `${paths.join(" and ")} describe themselves alike. If they hold one subject, merge them; if not, say in each description what sets it apart.`,
    });
  }

  if (index !== undefined) {
    const named = new Set(memoryLinks(index.content).map(keyOf));
    // The starter index names notes by their file (`- goals.md: …`), which counts as naming one.
    const mentioned = withoutCode(index.content);
    for (const note of others) {
      const keys = keysOf.get(note.path) ?? [];
      if (keys.some((key) => named.has(key)) || mentioned.includes(note.path)) continue;
      problems.push({
        kind: "not_in_index",
        path: note.path,
        message: `${MEMORY_INDEX} doesn't name ${note.path}. Add its line, \`- [[${keyOf(baseName(note.path))}]]: what it holds\`, or fold it into a note the index names.`,
      });
    }
    const bytes = Buffer.byteLength(index.content, "utf8");
    if (bytes > MEMORY_INDEX_TARGET_BYTES) {
      problems.push({
        kind: "index_over_target",
        path: MEMORY_INDEX,
        message: `${MEMORY_INDEX} is ${bytes} bytes; aim under ${MEMORY_INDEX_TARGET_BYTES}. Keep one short line per note and move facts out of the index into the notes they belong to.`,
      });
    }
    const lines = index.content.split("\n");
    lines.forEach((line, i) => {
      if (line.length <= MEMORY_INDEX_LINE_MAX_CHARS) return;
      problems.push({
        kind: "index_line_long",
        path: MEMORY_INDEX,
        message: `Line ${i + 1} is ${line.length} characters; an index line says what a note holds in under ${MEMORY_INDEX_LINE_MAX_CHARS}. Move the detail into the note.`,
      });
    });
  }

  for (const note of others) {
    const fields = frontMatterOf(note.content);
    if ((fields.description ?? "") !== "") continue;
    problems.push({
      kind: "no_description",
      path: note.path,
      message: `${note.path} has no front matter description: open it with \`name\`, a one-line \`description\` and \`type\`.`,
    });
  }

  const order = (problem: MemoryLintProblem) => (SERIOUS_LINT_KINDS.has(problem.kind) ? 0 : 1);
  return problems.toSorted((a, b) => order(a) - order(b)).slice(0, PROBLEMS_MAX);
};

/** The problems a dream is sent back to fix once, or `undefined` when nothing serious is left. */
export const seriousLintProblems = (
  problems: ReadonlyArray<MemoryLintProblem>,
): ReadonlyArray<MemoryLintProblem> | undefined => {
  const serious = problems.filter((problem) => SERIOUS_LINT_KINDS.has(problem.kind));
  return serious.length === 0 ? undefined : serious;
};

/** Problems as the bulleted lines a message or a report shows. */
export const lintLines = (problems: ReadonlyArray<MemoryLintProblem>): string =>
  problems.map((problem) => `- ${problem.path}: ${problem.message}`).join("\n");
