import { isCredentialPath, previewFileKind, type PreviewFileKind } from "@gram/contracts";

/** A page a message's Artifact calls published to claude.ai, and the local file it came from. */
export interface PublishedArtifact {
  /** The page on claude.ai, e.g. `https://claude.ai/code/artifact/<uuid>`. */
  readonly url: string;
  readonly title?: string;
  /** The published version, when Claude Code says which. */
  readonly version?: string;
  /** The file Claude published, when the Preview tab can show it too. */
  readonly source?: { readonly path: string; readonly kind: PreviewFileKind };
}

const claudeAiPage = (url: unknown): url is string => {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "claude.ai";
  } catch {
    return false;
  }
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const previewSource = (path: unknown): PublishedArtifact["source"] => {
  if (typeof path !== "string" || !/^(\/|~\/|[A-Za-z]:[\\/])/.test(path)) return undefined;
  const kind = previewFileKind(path);
  return kind === undefined || isCredentialPath(path) ? undefined : { path, kind };
};

/**
 * The pages a message's finished Artifact publishes left, once each by URL, in the order each was
 * last published, so a republish shows its latest title and version. A list, read or failed call
 * leaves none: only a publish result carries a `url` at its top level. The source is the call's
 * `file_path`, or the path Claude Code reports, when the Preview tab can show it.
 */
export function publishedArtifacts(parts: readonly unknown[]): PublishedArtifact[] {
  const seen = new Map<string, PublishedArtifact>();
  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue;
    if (("type" in part ? part.type : undefined) !== "tool-Artifact") continue;
    if (("state" in part ? part.state : undefined) !== "output-available") continue;
    const output: unknown = "output" in part ? part.output : undefined;
    if (typeof output !== "object" || output === null) continue;
    const url: unknown = "url" in output ? output.url : undefined;
    if (!claudeAiPage(url)) continue;
    const input: unknown = "input" in part ? part.input : undefined;
    const filePath: unknown =
      typeof input === "object" && input !== null && "file_path" in input
        ? input.file_path
        : undefined;
    const source =
      previewSource(filePath) ?? previewSource("path" in output ? output.path : undefined);
    const title = text("title" in output ? output.title : undefined);
    const version = text("version" in output ? output.version : undefined);
    seen.delete(url);
    seen.set(url, {
      url,
      ...(title === undefined ? {} : { title }),
      ...(version === undefined ? {} : { version }),
      ...(source === undefined ? {} : { source }),
    });
  }
  return [...seen.values()];
}
