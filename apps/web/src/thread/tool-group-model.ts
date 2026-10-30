import {
  FILE_EDIT_VERB,
  visibleText,
  type FileEdit,
  type GramUIMessage,
  type ToolImageData,
} from "@gram/contracts";

import { formatSize } from "@/panels/files/format";

import {
  isToolPart,
  partEdits,
  toolNameOf,
  toolPhase,
  basename,
  type AnyToolPart,
  type MessagePart,
  type ToolPhase,
} from "./parts";
import { formatElapsed } from "./subagent-strip-model";

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
 * run; invisible markers don't. So do the parts in `apart`, which a closed turn fold holds out of
 * any run.
 */
export function toolRuns(parts: readonly MessagePart[], apart?: ReadonlySet<number>): ToolRuns {
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
    if (apart?.has(index)) return close();
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

export type TurnFoldState = "running" | "worked" | "failed" | "stopped";

/** What a turn's fold row says. */
export interface TurnSummary {
  state: TurnFoldState;
  /** Epoch ms; absent when the turn's prompt doesn't say. */
  startedAt: number | undefined;
  /** Epoch ms; absent while it runs and on a turn older than `MessageMetadata.turnEnd`. */
  endedAt: number | undefined;
  tools: number;
  failed: number;
}

/** What a turn's fold does to one of its replies. */
export interface MessageFold {
  /** The turn's id, or for a prompt that has none its message's. */
  turn: string;
  /** The parts a closed fold doesn't draw. */
  hidden: ReadonlySet<number>;
  /** The parts a closed fold keeps out of tool runs: `hidden`, and what stays out as its own card. */
  apart: ReadonlySet<number>;
  /** Offered tasks, drawn under the reply rather than where the agent offered them. */
  under: ReadonlySet<number>;
  /** A closed fold leaves nothing of this reply, not even its actions. */
  empty: boolean;
  /** On a turn's first reply, when there is anything to fold: its row. */
  row: TurnSummary | undefined;
}

const NO_PARTS: ReadonlySet<number> = new Set();
const NOTHING_WORKING: ReadonlySet<string> = new Set();

const phaseOf = (part: AnyToolPart) =>
  toolPhase(
    part.state,
    part.state === "output-error" ? part.errorText : undefined,
    part.state === "output-available" && part.preliminary === true,
  );

/** A tool call the fold can take: one that's over and neither failed nor needs the user. */
const SETTLED: ReadonlySet<ToolPhase> = new Set(["done", "cancelled", "denied"]);

/** Narration and how the turn got there. Anything else, an error card say, stays out of the fold. */
const foldable = (part: MessagePart) =>
  part.type === "text" ||
  part.type === "reasoning" ||
  part.type === "data-chapter" ||
  (isToolPart(part) && SETTLED.has(phaseOf(part)));

/** Parts that draw nothing wherever they are, so a reply of only these is empty. */
const SILENT: ReadonlySet<MessagePart["type"]> = new Set([
  "step-start",
  "data-tool-image",
  "data-subagent-usage",
]);

const said = (part: MessagePart) => part.type === "text" && part.text.trim() !== "";

/** Where the reply's last words start: the last text, and any text right before it. */
function lastWordsStart(parts: readonly MessagePart[]): number {
  let start = parts.findLastIndex(said);
  for (let i = start - 1; i >= 0; i--) {
    const part = parts[i]!;
    if (said(part)) start = i;
    else if (part.type !== "text" && !invisible(part)) break;
  }
  return start;
}

/** The lines a set of hidden parts takes up: a run of tool calls is one, and silent parts none. */
function linesHidden(reply: GramUIMessage, hidden: ReadonlySet<number>): number {
  const drawn = (i: number) => !invisible(reply.parts[i]!);
  const shown = new Set([...reply.parts.keys()].filter((i) => !hidden.has(i) && drawn(i)));
  const { absorbed } = toolRuns(reply.parts, shown);
  return [...hidden].filter((i) => drawn(i) && !absorbed.has(i)).length;
}

/** A fold replaces its lines with one row of its own, so it has to take two to save any. */
const MIN_FOLD = 2;

const stateOf = (replies: readonly GramUIMessage[]): TurnFoldState => {
  switch (replies.findLast((reply) => reply.metadata?.turnEnd)?.metadata?.turnEnd?.reason) {
    case "error":
      return "failed";
    case "interrupted":
    case "maxTurns":
      return "stopped";
    case "completed":
      return "worked";
    default:
      return replies.some((reply) => reply.parts.some((p) => p.type === "data-agent-error"))
        ? "failed"
        : "worked";
  }
};

function foldTurn(
  turn: string,
  replies: readonly GramUIMessage[],
  startedAt: number | undefined,
  live: boolean,
  working: ReadonlySet<string>,
  folds: Map<string, MessageFold>,
) {
  const ended = replies.findLast((reply) => reply.metadata?.turnEnd)?.metadata?.turnEnd;
  const running = live && ended === undefined;
  const lastSaid = replies.findLastIndex((reply) => reply.parts.some(said));
  const wordsStart = lastSaid === -1 ? -1 : lastWordsStart(replies[lastSaid]!.parts);
  const wordsEnd = lastSaid === -1 ? -1 : replies[lastSaid]!.parts.findLastIndex(said);
  /** Whether a part stays open: the last words, and while the turn runs whatever follows them. */
  const current = (reply: number, part: number) => {
    if (running)
      return lastSaid === -1 || reply > lastSaid || (reply === lastSaid && part >= wordsStart);
    return reply === lastSaid && part >= wordsStart && part <= wordsEnd;
  };

  let tools = 0;
  let failed = 0;
  const shapes = replies.map((reply, r) => {
    const hidden = new Set<number>();
    const apart = new Set<number>();
    const under = new Set<number>();
    let kept = false;
    reply.parts.forEach((part, i) => {
      if (isToolPart(part)) {
        tools++;
        const phase = phaseOf(part);
        if (phase === "error") failed++;
        if (phase === "error" || phase === "awaiting") apart.add(i);
      }
      if (part.type === "data-task-chip") under.add(i);
      const held = isToolPart(part) && working.has(part.toolCallId);
      if (foldable(part) && !held && !current(r, i)) {
        hidden.add(i);
        apart.add(i);
      } else if (!SILENT.has(part.type)) {
        kept = true;
      }
    });
    return { reply, hidden, apart, under, kept };
  });
  const lines = shapes.reduce((sum, { reply, hidden }) => sum + linesHidden(reply, hidden), 0);
  if (lines < MIN_FOLD) {
    for (const { reply, under } of shapes) {
      if (under.size === 0) continue;
      const nothing = { hidden: NO_PARTS, apart: NO_PARTS, empty: false, row: undefined };
      folds.set(reply.id, { turn, under, ...nothing });
    }
    return;
  }
  const state = running ? "running" : stateOf(replies);
  const summary = { state, startedAt, endedAt: ended?.at, tools, failed };
  shapes.forEach(({ reply, hidden, apart, under, kept }, r) => {
    const row = r === 0 ? summary : undefined;
    if (hidden.size === 0 && under.size === 0 && row === undefined) return;
    const empty = !kept && row === undefined && r < replies.length - 1;
    folds.set(reply.id, { turn, hidden, apart, under, empty, row });
  });
}

/**
 * How each finished turn folds to one row, keyed by reply: everything between the prompt and the
 * reply's last words, leaving out what must stay in view (`foldable`). `inProgress` says the
 * thread's latest turn is still going, when only what's finished folds: the step under way stays.
 * `working` names tool calls that returned but go on, a subagent running in the background say.
 */
export function turnFolds(
  messages: readonly GramUIMessage[],
  inProgress: boolean,
  working: ReadonlySet<string> = NOTHING_WORKING,
): ReadonlyMap<string, MessageFold> {
  const turns = new Map<string, { replies: GramUIMessage[]; startedAt: number | undefined }>();
  let current: string | undefined;
  const turnOf = (id: string) => {
    let turn = turns.get(id);
    if (turn === undefined) {
      turn = { replies: [], startedAt: undefined };
      turns.set(id, turn);
    }
    return turn;
  };
  for (const message of messages) {
    if (message.metadata?.parentToolUseId !== undefined) continue;
    if (message.role === "user") {
      current = message.metadata?.turnId ?? message.id;
      turnOf(current).startedAt ??= message.metadata?.createdAt;
      continue;
    }
    if (message.role !== "assistant") continue;
    // A reply after its turn ended, or that the agent started on its own, opens a turn of its own.
    const ended = current !== undefined && turns.get(current)?.replies.at(-1)?.metadata?.turnEnd;
    if (ended || message.metadata?.initiator === "agent") current = message.id;
    const id = message.metadata?.turnId ?? current;
    if (id === undefined) continue;
    turnOf(id).replies.push(message);
  }
  const latest = [...turns.keys()].at(-1);
  const folds = new Map<string, MessageFold>();
  for (const [id, { replies, startedAt }] of turns) {
    if (replies.length === 0) continue;
    const start = startedAt ?? replies[0]!.metadata?.createdAt;
    foldTurn(id, replies, start, inProgress && id === latest, working, folds);
  }
  return folds;
}

const sameParts = (a: ReadonlySet<number>, b: ReadonlySet<number>) =>
  a.size === b.size && [...a].every((index) => b.has(index));

const sameRow = (a: TurnSummary | undefined, b: TurnSummary | undefined) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.state === b.state &&
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt &&
    a.tools === b.tools &&
    a.failed === b.failed);

const sameFold = (a: MessageFold, b: MessageFold) =>
  a.turn === b.turn &&
  a.empty === b.empty &&
  sameRow(a.row, b.row) &&
  sameParts(a.hidden, b.hidden) &&
  sameParts(a.apart, b.apart) &&
  sameParts(a.under, b.under);

/**
 * `next` with each fold that hasn't changed kept from `previous`: rebuilt on every streamed frame,
 * but a row's memo only sees a new fold when there is something new to draw.
 */
export function reuseFolds(
  previous: ReadonlyMap<string, MessageFold>,
  next: ReadonlyMap<string, MessageFold>,
): ReadonlyMap<string, MessageFold> {
  return new Map(
    [...next].map(([id, fold]) => {
      const kept = previous.get(id);
      return [id, kept !== undefined && sameFold(kept, fold) ? kept : fold];
    }),
  );
}

const FOLD_VERB: Record<TurnFoldState, readonly [word: string, joined: string]> = {
  running: ["Working", "Working for"],
  worked: ["Worked", "Worked for"],
  failed: ["Failed", "Failed after"],
  stopped: ["Stopped", "Stopped after"],
};

/** `Worked for 3m 05s · 5 tools`; a turn without an end time says `Worked · 5 tools`. */
export function turnFoldLabel(turn: TurnSummary, now: number): string {
  const end = turn.state === "running" ? now : turn.endedAt;
  const [word, joined] = FOLD_VERB[turn.state];
  const lead =
    turn.startedAt === undefined || end === undefined
      ? word
      : `${joined} ${formatElapsed(end - turn.startedAt)}`;
  if (turn.tools === 0) return lead;
  return `${lead} · ${turn.tools === 1 ? "1 tool" : `${turn.tools} tools`}`;
}
