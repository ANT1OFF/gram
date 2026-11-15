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

/** A clone folder's name: `<repo>+<16 hex>`, the repo with a group's subgroups joined by `+`. */
const CLONE_FOLDER = /^(.+)\+[0-9a-f]{16}$/;

/**
 * A folder as a person names it: a clone (`…/<host>/<owner>/<repo>+<hash>`, as Gram clones into)
 * as `owner/repo`, and any other folder by its name.
 */
export const folderLabel = (path: string): string => {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const leaf = parts.at(-1) ?? path;
  const clone = CLONE_FOLDER.exec(leaf);
  if (clone === null) return leaf;
  const repo = clone[1]!.replaceAll("+", "/");
  const owner = parts.at(-2);
  return owner === undefined ? repo : `${owner}/${repo}`;
};

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

/**
 * A folder as a list shows it beside its name: a clone (`…/<host>/<owner>/<repo>+<hash>`) by where
 * it was cloned from, `host/owner/repo`, and any other folder by its path with home as `~`.
 */
export const folderPlace = (path: string, home: string | undefined): string => {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const clone = CLONE_FOLDER.exec(parts.at(-1) ?? "");
  if (clone === null || parts.length < 3) return tildify(path, home);
  return `${parts.at(-3)}/${parts.at(-2)}/${clone[1]!.replaceAll("+", "/")}`;
};

/** A message's plain text, or an absolute path in it with how a person names that folder. */
export type MessagePart =
  | { readonly text: string }
  | { readonly path: string; readonly label: string };

/** An absolute or home-relative path, up to the next space or quote. */
const PATH_IN_TEXT = /(?<=^|[\s("'`])~?\/[^\s"'`()]+/g;

/**
 * `message` split around the paths it names, each path shown as `folderLabel` names a clone
 * (`owner/repo`) or with home as `~`, so a server's own folders read as the repositories they hold.
 * A sentence's closing punctuation stays text.
 */
export const messageParts = (message: string, home: string | undefined): MessagePart[] => {
  const parts: MessagePart[] = [];
  let at = 0;
  for (const match of message.matchAll(PATH_IN_TEXT)) {
    const path = match[0].replace(/[.,;:!?]+$/, "");
    if (path.length < 2) continue;
    if (match.index > at) parts.push({ text: message.slice(at, match.index) });
    const leaf = path.split("/").filter(Boolean).at(-1) ?? "";
    parts.push({ path, label: CLONE_FOLDER.test(leaf) ? folderLabel(path) : tildify(path, home) });
    at = match.index + path.length;
  }
  if (at < message.length) parts.push({ text: message.slice(at) });
  return parts;
};
