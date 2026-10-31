import type {
  BackgroundTaskKind,
  CompactionActivity,
  CompletedReason,
  Thread,
  ThreadStatus,
  ThreadSummary,
} from "@gram/contracts";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  Layers,
  MessageSquareWarning,
  type LucideIcon,
} from "lucide-react";

import { firstLine } from "@/lib/format";
import { Spinner } from "@/motion/spinner";
import { compactingLabel } from "@/thread/compaction-marker";

import type { Attention, AttentionReason } from "./attention";

/** Something running under a thread that isn't its own turn: agent work it left, or a terminal's. */
export interface RunningWork {
  readonly kind: BackgroundTaskKind | "terminal";
  /** What it is, in a line: a subagent's description, the start of a command. */
  readonly label: string;
  /** A subagent's type. */
  readonly detail?: string | undefined;
}

const NONE: readonly RunningWork[] = [];

/** The agent's background tasks, then what runs in the thread's terminals. */
export const runningWork = (
  summary: Pick<ThreadSummary, "background" | "terminalProcesses">,
): readonly RunningWork[] => {
  const tasks = summary.background ?? [];
  const processes = summary.terminalProcesses ?? [];
  if (tasks.length === 0 && processes.length === 0) return NONE;
  return [
    ...tasks.map((task): RunningWork => ({
      kind: task.kind,
      label: firstLine(
        task.kind === "subagent" ? task.description : task.command || task.description,
      ),
      detail: task.subagentType,
    })),
    ...processes.map((p): RunningWork => ({ kind: "terminal", label: firstLine(p.command) })),
  ];
};

const WORK_NOUN: Record<RunningWork["kind"], readonly [string, string]> = {
  subagent: ["a subagent", "subagents"],
  shell: ["a background shell", "background shells"],
  workflow: ["a workflow", "workflows"],
  mcp: ["an MCP task", "MCP tasks"],
  other: ["a background task", "background tasks"],
  terminal: ["a terminal process", "terminal processes"],
};

/** "Running: 2 subagents and a background shell". */
export const runningSummary = (work: readonly RunningWork[]): string => {
  const counts = new Map<RunningWork["kind"], number>();
  for (const item of work) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const parts = [...counts].map(([kind, n]) =>
    n === 1 ? WORK_NOUN[kind][0] : `${n} ${WORK_NOUN[kind][1]}`,
  );
  const list =
    parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `Running: ${list}`;
};

/** Glyph shape + text label per runtime status, so status never relies on colour alone. */
export const STATUS_DISPLAY: Record<
  ThreadStatus,
  { icon: LucideIcon; label: string; tone: string }
> = {
  cold: { icon: CircleDashed, label: "Idle", tone: "text-status-idle" },
  starting: { icon: Spinner, label: "Starting", tone: "text-status-working" },
  idle: { icon: CircleDot, label: "Idle", tone: "text-status-idle" },
  running: { icon: Spinner, label: "Working", tone: "text-status-working" },
  needsApproval: { icon: CircleAlert, label: "Needs approval", tone: "text-status-needs" },
  needsInput: { icon: CircleAlert, label: "Needs input", tone: "text-status-needs" },
  error: { icon: CircleAlert, label: "Error", tone: "text-destructive" },
  ended: { icon: CircleCheck, label: "Ended", tone: "text-muted-foreground" },
};

const COMPLETED_REASON: Record<CompletedReason, string> = {
  agent: "marked done by the agent",
  user: "marked done by you",
  prMerged: "PR merged",
};

/** The PR badge's own marks for a red build and a change request, so the row and the badge agree. */
const ATTENTION_ICON: Record<AttentionReason, LucideIcon> = {
  ciFailed: CircleX,
  changesRequested: MessageSquareWarning,
};

/**
 * The activity line to show: what the thread is doing while it works, or while it's idle, what a
 * subagent still running in the background is doing.
 *
 * `detail` is the live status event's and `activity` the snapshot's. An empty `detail` is an event
 * saying there is no longer anything to show, so it wins over the snapshot: falling back would keep
 * a finished background subagent "working" for any thread first seen mid-task.
 */
export const activityLine = (
  status: ThreadStatus,
  detail: string | undefined,
  activity: string | undefined,
): string | undefined =>
  status === "running" || status === "starting" || status === "idle"
    ? (detail ?? activity) || undefined
    : undefined;

/** Idle, but a background subagent is still working, so rows and headers show the working glyph. */
export const backgroundWorking = (status: ThreadStatus, activity: string | undefined): boolean =>
  status === "idle" && activity !== undefined;

/** Tooltip for a completed thread's row, e.g. "Completed: PR merged". */
const completedTitle = (thread: Thread): string | undefined =>
  thread.completedAt === undefined
    ? undefined
    : thread.completedReason
      ? `Completed: ${COMPLETED_REASON[thread.completedReason]}`
      : "Completed";

/** What a row's status glyph shows, and the words behind it for the tooltip and screen readers. */
export interface RowStatus {
  readonly icon: LucideIcon;
  readonly tone: string;
  readonly label: string;
  readonly title: string;
  readonly working: boolean;
  /** How much runs under the thread, when that is what the glyph shows. */
  readonly running?: number | undefined;
  /** The thread is compacting its context, which `title` says in full. */
  readonly compacting?: true | undefined;
}

/**
 * The glyph's hint: its title, and while it works, what it is doing. A compaction's title says
 * that already, so the activity line would only repeat it.
 */
export const statusHint = (display: RowStatus, activity: string | undefined): string =>
  activity && display.working && display.compacting !== true
    ? `${display.title}: ${activity}`
    : display.title;

/** A stacked glyph's tooltip lists this many items, then how many more there are. */
const TITLE_WORK = 6;

/**
 * A row's glyph is its only status cue, so it has to carry what the text line used to: a background
 * subagent reads as working, and a completed thread at rest gets the check rather than the idle dot
 * it would otherwise share with every other quiet thread, whatever completed it, a merge included.
 * Completion never hides a live status.
 * A thread at rest with work running under it (`runningWork`) takes the stacked glyph instead, so
 * the spinner means its own turn and nothing else. Unseen `attention` takes the glyph of a quiet
 * thread, since it is why the row sits under Needs you; behind a working or stacked glyph the row
 * draws it among its chips instead (`ATTENTION_ICON`). A running thread that is compacting its
 * context says so in place of the generic Working.
 */
export const rowStatus = (
  thread: Thread,
  status: ThreadStatus,
  activity: string | undefined,
  attention?: Attention | undefined,
  work: readonly RunningWork[] = NONE,
  compaction?: CompactionActivity | undefined,
): RowStatus => {
  if (status === "running" && compaction !== undefined) {
    return {
      ...STATUS_DISPLAY.running,
      label: "Compacting",
      title: compactingLabel(compaction),
      working: true,
      compacting: true,
    };
  }
  if (status === "running") {
    const { label } = STATUS_DISPLAY.running;
    return { ...STATUS_DISPLAY.running, title: label, working: true };
  }
  if (work.length > 0 && (status === "idle" || status === "cold" || status === "ended")) {
    const label = runningSummary(work);
    const lines = work
      .slice(0, work.length > TITLE_WORK + 1 ? TITLE_WORK : work.length)
      .map((w) => `• ${w.label}${w.detail === undefined ? "" : ` (${w.detail})`}`);
    if (lines.length < work.length) lines.push(`and ${work.length - lines.length} more`);
    return {
      icon: Layers,
      tone: "text-status-working",
      label,
      title: [label, ...lines].join("\n"),
      working: false,
      running: work.length,
    };
  }
  // An agent that reports no background tasks still says what its subagent does.
  if (backgroundWorking(status, activity)) {
    const { label } = STATUS_DISPLAY.running;
    return { ...STATUS_DISPLAY.running, title: label, working: true };
  }
  if (attention !== undefined) {
    const { label, reason } = attention;
    return {
      icon: ATTENTION_ICON[reason],
      tone: "text-destructive",
      label,
      title: label,
      working: false,
    };
  }
  const resting = status === "idle" || status === "cold" || status === "ended";
  // A merge completes a thread like anything else: its headline says "Done · #198 merged", and a
  // merge glyph of its own said "merged" on threads that had gone on working after it.
  if (resting && thread.completedAt !== undefined) {
    const label = "Completed";
    return {
      icon: CircleCheck,
      tone: "text-success",
      label,
      title: completedTitle(thread) ?? label,
      working: false,
    };
  }
  const display = STATUS_DISPLAY[status];
  return { ...display, title: display.label, working: false };
};

/** How long a resting row stays as it is before it fades. */
export const SETTLED_AFTER_MS = 86_400_000;

/** Whether a row has rested for a day: nothing runs under it and nothing waits on the user. */
export const settledRow = (
  status: ThreadStatus,
  display: Pick<RowStatus, "working" | "running">,
  lastActivityAt: number,
  now: number,
): boolean =>
  (status === "idle" || status === "cold" || status === "ended") &&
  !display.working &&
  display.running === undefined &&
  now - lastActivityAt >= SETTLED_AFTER_MS;

/**
 * A thread's status as every row, header and list draws it: `rowStatus` over its summary, so work
 * running under it, a compaction and its completion show wherever it does. `detail` is its live
 * activity line where the caller reads it; without it the snapshot's stands.
 */
export const threadStatusOf = (
  summary: Pick<
    ThreadSummary,
    "thread" | "status" | "activity" | "background" | "terminalProcesses" | "compaction"
  >,
  detail?: string | undefined,
  attention?: Attention | undefined,
): RowStatus =>
  rowStatus(
    summary.thread,
    summary.status,
    activityLine(summary.status, detail, summary.activity),
    attention,
    runningWork(summary),
    summary.compaction,
  );
