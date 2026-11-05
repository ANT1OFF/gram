// @vitest-environment happy-dom
import type { RequestId, ThreadId } from "@gram/contracts";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useThreadsStore } from "@/stores/threads";

import { AwaitingToolsProvider } from "./awaiting-tools";
import type { AnyToolPart } from "./parts";
import { ToolCard } from "./tool-cards";
import { ToolGroup } from "./tool-group";

const T = "t-approve" as ThreadId;

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {} as never });
});

const push = {
  type: "tool-Bash",
  toolCallId: "call-push",
  state: "input-available",
  input: { command: "git push origin fix/flaky-retry" },
} as unknown as AnyToolPart;

const asking = (pending: boolean) =>
  useThreadsStore.setState({
    byId: {
      [T]: {
        status: pending ? "needsApproval" : "running",
        pendingRequests: pending
          ? [
              {
                kind: "approval",
                id: "r1" as RequestId,
                toolUseId: "call-push",
                toolName: "Bash",
                displayName: "Bash",
                input: { command: "git push origin fix/flaky-retry" },
                suggestions: [],
              },
            ]
          : [],
      },
    } as never,
  });

const none = new Map();
const props = { subagents: none, subagentUsage: none, streamingIds: new Set<string>() };

describe("a tool call held at an approval", () => {
  it("waits for your approval, then runs once allowed", () => {
    asking(true);
    render(
      <AwaitingToolsProvider threadId={T}>
        <ToolCard part={push} {...props} renderSubagent={() => null} />
      </AwaitingToolsProvider>,
    );
    const row = screen.getByTestId("tool-card");
    expect(row.textContent).toContain("Waiting for your approval");
    expect(row.textContent).not.toContain("Running");
    act(() => asking(false));
    expect(row.textContent).toContain("Running");
    expect(row.textContent).not.toContain("Waiting for your approval");
  });

  it("names the waiting call on a folded run's line, and opens the run", () => {
    asking(true);
    const read = {
      type: "tool-Read",
      toolCallId: "call-read",
      state: "output-available",
      input: { file_path: "/repo/README.md" },
      output: "",
    } as unknown as AnyToolPart;
    render(
      <AwaitingToolsProvider threadId={T}>
        <ToolGroup run={[read, push]} {...props} renderSubagent={() => null} />
      </AwaitingToolsProvider>,
    );
    const group = screen.getByTestId("tool-group");
    expect(group.getAttribute("data-open")).toBe("true");
    expect(group.textContent).toContain("Waiting for your approval · Bash git push");
  });
});
