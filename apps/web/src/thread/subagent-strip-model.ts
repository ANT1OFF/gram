import type {
  BackgroundTask,
  BackgroundTaskKind,
  SubagentUsageData,
  GramUIMessage,
} from "@gram/contracts";

import { firstLine } from "@/lib/format";

import type { ToolPartOf } from "./parts";

type TaskPart = ToolPartOf<"Task"> | ToolPartOf<"Agent">;

/** One subagent the strip above the composer lists while it works. */
export interface RunningSubagent {
  toolCallId: string;
  /** The transcript row holding its card, or the card of the subagent that spawned it. */
  index: number;
  /** The cards its own card is nested in, outermost first; empty for a top-level run. */
  ancestors: readonly string[];
  /** What the caller said it is for, else its type. */
  label: string;
  subagentType: string | undefined;
  startedAt: number | undefined;
  /** Its one-line status or the tool it last ran, while the agent reports one. */
  note: string | undefined;
}

/** More than this many fold into one "N running" row. */
export const STRIP_ROWS = 3;

const NONE: readonly RunningSubagent[] = [];

const isTaskPart = (part: GramUIMessage["parts"][number]): part is TaskPart =>
  part.type === "tool-Task" || part.type === "tool-Agent";

/**
 * Whether the run behind `part` can still be working: a foreground one while the message holding
 * its card streams, a background one while its own transcript does (the adapter opens it at
 * launch). A snapshot left at `running` by an interrupted turn or a closed session belongs to a
 * message that has finished, so it stays down when a later turn starts.
 */
const live = (
  part: TaskPart,
  message: GramUIMessage,
  lane: readonly GramUIMessage[] | undefined,
  streamingIds: ReadonlySet<string>,
): boolean => {
  switch (part.state) {
    case "input-streaming":
    case "input-available":
    case "approval-requested":
    case "approval-responded":
      return streamingIds.has(message.id);
    case "output-available": {
      const output = part.output as unknown;
      const background =
        typeof output === "object" &&
        output !== null &&
        (output as { status?: unknown }).status === "async_launched";
      return background && (lane ?? []).some((m) => streamingIds.has(m.id));
    }
    default:
      return false;
  }
};

/**
 * The subagents working right now, the most recently started first. Only runs the agent reports
 * through a `running` snapshot are listed, each against the card that spawned it; a subagent's own
 * subagent is found through the card nesting it.
 */
export function runningSubagents({
  top,
  children,
  usage,
  streamingIds,
}: {
  top: readonly GramUIMessage[];
  children: ReadonlyMap<string, readonly GramUIMessage[]>;
  usage: ReadonlyMap<string, SubagentUsageData>;
  /** What `activeStreamingIds` returns: nothing but background lanes once the turn is over. */
  streamingIds: ReadonlySet<string>;
}): readonly RunningSubagent[] {
  const candidates = [...usage.values()].filter((u) => u.status === "running");
  if (candidates.length === 0) return NONE;

  const cards = new Map<string, { part: TaskPart; message: GramUIMessage }>();
  const collect = (message: GramUIMessage) => {
    for (const part of message.parts) {
      if (isTaskPart(part)) cards.set(part.toolCallId, { part, message });
    }
  };
  const rowOf = new Map<string, number>();
  top.forEach((message, index) => {
    rowOf.set(message.id, index);
    collect(message);
  });
  for (const lane of children.values()) lane.forEach(collect);

  const placeOf = (message: GramUIMessage): { index: number; ancestors: string[] } | undefined => {
    const ancestors: string[] = [];
    let current: GramUIMessage | undefined = message;
    for (let depth = 0; current !== undefined && depth < 16; depth++) {
      const parent: string | undefined = current.metadata?.parentToolUseId;
      if (parent === undefined) {
        const index = rowOf.get(current.id);
        return index === undefined ? undefined : { index, ancestors };
      }
      ancestors.unshift(parent);
      current = cards.get(parent)?.message;
    }
    return undefined;
  };

  const running: RunningSubagent[] = [];
  for (const u of candidates) {
    const card = cards.get(u.toolCallId);
    if (card === undefined) continue;
    if (!live(card.part, card.message, children.get(u.toolCallId), streamingIds)) continue;
    const place = placeOf(card.message);
    if (place === undefined) continue;
    const subagentType = u.subagentType ?? card.part.input?.subagent_type;
    running.push({
      toolCallId: u.toolCallId,
      ...place,
      label: card.part.input?.description || subagentType || "Subagent",
      subagentType,
      startedAt: u.startedAt,
      note: u.summary ?? u.lastToolName,
    });
  }
  return running.toSorted(
    (a, b) =>
      (b.startedAt ?? Number.NEGATIVE_INFINITY) - (a.startedAt ?? Number.NEGATIVE_INFINITY) ||
      b.index - a.index,
  );
}

/** One line of the strip: a subagent at work, or another task the agent left running. */
export interface StripRow {
  /**
   * A subagent's tool call id whichever of its card and its task is listed first, and any other
   * task's id, so a line stays one line as what is known of it grows. Swapped keys left the leaving
   * line behind, frozen, in the strip.
   */
  key: string;
  kind: BackgroundTaskKind;
  /** A subagent's description, or the first line of a task's command. */
  label: string;
  /** The whole command, where the label is one: the line shows only its start, and Copy takes it. */
  command: string | undefined;
  /** A subagent's type, where it isn't the label. */
  chip: string | undefined;
  /** Its one-line status, or for a command what the agent said it's for. */
  note: string | undefined;
  startedAt: number | undefined;
  /** The card a click jumps to, as ⌥⌘J does; subagents with a card only. */
  jump: RunningSubagent | undefined;
  /** What Stop stops; absent where the agent can't stop it. */
  taskId: string | undefined;
}

/**
 * Every line of the strip, the most recently started first: the subagents the transcript shows at
 * work, each with its background task when it has one (which Stop takes), then the background tasks
 * no card stands for, shells and the like, by their command. A foreground subagent has no task, so
 * no Stop: the turn's own Stop covers it.
 */
export function stripRows(
  subagents: readonly RunningSubagent[],
  background: readonly BackgroundTask[],
  canStop: boolean,
): readonly StripRow[] {
  if (subagents.length === 0 && background.length === 0) return NO_ROWS;
  const byCall = new Map(
    background.flatMap((task) => (task.toolCallId === undefined ? [] : [[task.toolCallId, task]])),
  );
  const shown = new Set<string>();
  const rows: StripRow[] = subagents.map((run) => {
    const task = byCall.get(run.toolCallId);
    if (task !== undefined) shown.add(task.taskId);
    return {
      key: run.toolCallId,
      kind: "subagent",
      label: run.label,
      command: undefined,
      chip: run.subagentType === run.label ? undefined : run.subagentType,
      note: run.note,
      startedAt: run.startedAt ?? task?.startedAt,
      jump: run,
      taskId: canStop ? task?.taskId : undefined,
    };
  });
  for (const task of background) {
    if (shown.has(task.taskId)) continue;
    // As the agent ran it, for Copy; only the label and tooltip are cut down.
    const command = task.command?.trim() ? task.command : undefined;
    const label = firstLine(command ?? task.description, LABEL_CHARS);
    // Claude Code falls back to the command for a shell with no description of its own.
    const note = command === undefined ? undefined : firstLine(task.description, LABEL_CHARS);
    rows.push({
      // Only a subagent's task shares its line with a card; a shell is told its tool call later, and
      // a key that moved with that would swap its line out.
      key: (task.kind === "subagent" ? task.toolCallId : undefined) ?? task.taskId,
      kind: task.kind,
      label,
      command,
      chip: task.subagentType,
      note: note === label ? undefined : note,
      startedAt: task.startedAt,
      jump: undefined,
      taskId: canStop ? task.taskId : undefined,
    });
  }
  return rows.toSorted(
    (a, b) => (b.startedAt ?? Number.NEGATIVE_INFINITY) - (a.startedAt ?? Number.NEGATIVE_INFINITY),
  );
}

const NO_ROWS: readonly StripRow[] = [];

/** Longer than any line the strip has room for; CSS truncates the rest to fit. */
const LABEL_CHARS = 200;

/** What a line's tooltip holds: what the work is for, then where it is a command, how it starts. */
export interface RowHint {
  title: string | undefined;
  command: string | undefined;
}

/**
 * A line's tooltip: two short lines at most, never the whole command. A heredoc can hold a whole
 * file, which as a tooltip stood taller than the window.
 */
export const rowHint = (row: StripRow): RowHint => ({
  title: row.command === undefined ? firstLine(row.label) : row.note && firstLine(row.note),
  command: row.command === undefined ? undefined : firstLine(row.command),
});

/** The folded line's tooltip names this many lines, then how many more there are. */
export const HINT_ROWS = 6;

/** Where ⌥⌘J goes: the most recent run, then each older one in turn, and round again. */
export function nextJump(
  running: readonly RunningSubagent[],
  last: string | undefined,
): RunningSubagent | undefined {
  const at = running.findIndex((r) => r.toolCallId === last);
  return running[at === -1 ? 0 : (at + 1) % running.length];
}

/** `8s`, `4m 05s`, `1h 02m`: a running clock, never negative. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
