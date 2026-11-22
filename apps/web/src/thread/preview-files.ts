import { isCredentialPath, previewFileKind, type PreviewFileKind } from "@gram/contracts";

/**
 * The folder a Markdown file's links resolve within, and root-relative ones against: the thread's
 * folder holding it, as in Files, or for a file elsewhere the folder it is in.
 */
export function markdownRoot(path: string, roots: readonly string[]): string {
  const holding = roots
    .filter((root) => path.startsWith(`${root.replace(/[\\/]+$/, "")}/`))
    .toSorted((a, b) => b.length - a.length)[0];
  return holding?.replace(/[\\/]+$/, "") ?? (path.replace(/[\\/][^\\/]*$/, "") || "/");
}

/** A file a message wrote that the Preview tab can show, with what it shows it as. */
export interface PreviewableFile {
  readonly path: string;
  readonly kind: PreviewFileKind;
}

const WRITERS = new Set(["tool-Write", "tool-Edit", "tool-MultiEdit"]);

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

function finishedWrite(part: unknown): { input: object; paths: string[] } | undefined {
  if (!WRITERS.has(String(field(part, "type")))) return undefined;
  if (field(part, "state") !== "output-available") return undefined;
  const input = field(part, "input");
  if (typeof input !== "object" || input === null) return undefined;
  const paths: unknown[] = [field(input, "file_path")];
  const changes = field(input, "changes");
  if (Array.isArray(changes)) for (const change of changes) paths.push(field(change, "path"));
  return { input, paths: paths.filter((path): path is string => typeof path === "string") };
}

/**
 * The Markdown and HTML files a message's finished Write and Edit calls wrote, once each, in the
 * order each was last written: Claude's `file_path` and each path of a Codex change set. A call
 * still running or one that failed leaves nothing to open, nor does a file in a credential folder.
 */
export function previewableFiles(parts: readonly unknown[]): PreviewableFile[] {
  const seen = new Map<string, PreviewableFile>();
  for (const part of parts) {
    for (const path of finishedWrite(part)?.paths ?? []) {
      const kind = previewFileKind(path);
      if (kind === undefined || isCredentialPath(path)) continue;
      seen.delete(path);
      seen.set(path, { path, kind });
    }
  }
  return [...seen.values()];
}

/** What a thread's finished calls did to one file. */
export interface WritesTo {
  /** How many of them changed it: a new value means the file on disk is newer than a read of it. */
  readonly count: number;
  /**
   * Its whole text after the last of them, where the transcript holds it: a Write's content, with
   * the Edits after it applied. `undefined` when an Edit came first or didn't apply as written.
   */
  readonly content: string | undefined;
}

const applyEdit = (text: string | undefined, edit: unknown): string | undefined => {
  const before = field(edit, "old_string");
  const after = field(edit, "new_string");
  if (text === undefined || typeof before !== "string" || typeof after !== "string")
    return undefined;
  if (before === "") return undefined;
  if (field(edit, "replace_all") === true) return text.split(before).join(after);
  const at = text.indexOf(before);
  return at === -1 ? undefined : text.slice(0, at) + after + text.slice(at + before.length);
};

/**
 * What the finished Write and Edit calls in `messages` did to `path`: how many changed it, and the
 * text they left it with, so a file the worker has since moved off disk (a branch switch, a
 * delete) can still be read as it wrote it.
 */
export function writesTo(
  messages: readonly { readonly parts: readonly unknown[] }[],
  path: string,
): WritesTo {
  let count = 0;
  let content: string | undefined;
  for (const message of messages) {
    for (const part of message.parts) {
      const write = finishedWrite(part);
      if (write === undefined || !write.paths.includes(path)) continue;
      count++;
      const type = field(part, "type");
      if (type === "tool-Write") {
        const text = field(write.input, "content");
        content = typeof text === "string" ? text : undefined;
      } else if (type === "tool-Edit") {
        content = applyEdit(content, write.input);
      } else if (type === "tool-MultiEdit") {
        const edits = field(write.input, "edits");
        content = Array.isArray(edits)
          ? edits.reduce<string | undefined>(applyEdit, content)
          : undefined;
      } else {
        content = undefined;
      }
    }
  }
  return { count, content };
}
