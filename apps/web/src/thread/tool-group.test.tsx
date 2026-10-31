// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { AnyToolPart } from "./parts";
import { ToolGroup, TurnFoldRow } from "./tool-group";

const tool = (id: string, name: string, input: object, state: AnyToolPart["state"]) =>
  ({ type: `tool-${name}`, toolCallId: id, state, input, output: "" }) as AnyToolPart;

const card = {
  subagents: new Map(),
  subagentUsage: new Map(),
  streamingIds: new Set<string>(),
  renderSubagent: () => null,
};

afterEach(cleanup);

describe("ToolGroup", () => {
  it("folds a finished run into its summary and opens to the cards", () => {
    const run = [
      tool("a", "Bash", { command: "pnpm test" }, "output-available"),
      tool("b", "Read", { file_path: "/repo/a.ts" }, "output-available"),
    ];
    render(<ToolGroup run={run} {...card} />);
    const toggle = screen.getByRole("button", { name: "Ran 1 command, read 1 file" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByTestId("tool-card")).toHaveLength(0);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByTestId("tool-card")).toHaveLength(2);
  });

  it("names the files a run edited and totals their lines on the closed line", () => {
    const run = [
      tool(
        "a",
        "Edit",
        { file_path: "/repo/a.ts", old_string: "x", new_string: "y\nz" },
        "output-available",
      ),
      tool("b", "Bash", { command: "pnpm test" }, "output-available"),
    ];
    render(<ToolGroup run={run} {...card} />);
    const toggle = screen.getByRole("button");
    expect(toggle.textContent).toBe("Edited a.ts, ran 1 command +2 −1");
    fireEvent.click(toggle);
    expect(screen.getAllByTestId("file-edit")).toHaveLength(1);
    expect(screen.getAllByTestId("tool-card")).toHaveLength(1);
  });

  it("names the step in flight and counts a failure on the closed line", () => {
    const run = [
      tool("a", "Read", { file_path: "/repo/a.ts" }, "output-error"),
      tool(
        "b",
        "Bash",
        { command: "pnpm check", description: "Running the check" },
        "input-available",
      ),
    ];
    render(<ToolGroup run={run} {...card} />);
    expect(screen.getByRole("button").textContent).toBe("Running the check…· 1 failed");
  });

  it("starts open while a call waits for approval", () => {
    const run = [
      tool("a", "Read", { file_path: "/repo/a.ts" }, "output-available"),
      tool("b", "Bash", { command: "git push" }, "approval-requested"),
    ];
    render(<ToolGroup run={run} {...card} />);
    expect(screen.getAllByTestId("tool-card")).toHaveLength(2);
  });
});

describe("TurnFoldRow", () => {
  const turn = { state: "failed", startedAt: 0, endedAt: 161_000, tools: 4, failed: 1 } as const;

  it("counts failures on the closed line and says when it's open", () => {
    const toggled: string[] = [];
    render(<TurnFoldRow turn={turn} open={false} onToggle={() => toggled.push("toggle")} />);
    const row = screen.getByTestId("turn-fold");
    expect(row.textContent).toBe("Failed after 2m 41s · 4 tools· 1 failed");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    expect(toggled).toEqual(["toggle"]);
  });
});
