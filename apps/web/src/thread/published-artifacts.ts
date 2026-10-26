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

/** Only claude.ai's own pages: a card never offers to open anything else it was handed. */
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

/** An absolute Markdown or HTML path outside credential folders, which the Preview tab may show. */
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
    if (Reflect.get(part, "type") !== "tool-Artifact") continue;
    if (Reflect.get(part, "state") !== "output-available") continue;
    const output: unknown = Reflect.get(part, "output");
    if (typeof output !== "object" || output === null) continue;
    const url: unknown = Reflect.get(output, "url");
    if (!claudeAiPage(url)) continue;
    const input: unknown = Reflect.get(part, "input");
    const filePath: unknown =
      typeof input === "object" && input !== null ? Reflect.get(input, "file_path") : undefined;
    const source = previewSource(filePath) ?? previewSource(Reflect.get(output, "path"));
    const title = text(Reflect.get(output, "title"));
    const version = text(Reflect.get(output, "version"));
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
