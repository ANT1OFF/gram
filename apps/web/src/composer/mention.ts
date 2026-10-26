import type { FsFileName } from "@gram/contracts";

export interface MentionTrigger {
  /** Where the `@` is. */
  readonly start: number;
  /** What's typed after it, up to the caret. */
  readonly query: string;
}

/** A run of three or more backticks or tildes, and what follows it on the line. */
const FENCE_RUN = /^(`{3,}|~{3,})(.*)$/;
/** A block quote marker, which a quoted fence repeats on every one of its lines. */
const QUOTE = /^ {0,3}> ?/;
/** A list marker and the spaces after it; its length is where the item's content starts. */
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?: +|$)/;

/** How far a line is indented, in characters and in columns: a tab is as wide as four spaces. */
const indentOf = (line: string) => {
  const chars = line.length - line.trimStart().length;
  return { chars, columns: chars + 3 * (line.slice(0, chars).split("\t").length - 1) };
};

/**
 * Whether the text up to the caret ends inside a code fence that hasn't been closed. Fences are
 * CommonMark's: backticks or tildes, indented at most three columns, closed only by a run of the
 * same character at least as long as the opener with nothing after it. So a three-backtick block
 * quoted inside a four-backtick one neither closes it nor opens another, and four spaces make an
 * indented code line, not a fence.
 *
 * Containers move the margin those three columns are counted from: a `>` is stripped from every
 * line, and a list item's content column carries to the lines under it until one starts left of
 * it. A line that leaves the fence's container closes the fence, as it does in CommonMark, so a
 * run at the root after a quoted fence opens a new one. That is a sketch of CommonMark's container rules, not the whole of them (a fence in an outer
 * item after a nested list is missed), and it errs towards calling a fence open: the cost is an
 * Enter that starts a new line where it could have sent.
 */
export const inOpenFence = (before: string): boolean => {
  let open:
    | {
        readonly char: string;
        readonly length: number;
        readonly margin: number;
        readonly quotes: number;
      }
    | undefined;
  let margin = 0;
  for (const raw of before.split("\n")) {
    let line = raw;
    let quotes = 0;
    // Inside a fence only its own container's markers are markers; a `>` past those is content.
    const deepest = open?.quotes ?? Infinity;
    for (; quotes < deepest && QUOTE.test(line); quotes++) line = line.replace(QUOTE, "");
    if (open !== undefined) {
      const indent = indentOf(line);
      // A line outside the fence's container ends the container and the fence with it, closer or
      // no closer. So a run out there is read below, as what it is: the opener of a new fence.
      const left = quotes < open.quotes || (line.trim() !== "" && indent.columns < open.margin);
      if (!left) {
        const fence =
          indent.columns - open.margin <= 3 ? FENCE_RUN.exec(line.slice(indent.chars)) : null;
        const closes =
          fence !== null &&
          fence[1]![0] === open.char &&
          fence[1]!.length >= open.length &&
          fence[2]!.trim() === "";
        if (closes) open = undefined;
        continue;
      }
      open = undefined;
    }
    let column = 0;
    for (let item = LIST_ITEM.exec(line); item; item = LIST_ITEM.exec(line.slice(column))) {
      column += item[0].length;
    }
    const indent = indentOf(line.slice(column));
    if (column > 0) margin = column;
    else if (line.trim() !== "" && indent.columns < margin) margin = 0;
    const fence =
      column + indent.columns - margin <= 3
        ? FENCE_RUN.exec(line.slice(column + indent.chars))
        : null;
    // A backtick fence's info string can't hold a backtick: that line is inline code.
    if (!fence || (fence[1]![0] === "`" && fence[2]!.includes("`"))) continue;
    open = { char: fence[1]![0]!, length: fence[1]!.length, margin, quotes };
  }
  return open !== undefined;
};

/**
 * The mention being typed at `caret`: an `@` at the start or after whitespace or an opening
 * bracket, with no whitespace up to the caret, outside a code fence. So `a@b` never triggers.
 */
export function mentionTrigger(text: string, caret: number): MentionTrigger | undefined {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start === -1) return undefined;
  const query = before.slice(start + 1);
  if (/\s/.test(query)) return undefined;
  if (start > 0 && !/[\s([{]/.test(before[start - 1]!)) return undefined;
  if (inOpenFence(before)) return undefined;
  return { start, query };
}

/** A folder's path ends in `/`, so it reads as one and filters to its children. */
export const mentionPath = (entry: FsFileName): string =>
  entry.kind === "dir" ? `${entry.path}/` : entry.path;

/** Points Claude Code at a file or folder; quoted when the path has whitespace. */
export const formatMention = (path: string): string =>
  /\s/.test(path) ? `@"${path}"` : `@${path}`;

const SEPARATORS = new Set(["/", ".", "-", "_"]);

/**
 * How well `query`'s characters appear in order in `path`: runs of adjacent characters, segment
 * starts and a matching file name score higher. `undefined` when they don't all appear.
 */
function mentionScore(path: string, query: string): number | undefined {
  const p = path.toLowerCase();
  const q = query.toLowerCase();
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of q) {
    const index = p.indexOf(char, from);
    if (index === -1) return undefined;
    if (index === previous + 1) score += 3;
    if (index === 0 || SEPARATORS.has(p[index - 1]!)) score += 2;
    previous = index;
    from = index + 1;
  }
  const name = p.slice(p.lastIndexOf("/", p.length - 2) + 1);
  if (name.startsWith(q)) score += 10;
  else if (name.includes(q)) score += 5;
  if (p.startsWith(q)) score += 8;
  return score - path.length / 100;
}

const depth = (path: string) => path.replace(/\/$/, "").split("/").length;

/**
 * The entries to offer for `query`, best first. Nothing typed offers the top level; a query ending
 * in `/` offers that folder's children; anything else matches fuzzily across every path.
 */
export function rankMentions(
  entries: readonly FsFileName[],
  query: string,
  limit = 50,
): FsFileName[] {
  if (query === "" || query.endsWith("/")) {
    const parent = query.toLowerCase();
    return entries
      .filter((entry) => {
        const path = mentionPath(entry).toLowerCase();
        return (
          path !== parent &&
          path.startsWith(parent) &&
          depth(path) === depth(parent) + (parent === "" ? 0 : 1)
        );
      })
      .toSorted((a, b) =>
        a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "dir" ? -1 : 1,
      )
      .slice(0, limit);
  }
  return entries
    .flatMap((entry) => {
      const score = mentionScore(mentionPath(entry), query);
      return score === undefined ? [] : [{ entry, score }];
    })
    .toSorted((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path))
    .slice(0, limit)
    .map((ranked) => ranked.entry);
}

/**
 * The text with the typed mention replaced by `entry`, and where the caret goes. A file gets a
 * space after it; a folder doesn't, so typing goes on into it.
 */
export function insertMention(
  text: string,
  trigger: MentionTrigger,
  caret: number,
  entry: FsFileName,
): { readonly text: string; readonly caret: number } {
  const path = mentionPath(entry);
  const mention = formatMention(path);
  const after = text.slice(caret);
  const open = entry.kind === "dir" && !/\s/.test(path);
  // A space already after the caret isn't doubled; the caret still steps past it.
  const spaced = open || /^\s/.test(after) ? mention : `${mention} `;
  return {
    text: `${text.slice(0, trigger.start)}${spaced}${after}`,
    caret: trigger.start + mention.length + (open ? 0 : 1),
  };
}
