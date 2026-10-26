// What a workspace's threads produced, in one place: screenshots and recordings the browser tools
// saved, images tool calls returned, files an agent sent the user, and media or documents it wrote.
// Recorded as each lands (the server's `outputs/`), never by scanning a disk. An entry names the
// file and the thread that made it; its bytes are read through that thread's own scoped paths
// (`fs.image`, `attachment.read`, the Files panel), so this list grants nothing.
import * as Schema from "effect/Schema";
import { ThreadId, WorkspaceId } from "./ids.ts";

/** What the Files view groups and filters by. */
export const OUTPUT_KINDS = ["screenshot", "recording", "image", "document", "other"] as const;
export const OutputKind = Schema.Literals(OUTPUT_KINDS);
export type OutputKind = typeof OutputKind.Type;

/**
 * How Gram learned of the file: `evidence` a browser tool saved it in the thread's checkout,
 * `toolImage` a tool call returned it and Gram stored it in the thread's attachments, `sent` the
 * agent showed it to the user (`send_file`), `written` its finished Write created it.
 */
export const OUTPUT_SOURCES = ["evidence", "toolImage", "sent", "written"] as const;
export const OutputSource = Schema.Literals(OUTPUT_SOURCES);
export type OutputSource = typeof OutputSource.Type;

export const WorkspaceOutput = Schema.Struct({
  /** Stable while the entry lasts; a rewrite of the same file keeps it. */
  id: Schema.String,
  threadId: ThreadId,
  /** The thread's title as it is now. */
  threadTitle: Schema.String,
  /** The workspace's orchestrator made it, rather than a worker. */
  orchestrator: Schema.Boolean,
  /** The feature of the worker that made it. */
  feature: Schema.optionalKey(Schema.String),
  /** Absolute, as the thread named it. */
  path: Schema.String,
  kind: OutputKind,
  source: OutputSource,
  mediaType: Schema.String,
  /** Bytes when it was last written. */
  size: Schema.Number,
  /** Epoch ms it was last written. */
  at: Schema.Number,
});
export type WorkspaceOutput = typeof WorkspaceOutput.Type;

/** Newest first. `next` continues the list where this page ended; absent on the last page. */
export const WorkspaceOutputsPage = Schema.Struct({
  outputs: Schema.Array(WorkspaceOutput),
  next: Schema.optionalKey(Schema.String),
});
export type WorkspaceOutputsPage = typeof WorkspaceOutputsPage.Type;

export const WorkspaceOutputsFields = {
  workspaceId: WorkspaceId,
  kind: Schema.optionalKey(OutputKind),
  /** A previous page's `next`. */
  cursor: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
};

/** A page when no `limit` is asked for, and the most one may hold. */
export const OUTPUTS_PAGE = 60;
export const OUTPUTS_PAGE_MAX = 200;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  heic: "image/heic",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  pdf: "application/pdf",
  md: "text/markdown",
  markdown: "text/markdown",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
  csv: "text/csv",
};

const extensionOf = (path: string): string => {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
};

/** The media type a file's extension says, else bytes. */
export const outputMediaType = (path: string): string =>
  MEDIA_TYPES[extensionOf(path)] ?? "application/octet-stream";

/**
 * Which kind a file is. Browser evidence is a screenshot (`.png`) or a recording (`.gif`); an image a
 * tool call returned is a screenshot. Otherwise the extension decides: video is a recording, then
 * images, then documents; anything else is `other`.
 */
export const outputKindOf = (path: string, source: OutputSource): OutputKind => {
  const type = outputMediaType(path);
  if (source === "evidence") return type === "image/gif" ? "recording" : "screenshot";
  if (source === "toolImage") return "screenshot";
  if (type.startsWith("video/")) return "recording";
  if (type.startsWith("image/")) return "image";
  if (type !== "application/octet-stream") return "document";
  return "other";
};

/** Kinds the Files view can show as a picture: `fs.image` and `attachment.read` serve these. */
export const outputPreviewable = (output: Pick<WorkspaceOutput, "mediaType">): boolean =>
  /^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(output.mediaType);
