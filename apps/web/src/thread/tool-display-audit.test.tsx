// @vitest-environment happy-dom
import type { GramUIMessage } from "@gram/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { createMessageFold } from "@/stores/message-fold";

import type { AnyToolPart } from "./parts";
import { ToolCard } from "./tool-cards";
import { ToolGroup } from "./tool-group";
import { runState, runSummary } from "./tool-group-model";

afterEach(cleanup);

const props = {
  subagents: new Map(),
  subagentUsage: new Map(),
  streamingIds: new Set<string>(),
  renderSubagent: (message: GramUIMessage) => <p>{message.id}</p>,
};

const persisted = (name: string, input: unknown, output: unknown, dynamic = false) => {
  const fold = createMessageFold("audit");
  fold.apply({ type: "tool-input-available", toolCallId: "call", toolName: name, input, dynamic });
  fold.apply({ type: "tool-output-available", toolCallId: "call", output, dynamic });
  return JSON.parse(JSON.stringify(fold.snapshot().parts[0])) as AnyToolPart;
};

it("keeps a cancelled call distinct from a genuine failed file lookup in a folded run", () => {
  const cancelled = {
    ...persisted("Bash", { command: "echo blocked" }, "", true),
    state: "output-error",
    errorText: "Cancelled",
  } as AnyToolPart;
  const failed = {
    ...persisted("Read", { file_path: "/missing.ts" }, ""),
    state: "output-error",
    errorText: "File not found",
  } as AnyToolPart;
  expect(runState([cancelled, failed])).toMatchObject({ failed: 1, cancelled: 1 });
  render(<ToolGroup run={[cancelled, failed]} {...props} />);
  expect(screen.getByRole("button").textContent).toContain("1 failed");
  expect(screen.getByRole("button").textContent).toContain("1 cancelled");
});

it("does not claim a web search fetched one page", () => {
  expect(runSummary([persisted("WebSearch", { query: "synthetic query" }, undefined, true)])).toBe(
    "Made 1 web lookup",
  );
});

it("counts a multi-file Codex patch as one edit without inventing a file count", () => {
  expect(
    runSummary([
      persisted("Edit", { changes: [{ path: "/repo/a.ts" }, { path: "/repo/b.ts" }] }, {}, true),
    ]),
  ).toBe("Made 1 edit");
});

it("shows native dynamic command and file targets in the closed card", () => {
  render(
    <ToolCard part={persisted("Bash", { command: "echo audit" }, undefined, true)} {...props} />,
  );
  expect(screen.getByRole("button").textContent).toContain("echo audit");
  cleanup();
  render(
    <ToolCard part={persisted("Read", { file_path: "/repo/logo.png" }, {}, true)} {...props} />,
  );
  expect(screen.getByRole("button").textContent).toContain("logo.png");
});

it("shows actual Claude Read content after reload", () => {
  render(
    <ToolCard
      part={persisted(
        "Read",
        { file_path: "/repo/config.ts" },
        {
          type: "text",
          file: {
            filePath: "/repo/config.ts",
            content: "export const audit = true;",
            numLines: 1,
            startLine: 1,
            totalLines: 1,
          },
        },
      )}
      {...props}
    />,
  );
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByText("export const audit = true;")).toBeTruthy();
});

it("keeps WebSearch textual results alongside returned links", () => {
  render(
    <ToolCard
      part={persisted(
        "WebSearch",
        { query: "audit" },
        {
          query: "audit",
          results: [
            "No exact match; showing related results",
            {
              tool_use_id: "search",
              content: [{ title: "Synthetic result", url: "https://example.com/audit" }],
            },
          ],
          durationSeconds: 1,
        },
      )}
      {...props}
    />,
  );
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByText("No exact match; showing related results")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Synthetic result" }).getAttribute("href")).toBe(
    "https://example.com/audit",
  );
});

it("renders a completed native web lookup with absent results honestly", () => {
  render(
    <ToolCard
      part={persisted("WebSearch", { queries: ["one query", "another query"] }, undefined, true)}
      {...props}
    />,
  );
  expect(screen.getByRole("button").textContent).toContain("one query");
  expect(screen.getByRole("button").textContent).toContain("another query");
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByText("No result details were provided.")).toBeTruthy();
  expect(screen.getByTestId("tool-card").textContent).toContain("Done");
});

it("shows a foreground Task's report even when no child transcript was supplied", () => {
  render(
    <ToolCard
      part={persisted(
        "Task",
        { description: "Audit", prompt: "synthetic" },
        {
          status: "completed",
          content: [{ type: "text", text: "Audit report: two findings" }],
          totalToolUseCount: 2,
          totalDurationMs: 1000,
          totalTokens: 20,
        },
      )}
      {...props}
    />,
  );
  expect(screen.getByText("Audit report: two findings")).toBeTruthy();
});
