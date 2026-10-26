import { checkoutRelative } from "@/panels/files/files-store";

export interface PathLink {
  /** Offsets into the scanned text; `end` is exclusive. */
  readonly start: number;
  readonly end: number;
  /** Absolute, inside the checkout. */
  readonly path: string;
  readonly line: number;
  readonly column?: number;
}

// A file with an extension and a `:line` (optionally `:column`), relative or absolute (POSIX or `C:\`).
const PATH_LINE =
  /(?:[A-Za-z]:[\\/]|\/|\.{1,2}\/)?(?:[\w@+.-]+[\\/])*[\w@+.-]*\.[A-Za-z0-9]+:(\d+)(?::(\d+))?/g;

/**
 * The `path:line` references in one terminal line that point at files inside the checkout `root`,
 * such as compiler errors and stack frames. URLs and paths outside the checkout are skipped.
 */
export function findPathLinks(text: string, root: string | undefined): PathLink[] {
  if (root === undefined) return [];
  const base = root.replaceAll("\\", "/").replace(/\/+$/, "");
  const links: PathLink[] = [];
  for (const match of text.matchAll(PATH_LINE)) {
    const start = match.index;
    // Part of a URL (`https://host/a.ts:3`) or glued to a longer word.
    if (/:\/\/\S*$/.test(text.slice(0, start)) || /[\w@+-]$/.test(text.slice(0, start))) continue;
    const target = match[0].replace(/:\d+(?::\d+)?$/, "");
    const relative = checkoutRelative(target, base);
    if (relative === undefined) continue;
    const column = match[2] === undefined ? undefined : Number(match[2]);
    links.push({
      start,
      end: start + match[0].length,
      path: `${base}/${relative}`,
      line: Number(match[1]),
      ...(column === undefined ? {} : { column }),
    });
  }
  return links;
}
