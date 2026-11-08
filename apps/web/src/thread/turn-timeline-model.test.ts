import type { GramUIMessage, ToolTime } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { tookLabel, turnReplies, turnTimeline } from "./turn-timeline-model";

const bash = (id: string, state: "output-available" | "output-error" | "input-available") =>
  ({
    type: "tool-Bash",
    toolCallId: id,
    state,
    input: { command: `run ${id}`, description: `Ran ${id}` },
    ...(state === "output-available" ? { output: "ok" } : {}),
    ...(state === "output-error" ? { errorText: "exit 1" } : {}),
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
    metadata: { turnId: "turn-1", toolTimes, ...more },
  }) as GramUIMessage;

describe("a turn's run timeline", () => {
  it("lays each call out on one axis from the turn's start to its end", () => {
    const timeline = turnTimeline(
      [
        reply("a", [bash("c1", "output-available"), bash("c2", "output-error")], {
          c1: { startedAt: 1_000, endedAt: 4_000 },
          c2: { startedAt: 3_000, endedAt: 6_000 },
        }),
      ],
      0,
      10_000,
      99_999,
    )!;
    expect(timeline.start).toBe(0);
    expect(timeline.end).toBe(10_000);
    expect(
      timeline.steps.map((step) => [step.label, step.tone, step.left, step.width, step.took]),
    ).toEqual([
      ["Ran c1", "done", 10, 30, "3s"],
      ["Ran c2", "failed", 30, 30, "3s"],
    ]);
    // 1–6 s covered, the overlap once: half the turn.
    expect(timeline.toolShare).toBe(50);
    expect(timeline.ticks.map((tick) => tick.label)).toEqual(["<1s", "5s", "10s"]);
  });

  it("runs a call still going up to now, and lists a call with no time without a bar", () => {
    const timeline = turnTimeline(
      [
        reply("a", [bash("old", "output-available"), bash("live", "input-available")], {
          live: { startedAt: 2_000 },
        }),
      ],
      0,
      undefined,
      8_000,
    )!;
    expect(timeline.end).toBe(8_000);
    const [old, live] = timeline.steps;
    expect(old).not.toHaveProperty("left");
    expect(old?.took).toBeUndefined();
    expect(live).toMatchObject({ tone: "running", left: 25, width: 75, took: "6s" });
  });

  it("has none for a turn without timed calls", () => {
    expect(turnTimeline([reply("a", [bash("c1", "output-available")], {})], 0, 1, 1)).toBe(
      undefined,
    );
    expect(tookLabel(450)).toBe("<1s");
    expect(tookLabel(62_000)).toBe("1m 02s");
  });

  it("finds a turn's own replies among the thread's messages", () => {
    const messages = [
      { id: "u1", role: "user", parts: [], metadata: { turnId: "t1", createdAt: 5 } },
      { id: "r1", role: "assistant", parts: [], metadata: { turnId: "t1" } },
      { id: "r1b", role: "assistant", parts: [], metadata: { parentToolUseId: "x" } },
      { id: "u2", role: "user", parts: [], metadata: { turnId: "t2", createdAt: 9 } },
      { id: "r2", role: "assistant", parts: [], metadata: { turnId: "t2" } },
    ] as unknown as GramUIMessage[];
    const { replies, startedAt } = turnReplies(messages, "t1");
    expect(replies.map((m) => m.id)).toEqual(["r1"]);
    expect(startedAt).toBe(5);
  });
});
