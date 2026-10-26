/** One terminal row as find sees it. */
export interface FindRow {
  text: string;
  /** Whether the row soft-wrapped from the one above, so a match may run across the two. */
  wrapped: boolean;
  /**
   * The cell column of each UTF-16 unit in `text`, which drift apart after a wide character, and one
   * more: the column the text ends at, so the last character's width is known too.
   */
  columns: readonly number[];
}

/** The cells one match covers on one row; `width` is in cells. */
interface FindSegment {
  row: number;
  column: number;
  width: number;
}

/** A match, as one segment per row it touches. */
export type FindMatch = readonly FindSegment[];

export interface FindQuery {
  term: string;
  caseSensitive: boolean;
  regex: boolean;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `undefined` for an empty term or a regex that doesn't compile; the find bar reports the latter. */
const pattern = ({ term, caseSensitive, regex }: FindQuery): RegExp | undefined => {
  if (term === "") return undefined;
  try {
    return new RegExp(regex ? term : escapeRegExp(term), caseSensitive ? "g" : "gi");
  } catch {
    return undefined;
  }
};

/** A match's cells on the rows of one logical line, given where each row's text starts in it. */
const segments = (
  rows: readonly FindRow[],
  first: number,
  starts: readonly number[],
  from: number,
  to: number,
): FindMatch => {
  const found: FindSegment[] = [];
  for (let i = 0; i < starts.length; i++) {
    const row = rows[first + i]!;
    const begin = Math.max(from, starts[i]!) - starts[i]!;
    const end = Math.min(to, starts[i]! + row.text.length) - starts[i]!;
    if (begin >= end) continue;
    const column = row.columns[begin]!;
    found.push({ row: first + i, column, width: Math.max(row.columns[end]! - column, 1) });
  }
  return found;
};

/**
 * Every match in `rows`, top to bottom. Soft-wrapped rows are searched as the one line the program
 * wrote, so a match can cross a wrap; it never crosses a real line break.
 */
export function findMatches(rows: readonly FindRow[], query: FindQuery): FindMatch[] {
  const regex = pattern(query);
  if (regex === undefined) return [];
  const matches: FindMatch[] = [];
  for (let first = 0; first < rows.length;) {
    const starts = [0];
    let line = rows[first]!.text;
    let last = first;
    while (rows[last + 1]?.wrapped === true) {
      last++;
      starts.push(line.length);
      line += rows[last]!.text;
    }
    for (const match of line.matchAll(regex)) {
      // A regex can match nothing (`a*`); there is nothing to highlight or step to.
      if (match[0] === "") continue;
      matches.push(segments(rows, first, starts, match.index, match.index + match[0].length));
    }
    first = last + 1;
  }
  return matches;
}

const sameStart = (a: FindMatch | undefined, b: FindMatch | undefined) =>
  a?.[0] !== undefined && a[0].row === b?.[0]?.row && a[0].column === b[0].column;

/**
 * Which match becomes active. A fresh find takes the first match at or below `viewportTop`, since
 * that is what the user is looking at. Stepping moves one on from `previous` and wraps. An
 * incremental find (the query grew while typing) stays on `previous` while it still matches there.
 * -1 when there are no matches.
 */
export function nextActive(
  matches: readonly FindMatch[],
  previous: FindMatch | undefined,
  step: "next" | "previous" | "incremental",
  viewportTop: number,
): number {
  if (matches.length === 0) return -1;
  const from = (row: number, column: number) =>
    matches.findIndex((m) => m[0]!.row > row || (m[0]!.row === row && m[0]!.column >= column));
  if (previous?.[0] === undefined) return Math.max(from(viewportTop, 0), 0);
  const at = from(previous[0].row, previous[0].column);
  const held = at !== -1 && sameStart(matches[at], previous);
  if (step === "incremental") return at === -1 ? 0 : at;
  if (step === "next") return held ? (at + 1) % matches.length : at === -1 ? 0 : at;
  return ((at === -1 ? matches.length : at) - 1 + matches.length) % matches.length;
}
