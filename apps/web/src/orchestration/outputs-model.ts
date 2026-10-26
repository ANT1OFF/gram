// The workspace Files view's grouping, labels and how each entry opens. No React here.

import { outputPreviewable, type OutputKind, type WorkspaceOutput } from "@gram/contracts";

import { dateTimeFormat } from "@/lib/intl";
import { formatClockTime } from "@/lib/time";

/** The filter's choices: every kind, or one. */
export type OutputFilter = "all" | OutputKind;
export const OUTPUT_FILTERS: readonly OutputFilter[] = [
  "all",
  "screenshot",
  "recording",
  "image",
  "document",
  "other",
];
/** One word each, as the filter shows them. */
export const OUTPUT_FILTER_LABELS: Record<OutputFilter, string> = {
  all: "All",
  screenshot: "Screenshots",
  recording: "Recordings",
  image: "Images",
  document: "Documents",
  other: "Other",
};

export type OutputGrouping = "day" | "feature";
export const OUTPUT_GROUPINGS: readonly OutputGrouping[] = ["day", "feature"];
export const OUTPUT_GROUPING_LABELS: Record<OutputGrouping, string> = {
  day: "Day",
  feature: "Feature",
};

export interface OutputGroup {
  readonly key: string;
  readonly label: string;
  readonly outputs: readonly WorkspaceOutput[];
}

/** `path`'s last segment. */
export const outputName = (path: string): string => path.split(/[\\/]/).at(-1) ?? path;

/** When it was written, as a 24-hour clock. */
export const outputTime = (output: Pick<WorkspaceOutput, "at">, timeZone?: string): string =>
  formatClockTime(output.at, timeZone === undefined ? {} : { timeZone });

const dayKey = (at: number, timeZone: string | undefined) =>
  dateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(at);

/** The calendar date before `key` (`YYYY-MM-DD`): date arithmetic alone, with no zone or clock. */
const dayBefore = (key: string): string => {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
};

/** `Today`, `Yesterday`, else `Tue 14 Oct`, in the viewer's zone (or `timeZone`, for tests). */
export function dayLabel(at: number, now: number, timeZone?: string): string {
  const day = dayKey(at, timeZone);
  if (day === dayKey(now, timeZone)) return "Today";
  if (day === dayBefore(dayKey(now, timeZone))) return "Yesterday";
  return dateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(at);
}

/** The feature a worker's output belongs to; the orchestrator's own, and a plain thread's, by name. */
export const featureOf = (output: WorkspaceOutput): string =>
  output.feature ?? (output.orchestrator ? "Orchestrator" : output.threadTitle || "Thread");

/**
 * `outputs` (newest first) in groups, in the order their newest entry came: by the day each was
 * written, or by feature. Each group keeps the entries newest first.
 */
export function groupOutputs(
  outputs: readonly WorkspaceOutput[],
  by: OutputGrouping,
  now: number,
  timeZone?: string,
): OutputGroup[] {
  const groups = new Map<string, { label: string; outputs: WorkspaceOutput[] }>();
  for (const output of outputs) {
    const key = by === "day" ? dayKey(output.at, timeZone) : featureOf(output);
    const label = by === "day" ? dayLabel(output.at, now, timeZone) : key;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { label, outputs: [output] });
    else group.outputs.push(output);
  }
  return [...groups].map(([key, group]) => ({ key, ...group }));
}

/**
 * How an entry opens, through the thread's own scoped reads: a picture stored for the thread (a
 * tool's image, a file it sent) through `attachment.read`, a picture in its folders through
 * `fs.image`, and anything else in the thread's Files panel.
 */
export type OutputViewer = "attachment" | "checkout" | "panel";
export const outputViewer = (output: WorkspaceOutput): OutputViewer =>
  !outputPreviewable(output)
    ? "panel"
    : output.source === "toolImage" || output.source === "sent"
      ? "attachment"
      : "checkout";

/** Whether `path` sits inside one of `roots`. */
export const insideRoots = (path: string, roots: readonly string[]): boolean =>
  roots.some((root) => path.startsWith(`${root.replace(/\/+$/, "")}/`));

/**
 * Whether the entry can open at all. A picture opens through its own reader; anything else opens in
 * the thread's Files panel, whose `fs.file` takes a file outside the thread's checkouts only when
 * the thread wrote it. So a document it sent from elsewhere is listed with Reveal, and no Open.
 */
export const outputOpenable = (output: WorkspaceOutput, roots: readonly string[]): boolean =>
  outputViewer(output) !== "panel" ||
  output.source === "written" ||
  insideRoots(output.path, roots);
