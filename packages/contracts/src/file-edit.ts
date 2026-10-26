import type { StructuredPatchHunk } from "./ui-message.ts";

// One shape for a file an agent changed, whichever agent and tool did it, so the transcript draws
// every edit with one component: Claude's Edit, MultiEdit and Write calls, and the file changes a
// Codex patch makes, which its mapper stores as `Edit` and `Write` calls carrying `changes`.

/** What happened to the file. `write` is a whole-file write over contents nobody reported. */
export type FileEditKind = "create" | "modify" | "delete" | "write";

export interface FileEdit {
  path: string;
  /** Where a Codex patch moved the file to. */
  movedTo?: string;
  kind: FileEditKind;
  /** Lines carry a `+`, `-` or space prefix, as in `structuredPatch`. */
  hunks: readonly StructuredPatchHunk[];
  /**
   * Whether the hunks' line numbers are the file's. They aren't for an edit known only from the
   * strings it replaced, which says nothing about where in the file they are.
   */
  numbered: boolean;
  additions: number;
  deletions: number;
}

/** Lines added and removed across `hunks`. */
export function hunkCounts(hunks: readonly StructuredPatchHunk[]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions++;
      else if (line.startsWith("-")) deletions++;
    }
  }
  return { additions, deletions };
}

/** The hunks of a unified diff, from its `@@` headers on; file headers and notes are skipped. */
export function unifiedDiffHunks(diff: string): StructuredPatchHunk[] {
  const hunks: StructuredPatchHunk[] = [];
  for (const line of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header !== null) {
      hunks.push({
        oldStart: Number(header[1]),
        oldLines: Number(header[2] ?? 1),
        newStart: Number(header[3]),
        newLines: Number(header[4] ?? 1),
        lines: [],
      });
    } else if (/^[+ -]/.test(line) && !/^(\+\+\+|---) /.test(line)) {
      hunks.at(-1)?.lines.push(line);
    }
  }
  return hunks;
}

/** A file's lines; a final newline ends the last line rather than starting an empty one. */
const linesOf = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/** A whole file as one hunk of additions (a new file) or removals (a deleted one). */
export function wholeFileHunks(content: string, sign: "+" | "-"): StructuredPatchHunk[] {
  const lines = linesOf(content);
  if (lines.length === 0) return [];
  const added = sign === "+";
  return [
    {
      oldStart: added ? 0 : 1,
      oldLines: added ? 0 : lines.length,
      newStart: added ? 1 : 0,
      newLines: added ? lines.length : 0,
      lines: lines.map((line) => `${sign}${line}`),
    },
  ];
}

/** A Codex patch's change to one file (`FileUpdateChange` in its app-server protocol). */
export interface PatchChange {
  path: string;
  kind: { type: "add" } | { type: "delete" } | { type: "update"; move_path?: string | null };
  /** The new file's contents for `add`, the old file's for `delete`, a unified diff for `update`. */
  diff: string;
}

/** A Codex file change as hunks; an added or deleted file is one whole-file hunk. */
export const patchChangeHunks = (change: PatchChange): StructuredPatchHunk[] =>
  change.kind.type === "update"
    ? unifiedDiffHunks(change.diff)
    : wholeFileHunks(change.diff, change.kind.type === "add" ? "+" : "-");

/** Edits past this many compared line pairs are shown as all removed, then all added. */
const MAX_DIFF_CELLS = 1_000_000;

type Op = { sign: " " | "-" | "+"; text: string };

/** A line diff of `before` against `after`: the longest common subsequence, kept as context. */
function diffLines(before: readonly string[], after: readonly string[]): Op[] {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  const a = before.slice(head, before.length - tail);
  const b = after.slice(head, after.length - tail);
  const middle: Op[] = [];
  if (a.length * b.length > MAX_DIFF_CELLS) {
    middle.push(...a.map((text) => ({ sign: "-" as const, text })));
    middle.push(...b.map((text) => ({ sign: "+" as const, text })));
  } else {
    // lcs[i][j]: the common subsequence length of a[i..] and b[j..], flattened.
    const width = b.length + 1;
    const lcs = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i * width + j] =
          a[i] === b[j]
            ? lcs[(i + 1) * width + j + 1]! + 1
            : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        middle.push({ sign: " ", text: a[i]! });
        i++;
        j++;
      } else if (
        j < b.length &&
        (i === a.length || lcs[i * width + j + 1]! > lcs[(i + 1) * width + j]!)
      ) {
        middle.push({ sign: "+", text: b[j]! });
        j++;
      } else {
        middle.push({ sign: "-", text: a[i]! });
        i++;
      }
    }
  }
  return [
    ...before.slice(0, head).map((text) => ({ sign: " " as const, text })),
    ...middle,
    ...after.slice(after.length - tail).map((text) => ({ sign: " " as const, text })),
  ];
}

/** Unchanged lines kept around each change in a whole-file diff, as `git diff` does. */
const CONTEXT = 3;

/** Hunks for a change of a whole file from `before` to `after`, with `CONTEXT` lines around each. */
export function fileDiffHunks(before: string, after: string): StructuredPatchHunk[] {
  const ops = diffLines(linesOf(before), linesOf(after));
  const hunks: StructuredPatchHunk[] = [];
  let oldNo = 1;
  let newNo = 1;
  let current: StructuredPatchHunk | undefined;
  /** Context lines seen since the last change, not yet in a hunk. */
  let pending: Op[] = [];
  let pendingStart = { oldNo, newNo };
  for (const op of ops) {
    if (op.sign === " ") {
      if (pending.length === 0) pendingStart = { oldNo, newNo };
      pending.push(op);
      oldNo++;
      newNo++;
      // Far enough from the last change that the next one starts a hunk of its own.
      if (current !== undefined && pending.length === CONTEXT * 2) {
        const kept = pending.slice(0, CONTEXT);
        current.lines.push(...kept.map((line) => ` ${line.text}`));
        current.oldLines += kept.length;
        current.newLines += kept.length;
        current = undefined;
      }
      continue;
    }
    if (current === undefined) {
      const lead = pending.slice(-CONTEXT);
      const skipped = pending.length - lead.length;
      const start =
        pending.length === 0
          ? { oldNo, newNo }
          : { oldNo: pendingStart.oldNo + skipped, newNo: pendingStart.newNo + skipped };
      current = {
        oldStart: start.oldNo,
        oldLines: lead.length,
        newStart: start.newNo,
        newLines: lead.length,
        lines: lead.map((line) => ` ${line.text}`),
      };
      hunks.push(current);
    } else {
      current.lines.push(...pending.map((line) => ` ${line.text}`));
      current.oldLines += pending.length;
      current.newLines += pending.length;
    }
    pending = [];
    current.lines.push(`${op.sign}${op.text}`);
    if (op.sign === "-") {
      current.oldLines++;
      oldNo++;
    } else {
      current.newLines++;
      newNo++;
    }
  }
  if (current !== undefined) {
    const trail = pending.slice(0, CONTEXT);
    current.lines.push(...trail.map((line) => ` ${line.text}`));
    current.oldLines += trail.length;
    current.newLines += trail.length;
  }
  return hunks;
}

/**
 * One hunk for a replacement known only by its strings, every line of both kept. Its numbers count
 * from the strings, not the file.
 */
export function replacementHunk(oldString: string, newString: string): StructuredPatchHunk {
  const ops = diffLines(oldString.split("\n"), newString.split("\n"));
  const oldLines = ops.filter((op) => op.sign !== "+").length;
  const newLines = ops.filter((op) => op.sign !== "-").length;
  return {
    oldStart: 1,
    oldLines,
    newStart: 1,
    newLines,
    lines: ops.map((op) => `${op.sign}${op.text}`),
  };
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const patchOf = (value: unknown): StructuredPatchHunk[] | undefined =>
  Array.isArray(value) &&
  value.every(
    (hunk) => Array.isArray(record(hunk)["lines"]) && typeof record(hunk)["oldStart"] === "number",
  )
    ? (value as StructuredPatchHunk[])
    : undefined;

const edit = (
  path: string,
  kind: FileEditKind,
  hunks: readonly StructuredPatchHunk[],
  numbered = true,
  movedTo?: string,
): FileEdit => ({
  path,
  ...(movedTo === undefined ? {} : { movedTo }),
  kind,
  hunks,
  numbered,
  ...hunkCounts(hunks),
});

const PATCH_KIND: Record<PatchChange["kind"]["type"], FileEditKind> = {
  add: "create",
  delete: "delete",
  update: "modify",
};

const isPatchChange = (value: unknown): value is PatchChange => {
  const change = record(value);
  const kind = text(record(change["kind"])["type"]);
  return (
    typeof change["path"] === "string" &&
    typeof change["diff"] === "string" &&
    (kind === "add" || kind === "delete" || kind === "update")
  );
};

/** The tool names whose calls change files, as both mappers name them. */
export const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write"]);

/**
 * The files a tool call changed, from what it was asked and what it reported, or `[]` for a call
 * that changes no file or doesn't say which yet. `output` is the stored result: the SDK's structured
 * one, the result text a subagent's call has instead, or `undefined` while it runs.
 *
 * - Codex: each of `input.changes`, a patch's change to one file.
 * - Claude Edit and MultiEdit: the result's `structuredPatch`, numbered; else the replaced strings.
 * - Claude Write: a new file is all added; an overwrite is its `structuredPatch`, or a diff against
 *   `originalFile`; contents nobody reported the old version of are all added, as a `write`.
 */
export function fileEditsOf(toolName: string, input: unknown, output: unknown): FileEdit[] {
  if (!FILE_EDIT_TOOLS.has(toolName)) return [];
  const args = record(input);
  const changes = args["changes"];
  if (Array.isArray(changes)) {
    return changes
      .filter(isPatchChange)
      .map((change) =>
        edit(
          change.path,
          PATCH_KIND[change.kind.type],
          patchChangeHunks(change),
          true,
          change.kind.type === "update" ? (change.kind.move_path ?? undefined) : undefined,
        ),
      );
  }
  const result = record(output);
  const path = text(args["file_path"]) ?? text(result["filePath"]);
  if (path === undefined || path === "") return [];
  const patch = patchOf(result["structuredPatch"]);

  if (toolName === "Write") {
    const content = text(result["content"]) ?? text(args["content"]) ?? "";
    if (result["type"] === "create") return [edit(path, "create", wholeFileHunks(content, "+"))];
    // Codex stores a patch that adds one file as a Write whose one hunk adds everything.
    const first = patch?.[0];
    if (patch?.length === 1 && first?.oldStart === 0 && first.oldLines === 0) {
      return [edit(path, "create", patch)];
    }
    if (patch !== undefined && patch.length > 0) return [edit(path, "modify", patch)];
    const original = text(result["originalFile"]);
    if (original !== undefined) return [edit(path, "modify", fileDiffHunks(original, content))];
    if (result["type"] === "update") return [edit(path, "modify", [])];
    const created = typeof output === "string" && /\bcreated\b/i.test(output);
    return [edit(path, created ? "create" : "write", wholeFileHunks(content, "+"))];
  }

  if (patch !== undefined && patch.length > 0) return [edit(path, "modify", patch)];
  const pairs =
    toolName === "MultiEdit"
      ? (Array.isArray(args["edits"]) ? args["edits"] : []).map(record)
      : [
          {
            old_string: args["old_string"] ?? result["oldString"],
            new_string: args["new_string"] ?? result["newString"],
          },
        ];
  const hunks = pairs.flatMap((pair) => {
    const before = text(pair["old_string"]);
    const after = text(pair["new_string"]);
    return before === undefined || after === undefined ? [] : [replacementHunk(before, after)];
  });
  return [edit(path, "modify", hunks, false)];
}

/** What a row says happened to a file: "Edited", "Created". */
export const FILE_EDIT_VERB: Record<FileEditKind, { done: string; doing: string }> = {
  create: { done: "Created", doing: "Creating" },
  modify: { done: "Edited", doing: "Editing" },
  delete: { done: "Deleted", doing: "Deleting" },
  write: { done: "Wrote", doing: "Writing" },
};
