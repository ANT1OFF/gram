/** Matches of a query in a text, case-insensitively, as start offsets; at most `limit`. */
export function findAll(text: string, query: string, limit = 1000): number[] {
  if (!query) return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const found: number[] = [];
  let at = haystack.indexOf(needle);
  while (at >= 0 && found.length < limit) {
    found.push(at);
    at = haystack.indexOf(needle, at + needle.length);
  }
  return found;
}

/** The offset each line of a text starts at. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
  return starts;
}

/** The line, from 0, an offset is on. */
export function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** How many columns `text` takes, a tab reaching the next stop of `tabSize`. */
export function columns(text: string, tabSize: number): number {
  let column = 0;
  for (const char of text)
    column = char === "\t" ? column + tabSize - (column % tabSize) : column + 1;
  return column;
}

/** A text with its selection, before or after an edit. */
export interface Edit {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Tab and Shift+Tab on a selection: an empty or one-line selection forward is replaced by
 * `tabSize` spaces; a selection over lines, or any Shift+Tab, indents or outdents each line it
 * touches. Returns the replaced range (`from` to `to` of the old text) and what replaces it.
 */
export function indent(
  edit: Edit,
  tabSize: number,
  outdent: boolean,
): { from: number; to: number; insert: string; start: number; end: number } {
  const { value, start, end } = edit;
  const unit = " ".repeat(tabSize);
  const multiline = value.slice(start, end).includes("\n");
  if (!outdent && !multiline)
    return { from: start, to: end, insert: unit, start: start + tabSize, end: start + tabSize };
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const last = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const lineEnd = value.indexOf("\n", last);
  const to = lineEnd < 0 ? value.length : lineEnd;
  const lines = value.slice(from, to).split("\n");
  let shiftStart = 0;
  let shiftEnd = 0;
  const changed = lines.map((line, index) => {
    if (!outdent) {
      shiftEnd += tabSize;
      if (index === 0) shiftStart = tabSize;
      return unit + line;
    }
    const lead = /^ */.exec(line)![0].length;
    const tab = line.startsWith("\t") ? 1 : 0;
    const cut = tab || Math.min(lead, tabSize);
    shiftEnd -= cut;
    if (index === 0) shiftStart = -Math.min(cut, start - from);
    return line.slice(cut);
  });
  return {
    from,
    to,
    insert: changed.join("\n"),
    start: Math.max(from, start + shiftStart),
    end: Math.max(from, end + shiftEnd),
  };
}
