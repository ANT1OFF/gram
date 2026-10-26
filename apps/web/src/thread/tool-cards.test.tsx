// @vitest-environment happy-dom
import type { SubagentUsageData, GramUIMessage } from "@gram/contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { AnyToolPart } from "./parts";
import { ToolCard } from "./tool-cards";
import { revealCard } from "./transcript";

afterEach(cleanup);

const launched = {
  type: "tool-Agent",
  toolCallId: "bg1",
  state: "output-available",
  input: { description: "List files", prompt: "p", subagent_type: "Explore" },
  output: {
    status: "async_launched",
    agentId: "a1",
    description: "List files",
    prompt: "p",
    outputFile: "/tmp/a1",
  },
} as unknown as AnyToolPart;

const transcript = {
  id: "sub1",
  role: "assistant",
  parts: [{ type: "text", text: "looking" }],
  metadata: { parentToolUseId: "bg1", model: "claude-haiku-4-5-20251001" },
} as unknown as GramUIMessage;

const card = (
  streamingIds: ReadonlySet<string>,
  options: {
    usage?: SubagentUsageData;
    part?: AnyToolPart;
    messages?: readonly GramUIMessage[];
  } = {},
) => {
  const part = options.part ?? launched;
  const messages = options.messages ?? [transcript];
  return render(
    <ToolCard
      part={part}
      subagents={new Map([["bg1", [...messages]]])}
      subagentUsage={options.usage ? new Map([["bg1", options.usage]]) : new Map()}
      streamingIds={streamingIds}
      renderSubagent={(message) => <p>{message.id}</p>}
    />,
  );
};

describe("ToolShell", () => {
  it.each([
    {
      title: "Search web",
      input: { action: "search", query: "Codex compaction" },
      summary: "Codex compaction",
    },
    {
      title: "Search web",
      input: { action: "search", queries: ["first", "second"] },
      summary: "first; second",
    },
    {
      title: "Open page",
      input: { action: "openPage", url: "https://example.com/docs" },
      summary: "https://example.com/docs",
    },
    {
      title: "Find in page",
      input: { action: "findInPage", url: "https://example.com/docs", pattern: "compact" },
      summary: "https://example.com/docs · compact",
    },
  ])("renders native $title metadata in the collapsed card", ({ title, input, summary }) => {
    const part = {
      type: "dynamic-tool",
      toolName: "WebSearch",
      toolCallId: "web",
      title,
      state: "output-available",
      input,
      output: { action: { type: input.action } },
      providerExecuted: true,
    } as AnyToolPart;
    card(new Set(), { part, messages: [] });
    const trigger = screen.getByRole("button", { name: new RegExp(title) });
    expect(trigger.textContent).toContain(summary);
    expect(trigger.textContent).toContain("Done");
    fireEvent.click(trigger);
    expect(screen.getByTestId("tool-card").textContent).toContain(JSON.stringify(input, null, 2));
  });

  it("keeps a failed native web action in the error state", () => {
    card(new Set(), {
      messages: [],
      part: {
        type: "dynamic-tool",
        toolName: "WebSearch",
        toolCallId: "web",
        title: "Search web",
        state: "output-error",
        input: { action: "search", query: "Codex" },
        errorText: "Search unavailable",
        providerExecuted: true,
      } as AnyToolPart,
    });
    expect(screen.getByRole("button", { name: /Search web/ }).textContent).toContain("Error");
    expect(screen.getByTestId("tool-card").textContent).not.toContain("Done");
  });

  it("renders a persisted cancelled Codex tool as terminal after reload", () => {
    const part = JSON.parse(
      JSON.stringify({
        type: "dynamic-tool",
        toolName: "Bash",
        toolCallId: "cancelled-command",
        state: "output-error",
        input: { command: "echo blocked" },
        errorText: "Cancelled",
        providerExecuted: true,
      }),
    ) as AnyToolPart;
    card(new Set(), { part, messages: [] });
    expect(screen.getByTestId("tool-card").textContent).toContain("Cancelled");
    expect(screen.getByTestId("tool-card").textContent).not.toContain("Running");
  });

  it("renders a closed card's output only once it's opened, then keeps it", () => {
    const bash = {
      type: "tool-Bash",
      toolCallId: "b1",
      state: "output-available",
      input: { command: "pnpm test" },
      output: { stdout: "12 tests passed", stderr: "", interrupted: false },
    } as unknown as AnyToolPart;
    render(
      <ToolCard
        part={bash}
        subagents={new Map()}
        subagentUsage={new Map()}
        streamingIds={new Set()}
        renderSubagent={() => null}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Bash/ });
    expect(screen.queryByText("12 tests passed")).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByText("12 tests passed")).toBeTruthy();

    fireEvent.click(trigger);
    expect(screen.getByText("12 tests passed")).toBeTruthy();
  });
});

describe("TaskCard", () => {
  it("runs while a background subagent's transcript streams, then shows done", () => {
    card(new Set(["sub1"]));
    expect(screen.getByTestId("tool-card").textContent).toContain("Running");
    expect(screen.getByText("Running in the background")).toBeTruthy();
    expect(screen.getByText("Explore")).toBeTruthy();
    expect(screen.getByTestId("subagent-transcript").textContent).toContain("sub1");
    cleanup();

    card(new Set());
    expect(screen.getByTestId("tool-card").textContent).toContain("Done");
    expect(screen.getByText("Ran in the background")).toBeTruthy();
  });

  it("names the lane's model, falling back to an explicit input override", () => {
    card(new Set());
    expect(screen.getByTestId("subagent-model").textContent).toBe("claude-haiku-4-5-20251001");
    cleanup();

    const overridden = {
      ...launched,
      input: { ...(launched as { input: object }).input, model: "opus" },
    } as unknown as AnyToolPart;
    card(new Set(), {
      part: overridden,
      messages: [{ ...transcript, metadata: { parentToolUseId: "bg1" } } as GramUIMessage],
    });
    expect(screen.getByTestId("subagent-model").textContent).toBe("opus");
    cleanup();

    card(new Set(), {
      messages: [{ ...transcript, metadata: { parentToolUseId: "bg1" } } as GramUIMessage],
    });
    expect(screen.queryByTestId("subagent-model")).toBeNull();
  });

  it("shows a running subagent's live counts and what it's on", () => {
    card(new Set(["sub1"]), {
      usage: {
        toolCallId: "bg1",
        status: "running",
        totalTokens: 8_120,
        toolUses: 3,
        durationMs: 12_400,
        lastToolName: "Grep",
      },
    });
    expect(screen.getByTestId("subagent-usage").textContent).toBe(
      "3 tool uses · 12.4s · 8,120 tokens",
    );
    expect(screen.getByText("Grep")).toBeTruthy();
  });

  it("gives a background run's terminal snapshot the numbers it otherwise lacks", () => {
    card(new Set(), {
      usage: { toolCallId: "bg1", status: "completed", totalTokens: 5_380, toolUses: 2 },
    });
    expect(screen.getByTestId("subagent-usage").textContent).toBe("2 tool uses · 5,380 tokens");
    expect(screen.getByText("Ran in the background")).toBeTruthy();
  });

  it("keeps a finished foreground run's richer totals and shows them once", () => {
    const completed = {
      type: "tool-Task",
      toolCallId: "bg1",
      state: "output-available",
      input: { description: "List files", prompt: "p", subagent_type: "Explore" },
      output: {
        status: "completed",
        agentId: "a1",
        content: [{ type: "text", text: "done" }],
        prompt: "p",
        totalToolUseCount: 4,
        totalDurationMs: 2_300,
        totalTokens: 4_120,
      },
    } as unknown as AnyToolPart;
    card(new Set(), {
      part: completed,
      usage: { toolCallId: "bg1", status: "completed", totalTokens: 4_120, toolUses: 4 },
    });

    expect(screen.queryByTestId("subagent-usage")).toBeNull();
    expect(screen.getAllByText(/4 tool uses · 2.3s · 4,120 tokens/)).toHaveLength(1);
  });
});

const TEXT = "Fetched 12 links about otters.";

const stringOutput = (type: string, input: object) =>
  ({
    type,
    toolCallId: "t1",
    state: "output-available",
    input,
    output: TEXT,
  }) as unknown as AnyToolPart;

/** Renders a card and opens it, leaving the ones that open themselves alone. */
const openCard = (part: AnyToolPart, name: RegExp) => {
  render(
    <ToolCard
      part={part}
      subagents={new Map()}
      subagentUsage={new Map()}
      streamingIds={new Set()}
      renderSubagent={() => null}
    />,
  );
  const trigger = screen.getByRole("button", { name });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
};

const textResultCards: ReadonlyArray<[string, RegExp, object]> = [
  ["tool-Bash", /Bash/, { command: "ls" }],
  ["tool-Read", /Read/, { file_path: "/a/b.ts" }],
  ["tool-Glob", /Glob/, { pattern: "*.ts" }],
  ["tool-Grep", /Grep/, { pattern: "otter" }],
  ["tool-Task", /Task/, { description: "Look around", prompt: "p" }],
  ["tool-WebFetch", /WebFetch/, { url: "https://otters.example", prompt: "p" }],
  ["tool-WebSearch", /WebSearch/, { query: "otters" }],
];

/**
 * The Claude Code SDK sends no `tool_use_result` on a subagent's messages, so the mapper falls
 * back to the result text and every tool a subagent runs reports a bare string. A card that reads
 * the structured shape blind used to take the whole thread down with it.
 */
describe("a subagent's string output", () => {
  it.each(textResultCards)("keeps a %s card standing and shows the text", (type, name, input) => {
    openCard(stringOutput(type, input), name);
    expect(screen.getByText(TEXT)).toBeTruthy();
  });
  // An edit row reads the change from the call itself; the result text only says it succeeded.
  it("keeps an Edit row standing and draws its change from the replaced strings", () => {
    openCard(
      stringOutput("tool-Edit", { file_path: "/a/b.ts", old_string: "x", new_string: "y" }),
      /Show changes to b\.ts/,
    );
    expect(screen.getByTestId("file-edit").textContent).toContain("Edited b.ts +1 −1");
    expect(screen.getByTestId("patch").textContent).toContain("x");
    expect(screen.getByTestId("patch").textContent).toContain("y");
  });

  it("keeps a Write row standing and draws its contents as added", () => {
    openCard(stringOutput("tool-Write", { file_path: "/a/b.ts", content: "x" }), /b\.ts/);
    expect(screen.getByTestId("file-edit").textContent).toContain("Wrote b.ts +1");
    expect(screen.getByTestId("patch").textContent).toContain("x");
  });
});

const runningTask = (toolCallId: string, description: string) =>
  ({
    type: "tool-Agent",
    toolCallId,
    state: "input-available",
    input: { description, prompt: "p" },
  }) as unknown as AnyToolPart;
const lane = (id: string, parent: string, part: AnyToolPart) =>
  ({
    id,
    role: "assistant",
    parts: [part],
    metadata: { parentToolUseId: parent },
  }) as unknown as GramUIMessage;

describe("revealCard", () => {
  it("opens a collapsed card on the way to the nested one, then focuses that", () => {
    const inner = runningTask("inner", "Inner run");
    const { container } = render(
      <ToolCard
        part={runningTask("outer", "Outer run")}
        subagents={new Map([["outer", [lane("sub", "outer", inner)]]])}
        subagentUsage={new Map()}
        streamingIds={new Set()}
        renderSubagent={(message) => (
          <ToolCard
            part={message.parts[0] as AnyToolPart}
            subagents={new Map()}
            subagentUsage={new Map()}
            streamingIds={new Set()}
            renderSubagent={() => null}
          />
        )}
      />,
    );
    const outer = screen.getByRole("button", { name: /Outer run/ });
    fireEvent.click(outer);
    expect(outer.getAttribute("aria-expanded")).toBe("false");

    let revealed: boolean | undefined;
    act(() => {
      revealed = revealCard(container, ["outer", "inner"]);
    });
    expect(revealed).toBe(false);
    expect(outer.getAttribute("aria-expanded")).toBe("true");
    expect(revealCard(container, ["outer", "inner"])).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Inner run/ }));
    expect(revealCard(container, ["gone"])).toBe(false);
  });
});
