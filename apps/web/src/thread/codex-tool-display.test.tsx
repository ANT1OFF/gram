// @vitest-environment happy-dom
import type { GramUIMessage } from "@gram/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createMessageFold } from "@/stores/message-fold";
import type { AnyToolPart } from "./parts";
import { ToolCard } from "./tool-cards";
import displayed from "./codex-tool-display.fixture.json";

afterEach(cleanup);
const props = {
  subagents: new Map(),
  subagentUsage: new Map(),
  streamingIds: new Set<string>(),
  renderSubagent: () => null,
};
// The server regression asserts these invented records equal the actual mapper/accumulator output.
const persisted = (fixture: unknown) => {
  const message = JSON.parse(JSON.stringify(fixture)) as GramUIMessage;
  return createMessageFold(message.id, { base: message })
    .snapshot()
    .parts.find((part) => part.type === "dynamic-tool") as AnyToolPart;
};

it("renders completion-only Codex file path and Write operation after reload", () => {
  const part = persisted(displayed.file);
  render(<ToolCard part={part} {...props} />);
  expect(screen.getByTestId("file-edit").textContent).toContain("Created new.ts +1");
  fireEvent.click(screen.getByRole("button", { name: "Show changes to new.ts" }));
  expect(screen.getByTestId("patch").textContent).toContain("export const value = 1;");
});

it("renders the actual failed Codex dynamic tool cause after reload", () => {
  const part = persisted(displayed.failure);
  render(<ToolCard part={part} {...props} />);
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByTestId("tool-card").textContent).toContain("Required path is missing");
  expect(screen.getByTestId("tool-card").textContent).not.toContain("The tool call failed");
});
