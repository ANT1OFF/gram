import type { GramUIMessage, SubagentUsage } from "@gram/contracts";

import { isToolPart, toolNameOf, type AnyToolPart, type ToolPhase } from "./parts";
import { toolInputField } from "./tool-group-model";
import { TONE, covered, labelOf, phaseOf, tookLabel, type StepTone } from "./turn-timeline-model";

// A turn's trace: everything one send caused, as a tree of steps on one time axis. A tool call is
// a step from the `toolTimes` the server stamps; a subagent's own calls nest under the call that
// started it; the time no call was running is the model thinking and writing, which no clock
// times call by call, so it is drawn as the gaps. No React.

export type TraceKind = "model" | "tool" | "worker" | "wait";

export interface TraceStep {
  /** The tool call's id; `model:<lane>:<n>` for the model's time. */
  readonly id: string;
  readonly kind: TraceKind;
  /** 0 for the turn's own steps, 1 for a subagent's, and so on. */
  readonly depth: number;
  /** "Ran pnpm test", "Read retry.ts", "Model". */
  readonly label: string;
  /** A few quiet words after the label: the model's id, a subagent's type. */
  readonly note?: string;
  readonly tone: StepTone;
  /** Epoch ms; absent for a call with no recorded time. */
  readonly startedAt: number | undefined;
  readonly endedAt: number | undefined;
  /** Where its bar starts and how wide it is, in percent of the axis; absent without a time. */
  readonly left?: number;
  readonly width?: number;
  /** "6s", "1m 02s", "<1s"; absent while it runs or without a time. */
  readonly took: string | undefined;
  /** The message the step is part of, which the conversation shows. */
  readonly messageId: string | undefined;
  /** The call itself, for its input and output. Absent on the model's time. */
  readonly part?: AnyToolPart;
  /** The model that was at work, on the model's time. */
  readonly model?: string;
  /** A subagent's totals, on a worker. */
  readonly usage?: SubagentUsage;
  /** The calls a worker made, on a worker. */
  readonly calls?: number;
}

export interface TraceTotals {
  /** From the turn's start to its end, or to now while it runs. */
  readonly wallMs: number;
  /** The turn's own time in tool calls and workers; calls side by side count once. */
  readonly toolMs: number;
  /** The time a call has waited on the person's approval. */
  readonly waitMs: number;
  /** The rest: the model thinking and writing. */
  readonly modelMs: number;
}

export interface Trace {
  readonly start: number;
  readonly end: number;
  readonly steps: readonly TraceStep[];
  readonly totals: TraceTotals;
  /** Calls that failed, the turn's own and its workers'. */
  readonly failed: number;
  /** Calls with no recorded time, drawn without a bar. */
  readonly untimed: number;
  /** Labels along the axis, in percent of it. */
  readonly ticks: readonly { readonly at: number; readonly label: string }[];
}

/** The model's time shorter than this between two calls is not a step: it is the hand-over. */
export const MODEL_STEP_MIN_MS = 300;

const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

interface RawStep extends Omit<TraceStep, "left" | "width" | "took"> {}

const KIND: Readonly<Record<ToolPhase, TraceKind>> = {
  pending: "tool",
  running: "tool",
  awaiting: "wait",
  done: "tool",
  error: "tool",
  denied: "tool",
  cancelled: "tool",
};

/**
 * The steps of one lane (the turn's own replies, or one subagent's transcript) from `from` to
 * `to`, each worker followed by its own lane. `to` is absent while the lane runs.
 */
function laneSteps(
  lane: string,
  messages: readonly GramUIMessage[],
  children: ReadonlyMap<string, readonly GramUIMessage[]>,
  usage: ReadonlyMap<string, SubagentUsage>,
  depth: number,
  from: number | undefined,
  to: number | undefined,
  running: boolean,
  now: number,
): RawStep[] {
  const steps: RawStep[] = [];
  let cursor = from;
  let models = 0;
  let model: string | undefined;
  let lastMessage: string | undefined;
  const modelStep = (start: number, end: number | undefined, messageId: string | undefined) => {
    models += 1;
    steps.push({
      id: `model:${lane}:${models}`,
      kind: "model",
      depth,
      label: "Model",
      ...(model === undefined ? {} : { note: model, model }),
      tone: end === undefined ? "running" : "done",
      startedAt: start,
      endedAt: end,
      messageId,
    });
  };
  for (const message of messages) {
    model = message.metadata?.model ?? model;
    lastMessage = message.id;
    for (const part of message.parts) {
      if (!isToolPart(part)) continue;
      const phase = phaseOf(part);
      const tone = TONE[phase];
      const time = message.metadata?.toolTimes?.[part.toolCallId];
      const start = time?.startedAt;
      const end = time === undefined ? undefined : time.endedAt;
      if (start !== undefined) {
        if (cursor !== undefined && start - cursor >= MODEL_STEP_MIN_MS) {
          modelStep(cursor, start, message.id);
        }
        cursor = Math.max(cursor ?? start, end ?? (tone === "running" ? now : start));
      }
      const nested = children.get(part.toolCallId);
      const totals = usage.get(part.toolCallId);
      const worker =
        nested !== undefined || totals !== undefined || SUBAGENT_TOOLS.has(toolNameOf(part));
      const type = totals?.subagentType ?? toolInputField(part.input, "subagent_type");
      const inner =
        nested === undefined
          ? []
          : laneSteps(
              part.toolCallId,
              nested,
              children,
              usage,
              depth + 1,
              start,
              end,
              tone === "running",
              now,
            );
      steps.push({
        id: part.toolCallId,
        kind: worker ? "worker" : KIND[phase],
        depth,
        label: labelOf(part, phase),
        ...(worker && type !== undefined ? { note: type } : {}),
        tone,
        startedAt: start,
        endedAt: end,
        messageId: message.id,
        part,
        ...(totals === undefined ? {} : { usage: totals }),
        ...(worker ? { calls: inner.filter((step) => step.kind !== "model").length } : {}),
      });
      steps.push(...inner);
    }
  }
  // What follows the last call: the model writing its reply, or still at work.
  if (cursor !== undefined) {
    const end = running ? undefined : to;
    if ((end ?? now) - cursor >= MODEL_STEP_MIN_MS) modelStep(cursor, end, lastMessage);
  }
  return steps;
}

const TICK_STEPS_MS = [
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000,
  1_800_000, 3_600_000,
];

/** "0:15", "2:00", "1:02:00": a place on the axis, from the turn's start. */
export const offsetLabel = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
};

/** Round ticks, at most six, the first at the start. */
const ticksOf = (span: number) => {
  const step =
    TICK_STEPS_MS.find((size) => span / size <= 6) ?? Math.ceil(span / 6 / 3_600_000) * 3_600_000;
  const ticks: { at: number; label: string }[] = [];
  for (let at = 0; at < span; at += step) {
    ticks.push({ at: (at / span) * 100, label: offsetLabel(at) });
  }
  return ticks;
};

/**
 * The trace of a turn's top-level `replies`, from `startedAt` (its prompt) to `endedAt` (absent
 * while it runs, when `now` is its end). `children` and `usage` are the thread's subagent
 * transcripts and totals, by the call that started each. `undefined` when the turn made no tool
 * call, or none has a time.
 */
export function turnTrace(
  replies: readonly GramUIMessage[],
  children: ReadonlyMap<string, readonly GramUIMessage[]>,
  usage: ReadonlyMap<string, SubagentUsage>,
  startedAt: number | undefined,
  endedAt: number | undefined,
  now: number,
): Trace | undefined {
  const running = endedAt === undefined;
  const probe = laneSteps("turn", replies, children, usage, 0, undefined, undefined, false, now);
  const timed = probe.filter((step) => step.kind !== "model" && step.startedAt !== undefined);
  if (timed.length === 0) return undefined;
  const first = Math.min(...timed.map((step) => step.startedAt!));
  const last = Math.max(...timed.map((step) => step.endedAt ?? step.startedAt!));
  const start = Math.min(startedAt ?? first, first);
  const end = Math.max(endedAt ?? now, last, start + 1);
  const span = end - start;
  const raw = laneSteps("turn", replies, children, usage, 0, start, end, running, now);
  const steps: TraceStep[] = raw.map((step) => {
    if (step.startedAt === undefined) return { ...step, took: undefined };
    const live = step.tone === "running";
    const stop = step.endedAt ?? (live ? end : step.startedAt);
    return {
      ...step,
      left: ((step.startedAt - start) / span) * 100,
      width: ((stop - step.startedAt) / span) * 100,
      took: step.endedAt === undefined ? undefined : tookLabel(step.endedAt - step.startedAt),
    };
  });
  const own = steps.filter((step) => step.depth === 0 && step.startedAt !== undefined);
  const spansOf = (kinds: readonly TraceKind[]) =>
    own
      .filter((step) => kinds.includes(step.kind))
      .map(
        (step) =>
          [
            step.startedAt!,
            step.endedAt ?? (step.tone === "running" ? end : step.startedAt!),
          ] as const,
      );
  const busy = covered(spansOf(["tool", "worker", "wait"]));
  const waitMs = covered(spansOf(["wait"]));
  return {
    start,
    end,
    steps,
    totals: {
      wallMs: span,
      toolMs: busy - waitMs,
      waitMs,
      modelMs: Math.max(0, span - busy),
    },
    failed: steps.filter((step) => step.tone === "failed").length,
    untimed: steps.filter((step) => step.startedAt === undefined).length,
    ticks: ticksOf(span),
  };
}

/** A turn of the thread, for the trace's turn picker. */
export interface TraceTurn {
  /** The turn's id, as `turnReplies` takes it. */
  readonly id: string;
  /** 1 for the thread's first loaded turn. */
  readonly number: number;
  /** Epoch ms its prompt was sent; absent when the prompt doesn't say. */
  readonly startedAt: number | undefined;
  /** How many tool calls its own replies made. */
  readonly tools: number;
}

/** The thread's loaded turns in order, each with how many calls it made. */
export function traceTurns(messages: readonly GramUIMessage[]): TraceTurn[] {
  const turns: { id: string; startedAt: number | undefined; tools: number }[] = [];
  let ended = false;
  for (const message of messages) {
    if (message.metadata?.parentToolUseId !== undefined) continue;
    if (message.role === "user") {
      turns.push({
        id: message.metadata?.turnId ?? message.id,
        startedAt: message.metadata?.createdAt,
        tools: 0,
      });
      ended = false;
      continue;
    }
    if (message.role !== "assistant") continue;
    if (turns.length === 0 || ended || message.metadata?.initiator === "agent") {
      turns.push({
        id: message.id,
        startedAt: message.metadata?.createdAt,
        tools: 0,
      });
    }
    const turn = turns.at(-1)!;
    // A reply's own turn id names the turn its prompt had none for.
    if (message.metadata?.turnId !== undefined) turn.id = message.metadata.turnId;
    turn.tools += message.parts.filter(isToolPart).length;
    ended = message.metadata?.turnEnd !== undefined;
  }
  return turns.map((turn, index) => ({ ...turn, number: index + 1 }));
}
