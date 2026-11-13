import type { GramUIMessage, ToolTime } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { offsetLabel, traceTurns, turnTrace } from "./trace-model";

const bash = (
  id: string,
  state:
    | "output-available"
    | "output-error"
    | "input-available"
    | "approval-requested" = "output-available",
) =>
  ({
    type: "tool-Bash",
    toolCallId: id,
    state,
    input: { command: `run ${id}`, description: `Ran ${id}` },
    ...(state === "output-available" ? { output: "ok" } : {}),
    ...(state === "output-error" ? { errorText: "exit 1" } : {}),
  }) as never;

const task = (id: string, state: "output-available" | "input-available" = "output-available") =>
  ({
    type: "tool-Task",
    toolCallId: id,
    state,
    input: {
      description: "Find callers",
      prompt: "…",
      subagent_type: "Explore",
    },
    ...(state === "output-available" ? { output: { status: "completed" } } : {}),
  }) as never;

const reply = (
  id: string,
  parts: unknown[],
  toolTimes: Record<string, ToolTime>,
  more: object = {},
): GramUIMessage =>
  ({
    id,
    role: "assistant",
    parts,
    metadata: { turnId: "turn-1", model: "claude-opus-5", toolTimes, ...more },
  }) as GramUIMessage;

const none = new Map<string, never>();
const shape = (trace: NonNullable<ReturnType<typeof turnTrace>>) =>
  trace.steps.map((step) => [step.depth, step.kind, step.label, step.took]);

describe("a turn's trace", () => {
  it("draws the model as the time between calls, and what follows the last one", () => {
    const trace = turnTrace(
      [
        reply("a", [bash("c1"), bash("c2", "output-error")], {
          c1: { startedAt: 2_000, endedAt: 4_000 },
          c2: { startedAt: 5_000, endedAt: 8_000 },
        }),
      ],
      none,
      none,
      0,
      10_000,
      99_999,
    )!;
    expect(shape(trace)).toEqual([
      [0, "model", "Model", "2s"],
      [0, "tool", "Ran c1", "2s"],
      [0, "model", "Model", "1s"],
      [0, "tool", "Ran c2", "3s"],
      [0, "model", "Model", "2s"],
    ]);
    expect(trace.steps[0]!.note).toBe("claude-opus-5");
    expect(trace.totals).toEqual({
      wallMs: 10_000,
      toolMs: 5_000,
      waitMs: 0,
      modelMs: 5_000,
    });
    expect(trace.failed).toBe(1);
    expect(trace.steps[3]).toMatchObject({
      tone: "failed",
      left: 50,
      width: 30,
    });
  });

  it("counts calls side by side once, with no model step between them", () => {
    const trace = turnTrace(
      [
        reply("a", [bash("c1"), bash("c2")], {
          c1: { startedAt: 0, endedAt: 6_000 },
          c2: { startedAt: 1_000, endedAt: 4_000 },
        }),
      ],
      none,
      none,
      0,
      6_000,
      99_999,
    )!;
    expect(shape(trace)).toEqual([
      [0, "tool", "Ran c1", "6s"],
      [0, "tool", "Ran c2", "3s"],
    ]);
    expect(trace.totals).toMatchObject({ toolMs: 6_000, modelMs: 0 });
  });

  it("nests a worker's own calls and model time under the call that started it", () => {
    const child = {
      ...reply("w1", [bash("inner")], {
        inner: { startedAt: 3_000, endedAt: 5_000 },
      }),
      metadata: {
        parentToolUseId: "t1",
        model: "claude-haiku-5.5",
        toolTimes: { inner: { startedAt: 3_000, endedAt: 5_000 } },
      },
    } as GramUIMessage;
    const trace = turnTrace(
      [reply("a", [task("t1")], { t1: { startedAt: 1_000, endedAt: 9_000 } })],
      new Map([["t1", [child]]]),
      none,
      0,
      10_000,
      99_999,
    )!;
    expect(shape(trace)).toEqual([
      [0, "model", "Model", "1s"],
      [0, "worker", "Find callers", "8s"],
      [1, "model", "Model", "2s"],
      [1, "tool", "Ran inner", "2s"],
      [1, "model", "Model", "4s"],
      [0, "model", "Model", "1s"],
    ]);
    expect(trace.steps[1]).toMatchObject({ note: "Explore", calls: 1 });
    expect(trace.steps[2]!.note).toBe("claude-haiku-5.5");
    // The worker's inner steps are not counted twice.
    expect(trace.totals).toMatchObject({ toolMs: 8_000, modelMs: 2_000 });
  });

  it("runs a live turn up to now: a call under way, then the model at work", () => {
    const live = turnTrace(
      [
        reply("a", [bash("c1", "input-available")], {
          c1: { startedAt: 1_000 },
        }),
      ],
      none,
      none,
      0,
      undefined,
      5_000,
    )!;
    expect(live.end).toBe(5_000);
    expect(live.steps.at(-1)).toMatchObject({
      kind: "tool",
      tone: "running",
      took: undefined,
      width: 80,
    });

    const thinking = turnTrace(
      [reply("a", [bash("c1")], { c1: { startedAt: 1_000, endedAt: 2_000 } })],
      none,
      none,
      0,
      undefined,
      5_000,
    )!;
    expect(thinking.steps.at(-1)).toMatchObject({
      kind: "model",
      tone: "running",
      width: 60,
    });
  });

  it("counts a call held at the person's approval as waiting, not as a tool", () => {
    const trace = turnTrace(
      [
        reply("a", [bash("c1", "approval-requested")], {
          c1: { startedAt: 1_000 },
        }),
      ],
      none,
      none,
      0,
      undefined,
      5_000,
    )!;
    expect(trace.steps.at(-1)).toMatchObject({ kind: "wait" });
    expect(trace.totals).toEqual({
      wallMs: 5_000,
      toolMs: 0,
      waitMs: 4_000,
      modelMs: 1_000,
    });
  });

  it("lists a call with no recorded time without a bar, and is nothing when none has one", () => {
    const trace = turnTrace(
      [
        reply("a", [bash("old"), bash("c1")], {
          c1: { startedAt: 1_000, endedAt: 2_000 },
        }),
      ],
      none,
      none,
      0,
      2_000,
      99_999,
    )!;
    expect(trace.untimed).toBe(1);
    expect(trace.steps.find((step) => step.id === "old")).toMatchObject({
      took: undefined,
    });
    expect(trace.steps.find((step) => step.id === "old")!.left).toBeUndefined();
    expect(
      turnTrace([reply("a", [bash("old")], {})], none, none, 0, 2_000, 99_999),
    ).toBeUndefined();
  });

  it("puts round ticks along the axis", () => {
    const trace = turnTrace(
      [reply("a", [bash("c1")], { c1: { startedAt: 0, endedAt: 190_000 } })],
      none,
      none,
      0,
      190_000,
      0,
    )!;
    expect(trace.ticks.map((tick) => tick.label)).toEqual(["0:00", "1:00", "2:00", "3:00"]);
    expect(offsetLabel(3_725_000)).toBe("1:02:05");
  });
});

const user = (id: string, turnId: string, createdAt: number) =>
  ({
    id,
    role: "user",
    parts: [],
    metadata: { turnId, createdAt },
  }) as unknown as GramUIMessage;

describe("the thread's turns", () => {
  it("numbers each send and counts its calls, a turn the agent started included", () => {
    const turns = traceTurns([
      user("u1", "turn-1", 100),
      reply("a", [bash("c1"), bash("c2")], {}, { turnEnd: { at: 1 } }),
      reply("b", [bash("c3")], {}, { turnId: undefined, initiator: "agent", createdAt: 200 }),
      user("u2", "turn-2", 300),
      reply("c", [], {}, { turnId: "turn-2" }),
    ]);
    expect(turns.map((turn) => [turn.number, turn.id, turn.startedAt, turn.tools])).toEqual([
      [1, "turn-1", 100, 2],
      [2, "b", 200, 1],
      [3, "turn-2", 300, 0],
    ]);
  });
});
