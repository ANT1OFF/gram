export type PatchLineKind = "add" | "del" | "ctx" | "note";

export interface PatchLine {
  kind: PatchLineKind;
  text: string;
  /** Line number in the old file; absent for additions and notes. */
  oldNo?: number;
  /** Line number in the new file; absent for deletions and notes. */
  newNo?: number;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The enclosing function or section git prints after the `@@` range. */
  section?: string;
  lines: PatchLine[];
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * Parses a unified diff body (from the first `@@` onward, as `DiffFile.patch` carries it) into
 * hunks with old/new line numbers. Lines before the first hunk header are ignored.
 */
export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  const rows = patch.split("\n");
  if (rows.at(-1) === "") rows.pop();

  for (const raw of rows) {
    const match = HEADER.exec(raw);
    if (match) {
      const [, oldStart, oldLines, newStart, newLines, section] = match;
      current = {
        header: raw,
        oldStart: Number(oldStart),
        oldLines: oldLines === undefined ? 1 : Number(oldLines),
        newStart: Number(newStart),
        newLines: newLines === undefined ? 1 : Number(newLines),
        ...(section ? { section } : {}),
        lines: [],
      };
      hunks.push(current);
      oldNo = current.oldStart;
      newNo = current.newStart;
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("\\")) {
      current.lines.push({ kind: "note", text: raw.slice(1).trim() });
    } else if (raw.startsWith("+")) {
      current.lines.push({ kind: "add", text: raw.slice(1), newNo: newNo++ });
    } else if (raw.startsWith("-")) {
      current.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ });
    } else {
      current.lines.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return hunks;
}

/** One row of a split view: the old side, the new side, or a note across both. */
export type SplitRow =
  | { kind: "pair"; left?: PatchLine; right?: PatchLine }
  | { kind: "note"; text: string };

/**
 * A hunk's lines side by side: context on both sides, and each run of removals paired row by row
 * with the additions that follow it, the shorter side padded with blanks.
 */
export function splitRows(lines: readonly PatchLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: PatchLine[] = [];
  let adds: PatchLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const left = dels[i];
      const right = adds[i];
      rows.push({ kind: "pair", ...(left ? { left } : {}), ...(right ? { right } : {}) });
    }
    dels = [];
    adds = [];
  };
  for (const line of lines) {
    if (line.kind === "del") {
      // A removal after additions starts a new change, not a longer one.
      if (adds.length > 0) flush();
      dels.push(line);
    } else if (line.kind === "add") {
      adds.push(line);
    } else {
      flush();
      rows.push(
        line.kind === "note"
          ? { kind: "note", text: line.text }
          : { kind: "pair", left: line, right: line },
      );
    }
  }
  flush();
  return rows;
}

/** How many hunks a patch has, without parsing it. */
export const countHunks = (patch: string): number => patch.match(/^@@ -\d/gm)?.length ?? 0;

/** What a comment on hunk lines `a` to `b` (either order, inclusive) refers to. */
export function lineRange(
  hunk: Hunk,
  a: number,
  b: number,
): { side: "new" | "old"; start: number; end: number; snippet: string } {
  const lines = hunk.lines
    .slice(Math.min(a, b), Math.max(a, b) + 1)
    .filter((l) => l.kind !== "note");
  const numbers = lines.flatMap((line) => (line.newNo === undefined ? [] : [line.newNo]));
  const side = numbers.length > 0 ? "new" : "old";
  const used = side === "new" ? numbers : lines.map((line) => line.oldNo ?? 0);
  const prefix: Record<PatchLineKind, string> = { add: "+", del: "-", ctx: " ", note: "\\ " };
  return {
    side,
    start: Math.min(...used),
    end: Math.max(...used),
    snippet: lines.map((line) => `${prefix[line.kind]}${line.text}`).join("\n"),
  };
}
