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

/** The tool calls that leave a file behind, by their part's type. */
const WRITERS = new Set(["tool-Write", "tool-Edit", "tool-MultiEdit"]);

/**
 * The Markdown and HTML files a message's finished Write and Edit calls wrote, once each, in the
 * order each was last written: Claude's `file_path` and each path of a Codex change set. A call
 * still running or one that failed leaves nothing to open, nor does a file in a credential folder.
 */
export function previewableFiles(parts: readonly unknown[]): PreviewableFile[] {
  const seen = new Map<string, PreviewableFile>();
  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue;
    if (!WRITERS.has(String(Reflect.get(part, "type")))) continue;
    if (Reflect.get(part, "state") !== "output-available") continue;
    const input: unknown = Reflect.get(part, "input");
    if (typeof input !== "object" || input === null) continue;
    const paths: unknown[] = [Reflect.get(input, "file_path")];
    const changes: unknown = Reflect.get(input, "changes");
    if (Array.isArray(changes)) {
      for (const change of changes) {
        if (typeof change === "object" && change !== null) paths.push(Reflect.get(change, "path"));
      }
    }
    for (const path of paths) {
      if (typeof path !== "string") continue;
      const kind = previewFileKind(path);
      // The server never previews these, so no card offers to.
      if (kind === undefined || isCredentialPath(path)) continue;
      seen.delete(path);
      seen.set(path, { path, kind });
    }
  }
  return [...seen.values()];
}
