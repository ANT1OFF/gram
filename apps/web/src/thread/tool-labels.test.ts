import { describe, expect, it } from "vitest";

import { toolLabel } from "./tool-labels";

describe("toolLabel", () => {
  it("says what Gram's own tools did, with the raw id kept for the details", () => {
    expect(toolLabel("mcp__gram__merge_when_ready", "done")).toEqual({
      label: "Queued to merge when ready",
      raw: "mcp__gram__merge_when_ready",
    });
    expect(toolLabel("mcp__gram__spawn_worker", "running").label).toBe("Starting a worker");
    expect(toolLabel("mcp__gram__spawn_worker", "awaiting").label).toBe("Starting a worker");
    expect(toolLabel("mcp__gram__spawn_worker", "error").label).toBe("Started a worker");
  });

  it("puts another server's tool in words and names its server", () => {
    expect(toolLabel("mcp__claude_ai_Linear__list_issues", "done")).toEqual({
      label: "List issues · Linear",
      raw: "mcp__claude_ai_Linear__list_issues",
    });
    expect(toolLabel("mcp__gram__someNewTool", "done").label).toBe("Some new tool");
  });

  it("keeps a built-in tool's name and an agent's own title", () => {
    expect(toolLabel("Bash", "done")).toEqual({ label: "Bash", raw: undefined });
    expect(toolLabel("TodoWrite", "done").label).toBe("Updated the to-do list");
    expect(toolLabel("mcp__gram__merge_when_ready", "done", "Merge #12")).toEqual({
      label: "Merge #12",
      raw: "mcp__gram__merge_when_ready",
    });
  });
});
