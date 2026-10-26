import { FILE_EDIT_VERB, visibleText, type FileEdit, type ToolImageData } from "@gram/contracts";

import { formatSize } from "@/panels/files/format";

import {
  isToolPart,
  partEdits,
  toolNameOf,
  toolPhase,
  basename,
  type AnyToolPart,
  type MessagePart,
} from "./parts";

/** Tool calls that keep their own card: a subagent's card carries its whole transcript. */
const UNGROUPED = new Set(["Task", "Agent"]);

const groupable = (part: MessagePart): part is AnyToolPart =>
  isToolPart(part) && !UNGROUPED.has(toolNameOf(part));

/** The shortest run worth folding; a lone tool call is already one line. */
const MIN_RUN = 2;

export interface ToolRuns {
  /** Each folded run, keyed by the index of its first part. */
  starts: ReadonlyMap<number, readonly AnyToolPart[]>;
  /** Indexes of the parts a run absorbed, which render nothing themselves. */
  absorbed: ReadonlySet<number>;
}

/**
 * A part that draws nothing. The accumulator persists a `step-start` around every assistant API
 * response, so real tool calls are rarely adjacent in `parts`; a run reads through the markers.
 * Finished reasoning draws nothing either. Reasoning still streaming is a row: an agent may close a
 * reasoning part only when the turn ends, so one can sit between two tool calls. A tool's image
 * sits right after the call in `parts` and is drawn by that call's card, not where it lies.
 */
const invisible = (part: MessagePart) =>
  part.type === "step-start" ||
  part.type === "data-tool-image" ||
  (part.type === "reasoning" && part.state !== "streaming");

/**
 * Consecutive tool calls in a message, folded into runs. Anything visible between two calls ends a
 * run; invisible markers don't.
 */
export function toolRuns(parts: readonly MessagePart[]): ToolRuns {
  const starts = new Map<number, readonly AnyToolPart[]>();
  const absorbed = new Set<number>();
  let run: AnyToolPart[] = [];
  let indexes: number[] = [];
  const close = () => {
    if (run.length >= MIN_RUN) {
      starts.set(indexes[0]!, run);
      for (const index of indexes.slice(1)) absorbed.add(index);
    }
    run = [];
    indexes = [];
  };
  parts.forEach((part, index) => {
    if (invisible(part)) return;
    if (!groupable(part)) return close();
    run.push(part);
    indexes.push(index);
  });
  close();
  return { starts, absorbed };
}

/**
 * The images a message's tool calls returned, by tool call id and in the order they arrived. One
 * call reporting the same stored file twice shows it once.
 */
export function toolImagesOf(
  parts: readonly MessagePart[],
): ReadonlyMap<string, readonly ToolImageData[]> {
  const byCall = new Map<string, ToolImageData[]>();
  for (const part of parts) {
    if (part.type !== "data-tool-image") continue;
    const images = byCall.get(part.data.toolCallId) ?? [];
    const { path } = part.data;
    if (path !== undefined && images.some((image) => image.path === path)) continue;
    images.push(part.data);
    byCall.set(part.data.toolCallId, images);
  }
  return byCall;
}

/**
 * What to call one of a tool call's images: the file the call read, and otherwise the tool. The
 * stored copy is named by content hash, which tells a reader nothing.
 */
export const toolImageName = (part: AnyToolPart, index: number, count: number): string => {
  const input = (part.input ?? {}) as Record<string, unknown>;
  const path = input["file_path"] ?? input["path"];
  const name =
    typeof path === "string" && basename(path) !== ""
      ? basename(path)
      : `${toolNameOf(part)} image`;
  return count > 1 ? `${name} (${index + 1} of ${count})` : name;
};

/** What stands in for a tool's image that can't be shown, and why. */
export const missingToolImageLabel = (
  image: ToolImageData,
  problem: "unstored" | "gone",
): string => {
  if (problem === "gone") return "Image no longer available";
  return image.size > 5 * 1024 * 1024
    ? `Image too large to preview · ${formatSize(image.size)}`
    : `Image can't be previewed · ${image.mediaType}`;
};

type StepKind = "command" | "read" | "edit" | "search" | "web" | "other";

const KIND_OF: Record<string, StepKind> = {
  Bash: "command",
  Read: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Glob: "search",
  Grep: "search",
  WebFetch: "web",
  WebSearch: "web",
};

// Edits first: what a run changed matters more than what it looked at.
const KIND_ORDER: readonly StepKind[] = ["edit", "command", "read", "search", "web", "other"];

const PHRASE: Record<StepKind, (count: number) => string> = {
  command: (n) => (n === 1 ? "ran 1 command" : `ran ${n} commands`),
  read: (n) => (n === 1 ? "read 1 file" : `read ${n} files`),
  edit: (n) => (n === 1 ? "made 1 edit" : `made ${n} edits`),
  search: (n) => (n === 1 ? "searched once" : `searched ${n} times`),
  web: (n) => (n === 1 ? "made 1 web lookup" : `made ${n} web lookups`),
  other: (n) => (n === 1 ? "used 1 tool" : `used ${n} tools`),
};

/** The files a run's calls changed, in order; a call that doesn't say which adds none. */
export const runEdits = (run: readonly AnyToolPart[]): FileEdit[] => run.flatMap(partEdits);

/** Files named before a run's summary counts them instead. */
const NAMED_FILES = 2;

/** "Edited a.ts, b.ts" or "edited 3 files": one verb when every file had the same change. */
function editPhrase(edits: readonly FileEdit[]): string {
  const names = [...new Set(edits.map((edit) => basename(edit.movedTo ?? edit.path)))];
  const kinds = new Set(edits.map((edit) => edit.kind));
  const verb = (kinds.size === 1 ? FILE_EDIT_VERB[edits[0]!.kind].done : "Edited").toLowerCase();
  return names.length <= NAMED_FILES
    ? `${verb} ${names.join(", ")}`
    : `${verb} ${names.length} files`;
}

/**
 * "Edited retry.ts, ran 2 commands, read 2 files": what a run did, edits first and named by file.
 * An edit call that doesn't say which files it changed is counted instead.
 */
export function runSummary(run: readonly AnyToolPart[]): string {
  const counts = new Map<StepKind, number>();
  const edits: FileEdit[] = [];
  for (const part of run) {
    const kind = KIND_OF[toolNameOf(part)] ?? "other";
    const files = kind === "edit" ? partEdits(part) : [];
    if (files.length > 0) {
      edits.push(...files);
      continue;
    }
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const text = KIND_ORDER.flatMap((kind) => {
    const count = counts.get(kind);
    const phrases = count === undefined ? [] : [PHRASE[kind](count)];
    return kind === "edit" && edits.length > 0 ? [editPhrase(edits), ...phrases] : phrases;
  }).join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** An agent's label with nothing in it that could hide or reorder what the user reads. */
const visibleLabel = (text: string | undefined) => {
  if (text === undefined) return undefined;
  const clean = visibleText(text)
    .replace(/[\u{E0000}-\u{E007F}\u3164\u2800\u115F\u1160\uFFA0]|\p{Variation_Selector}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean === "" ? undefined : clean;
};

export const toolInputField = (input: unknown, key: string): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

/** One tool call in a few words, for the line that names the step in progress. */
export function toolDetail(part: AnyToolPart): string | undefined {
  const { input } = part;
  const field = (key: string) => toolInputField(input, key);
  const path = field("file_path") ?? field("notebook_path") ?? field("filePath") ?? field("path");
  const queries = (input as { queries?: unknown } | undefined)?.queries;
  return (
    // What an agent said its browser input is for ("Opens the Filters menu").
    (toolNameOf(part).includes("browser_") ? visibleLabel(field("actionSummary")) : undefined) ??
    field("description") ??
    field("command") ??
    (path === undefined ? undefined : basename(path)) ??
    field("query") ??
    (toolNameOf(part) === "WebSearch" && Array.isArray(queries)
      ? queries
          .filter((query): query is string => typeof query === "string" && query !== "")
          .join(" · ") || undefined
      : undefined) ??
    field("url") ??
    field("pattern")
  );
}

export function stepLabel(part: AnyToolPart): string {
  const name = part.title ?? toolNameOf(part);
  const detail = toolDetail(part);
  if (detail === undefined) return name;
  // A Bash description already reads as a sentence; everything else needs the tool's name.
  return toolInputField(part.input, "description") === detail
    ? detail
    : `${name} ${detail.split("\n")[0]}`;
}

export interface RunState {
  /** The call still in flight, which the collapsed line names instead of the summary. */
  active: AnyToolPart | undefined;
  failed: number;
  cancelled: number;
  /** A call is waiting on the user, so the run starts open. */
  awaiting: boolean;
}

export function runState(run: readonly AnyToolPart[]): RunState {
  const phases = run.map((part) =>
    toolPhase(
      part.state,
      part.state === "output-error" ? part.errorText : undefined,
      part.state === "output-available" && part.preliminary === true,
    ),
  );
  const activeIndex = phases.findLastIndex((phase) => phase === "running" || phase === "pending");
  return {
    active: activeIndex === -1 ? undefined : run[activeIndex],
    failed: phases.filter((phase) => phase === "error").length,
    cancelled: phases.filter((phase) => phase === "cancelled").length,
    awaiting: phases.includes("awaiting"),
  };
}
