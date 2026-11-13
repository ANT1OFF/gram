// @vitest-environment happy-dom
import type { GramUIMessage } from "@gram/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TraceView } from "./trace-view";

afterEach(cleanup);

const bash = (id: string, failed = false) =>
  ({
    type: "tool-Bash",
    toolCallId: id,
    state: failed ? "output-error" : "output-available",
    input: { command: `run ${id}`, description: `Ran ${id}` },
    ...(failed ? { errorText: "exit 1: expected 400, got 0" } : { output: "ok" }),
  }) as never;

const messages = [
  {
    id: "u1",
    role: "user",
    parts: [],
    metadata: { turnId: "turn-1", createdAt: 0 },
  },
  {
    id: "a1",
    role: "assistant",
    parts: [bash("c1"), bash("c2", true)],
    metadata: {
      turnId: "turn-1",
      model: "claude-opus-5",
      toolTimes: {
        c1: { startedAt: 2_000, endedAt: 4_000 },
        c2: { startedAt: 5_000, endedAt: 8_000 },
      },
      turnEnd: { at: 10_000, reason: "completed" },
    },
  },
  {
    id: "u2",
    role: "user",
    parts: [],
    metadata: { turnId: "turn-2", createdAt: 20_000 },
  },
  {
    id: "a2",
    role: "assistant",
    parts: [{ type: "text", text: "Yes." }],
    metadata: { turnId: "turn-2" },
  },
] as unknown as GramUIMessage[];

const show = (turn?: string) => {
  const onTurn = vi.fn();
  const onClose = vi.fn();
  const onReveal = vi.fn();
  render(
    <TraceView
      threadId={"t1" as never}
      messages={messages}
      subagents={new Map()}
      subagentUsage={new Map()}
      turn={turn}
      working={false}
      onTurn={onTurn}
      onClose={onClose}
      onReveal={onReveal}
    />,
  );
  return { onTurn, onClose, onReveal };
};

describe("a thread's trace", () => {
  it("opens on the latest turn with tool calls, at the step that failed", () => {
    show();
    expect(screen.getByTestId("trace-turn").textContent).toContain("Turn 1 of 2");
    expect(screen.getAllByTestId("trace-step").map((step) => step.dataset["kind"])).toEqual([
      "model",
      "tool",
      "model",
      "tool",
      "model",
    ]);
    expect(screen.getByTestId("trace-failed").textContent).toBe("1 failed");
    expect(screen.getByTestId("trace-detail-title").textContent).toBe("Ran c2");
    expect(screen.getByTestId("trace-detail-output").textContent).toBe(
      "exit 1: expected 400, got 0",
    );
  });

  it("shows a selected step's input, and takes it to the conversation", () => {
    const { onReveal, onTurn, onClose } = show();
    fireEvent.click(screen.getAllByTestId("trace-step")[1]!);
    expect(screen.getByTestId("trace-detail-input").textContent).toBe("run c1");
    fireEvent.click(screen.getByTestId("trace-reveal"));
    expect(onReveal).toHaveBeenCalledWith("a1");
    fireEvent.click(screen.getByTestId("trace-turn-later"));
    expect(onTurn).toHaveBeenCalledWith("turn-2");
    fireEvent.click(screen.getByTestId("trace-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("says so when a turn made no tool calls", () => {
    show("turn-2");
    expect(screen.getByTestId("trace-empty").textContent).toContain("no tool calls");
  });
});
