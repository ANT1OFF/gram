import type { FolderEntry } from "@gram/contracts";

const lastSeparator = (value: string) => Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));

/** Splits a typed path into its directory part (separator included) and the segment being typed. */
export function splitForCompletion(value: string): { dir: string; leaf: string } {
  const i = lastSeparator(value);
  return i === -1
    ? { dir: "", leaf: value }
    : { dir: value.slice(0, i + 1), leaf: value.slice(i + 1) };
}

/** The longest case-insensitive common prefix, in the first name's casing. */
export function commonPrefix(names: readonly string[]): string {
  const [first, ...rest] = names;
  if (first === undefined) return "";
  let length = first.length;
  for (const name of rest) {
    let i = 0;
    while (i < length && i < name.length && name[i]!.toLowerCase() === first[i]!.toLowerCase()) i++;
    length = i;
  }
  return first.slice(0, length);
}

/**
 * What Tab turns `value` into given the folders matching it: the one match entered (with a trailing
 * separator), or the matches' common prefix. `undefined` when Tab would change nothing.
 */
export function tabCompletion(value: string, matches: readonly FolderEntry[]): string | undefined {
  const { dir, leaf } = splitForCompletion(value);
  if (matches.length === 1) return `${dir}${matches[0]!.name}/`;
  const prefix = commonPrefix(matches.map((m) => m.name));
  return prefix.length > leaf.length ? dir + prefix : undefined;
}

/** `path` with the home directory shown as `~`. */
export function tildify(path: string, home: string | undefined): string {
  if (!home) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export const baseName = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** Breadcrumb segments for `path`, rooted at `~` when it's inside home. */
export function breadcrumbs(
  path: string,
  home: string | undefined,
): { label: string; path: string }[] {
  const inHome = home !== undefined && (path === home || path.startsWith(`${home}/`));
  const root = inHome ? { label: "~", path: home } : { label: "/", path: "/" };
  const rest = path.slice(root.path.length).split("/").filter(Boolean);
  const crumbs = [root];
  let current = root.path;
  for (const segment of rest) {
    current = current === "/" ? `/${segment}` : `${current}/${segment}`;
    crumbs.push({ label: segment, path: current });
  }
  return crumbs;
}
