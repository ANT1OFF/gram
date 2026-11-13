import type { GramUIMessage } from "@gram/contracts";

import { isToolPart, toolNameOf, toolPhase, type AnyToolPart, type ToolPhase } from "./parts";
import { formatElapsed } from "./subagent-strip-model";
import { toolDetail, toolInputField } from "./tool-group-model";
import { toolLabel } from "./tool-labels";

// A turn's run timeline: each tool call it made, in order, as a bar on one time axis from the
// turn's start to its end, from the `toolTimes` the server stamps on each message. Calls that ran
// side by side overlap; the gaps are the model thinking and writing. No React.

export type StepTone = "done" | "running" | "failed" | "stopped";

export interface TimelineStep {
  readonly toolCallId: string;
  /** "Ran pnpm test", "Read retry.ts". */
  readonly label: string;
  readonly tone: StepTone;
  /** Epoch ms; absent for a call with no recorded time (older, or its output came late). */
  readonly startedAt: number | undefined;
  readonly endedAt: number | undefined;
  /** Where its bar starts and how wide it is, in percent of the axis; absent without a time. */
  readonly left?: number;
  readonly width?: number;
  /** "6s", "1m 02s"; "<1s" under a second. */
  readonly took: string | undefined;
}

export interface TurnTimeline {
  /** Epoch ms of the axis's ends. */
  readonly start: number;
  readonly end: number;
  readonly steps: readonly TimelineStep[];
  /** The share of the turn some tool was running, in whole percent; the rest is the model. */
  readonly toolShare: number;
  /** Labels along the axis: its start, middle and end. */
  readonly ticks: readonly { readonly at: number; readonly label: string }[];
}

export const TONE: Readonly<Record<ToolPhase, StepTone>> = {
  pending: "running",
  running: "running",
  awaiting: "running",
  done: "done",
  error: "failed",
  denied: "stopped",
  cancelled: "stopped",
};

export const phaseOf = (part: AnyToolPart): ToolPhase =>
  toolPhase(
    part.state,
    part.state === "output-error" ? part.errorText : undefined,
    part.state === "output-available" && part.preliminary === true,
  );

/** What a call did, in its settled words: "Ran tests", "Read retry.ts". */
export const labelOf = (part: AnyToolPart, phase: ToolPhase): string => {
  const name = toolLabel(toolNameOf(part), phase, part.title).label;
  const detail = toolDetail(part);
  if (detail === undefined) return name;
  return toolInputField(part.input, "description") === detail ||
    toolInputField(part.input, "actionSummary") === detail
    ? detail
    : `${name} ${detail.split("\n")[0]}`;
};

/** "<1s" under a second, else as the turn row counts. */
export const tookLabel = (ms: number): string => (ms < 1_000 ? "<1s" : formatElapsed(ms));

/** Merged length of `spans`, so calls that overlap count once. */
export const covered = (spans: readonly (readonly [number, number])[]): number => {
  const sorted = spans.toSorted((a, b) => a[0] - b[0]);
  let total = 0;
  let from = -Infinity;
  let to = -Infinity;
  for (const [start, end] of sorted) {
    if (start > to) {
      if (to > from) total += to - from;
      from = start;
      to = end;
    } else if (end > to) to = end;
  }
  if (to > from) total += to - from;
  return total;
};

/**
 * The timeline of a turn's top-level `replies`, from `startedAt` (its prompt) to `endedAt` (absent
 * while it runs, when `now` is its end), stretched to cover every call. `undefined` when the turn
 * made no tool calls, or none has a time.
 */
export function turnTimeline(
  replies: readonly GramUIMessage[],
  startedAt: number | undefined,
  endedAt: number | undefined,
  now: number,
): TurnTimeline | undefined {
  const raw = replies.flatMap((reply) =>
    reply.parts.filter(isToolPart).map((part) => {
      const phase = phaseOf(part);
      const time = reply.metadata?.toolTimes?.[part.toolCallId];
      const tone = TONE[phase];
      const end =
        time === undefined ? undefined : (time.endedAt ?? (tone === "running" ? now : undefined));
      return { part, phase, tone, start: time?.startedAt, end };
    }),
  );
  const timed = raw.filter((step) => step.start !== undefined);
  if (timed.length === 0) return undefined;
  const first = Math.min(...timed.map((step) => step.start!));
  const last = Math.max(...timed.map((step) => step.end ?? step.start!));
  const start = Math.min(startedAt ?? first, first);
  const end = Math.max(endedAt ?? now, last, start + 1);
  const span = end - start;
  const steps: TimelineStep[] = raw.map(({ part, phase, tone, start: from, end: to }) => {
    const base = {
      toolCallId: part.toolCallId,
      label: labelOf(part, phase),
      tone,
      startedAt: from,
      endedAt: to,
    };
    if (from === undefined) return { ...base, took: undefined };
    const stop = to ?? from;
    return {
      ...base,
      left: ((from - start) / span) * 100,
      width: ((stop - from) / span) * 100,
      took: to === undefined ? undefined : tookLabel(to - from),
    };
  });
  const spans = timed.map((step) => [step.start!, step.end ?? step.start!] as const);
  return {
    start,
    end,
    steps,
    toolShare: Math.round((covered(spans) / span) * 100),
    ticks: [0, 0.5, 1].map((at) => ({
      at: at * 100,
      label: tookLabel(at * span),
    })),
  };
}

/**
 * The top-level replies of the turn `turn` (its id, or its prompt's or first reply's message id when
 * it has none), as `turnFolds` groups them.
 */
export function turnReplies(
  messages: readonly GramUIMessage[],
  turn: string,
): { replies: GramUIMessage[]; startedAt: number | undefined } {
  const replies: GramUIMessage[] = [];
  let startedAt: number | undefined;
  let current: string | undefined;
  let currentReplies: GramUIMessage[] = [];
  for (const message of messages) {
    if (message.metadata?.parentToolUseId !== undefined) continue;
    if (message.role === "user") {
      current = message.metadata?.turnId ?? message.id;
      currentReplies = [];
      if (current === turn) startedAt ??= message.metadata?.createdAt;
      continue;
    }
    if (message.role !== "assistant") continue;
    const ended = currentReplies.at(-1)?.metadata?.turnEnd;
    if (ended || message.metadata?.initiator === "agent") {
      current = message.id;
      currentReplies = [];
    }
    const id = message.metadata?.turnId ?? current;
    currentReplies.push(message);
    if (id === turn) replies.push(message);
  }
  return { replies, startedAt: startedAt ?? replies[0]?.metadata?.createdAt };
}
