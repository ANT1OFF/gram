// Which transcript chunks say a thread produced a file, read as the runtime folds them: no file is
// opened here. The runtime hands each one to its observers (`RuntimeObserver.onOutput`), and
// `WorkspaceOutputs` checks and records it.

import { outputKindOf, type GramUIMessageChunk, type OutputSource } from "@gram/contracts";
import { fileURLToPath } from "node:url";

/** A file a chunk names as the thread's own output, before anything has checked it. */
export interface ObservedOutput {
  /** As the chunk names it; `WorkspaceOutputs` resolves and checks it. */
  readonly path: string;
  readonly source: OutputSource;
}

/** A tool part as the accumulator holds it. */
type ToolPart = Readonly<Record<string, unknown>> & { readonly type: string };

const toolName = (part: ToolPart): string | undefined => {
  if (part.type === "dynamic-tool") {
    const name = part["toolName"];
    return typeof name === "string" ? name : undefined;
  }
  return part.type.startsWith("tool-") ? part.type.slice("tool-".length) : undefined;
};

const filePath = (url: string): string | undefined => {
  if (!url.startsWith("file:")) return undefined;
  try {
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
};

/**
 * The output `chunk` reports, if any, with `toolPart` the message's tool part by call id:
 *
 * - an image a tool call returned and Gram stored (`data-tool-image` with a path), unless the call
 *   was a Read, which looked at a file that already existed;
 * - a file the agent sent the user (`send_file`'s `file` parts);
 * - a finished Write of an image, a recording or a document (code and other files are left out).
 */
export function chunkOutput(
  chunk: GramUIMessageChunk,
  toolPart: (toolCallId: string) => ToolPart | undefined,
): ObservedOutput | undefined {
  if (chunk.type === "data-tool-image") {
    const { path, toolCallId } = chunk.data;
    if (path === undefined) return undefined;
    const part = toolPart(toolCallId);
    if (part !== undefined && toolName(part) === "Read") return undefined;
    return { path, source: "toolImage" };
  }
  if (chunk.type === "file") {
    const path = filePath(chunk.url);
    return path === undefined ? undefined : { path, source: "sent" };
  }
  if (chunk.type === "tool-output-available" && chunk.preliminary !== true) {
    const part = toolPart(chunk.toolCallId);
    if (part === undefined || toolName(part) !== "Write") return undefined;
    const input = part["input"];
    if (typeof input !== "object" || input === null) return undefined;
    const path: unknown = Reflect.get(input, "file_path");
    if (typeof path !== "string" || path === "") return undefined;
    return outputKindOf(path, "written") === "other" ? undefined : { path, source: "written" };
  }
  return undefined;
}
