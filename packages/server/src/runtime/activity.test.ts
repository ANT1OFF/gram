import type { AgentEvent, MessageId, RequestId } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { ActivityTracker } from "./activity.ts";

const CWD = "/work/repo";

const chunk = (value: unknown, messageId = "m1"): AgentEvent =>
  ({ type: "chunk", messageId: messageId as MessageId, chunk: value }) as AgentEvent;

const tool = (toolName: string, input: unknown, toolCallId = "toolu_1", messageId = "m1") =>
  chunk({ type: "tool-input-available", toolCallId, toolName, input }, messageId);

const lines = (...events: ReadonlyArray<AgentEvent>) => {
  const tracker = new ActivityTracker();
  return events.map((event) => {
    tracker.apply(event, CWD);
    return tracker.line;
  });
};

describe("ActivityTracker", () => {
  it("describes built-in tools with short paths and commands", () => {
    expect(
      lines(
        chunk({ type: "reasoning-start", id: "r" }),
        tool("Read", { file_path: "/work/repo/src/app.ts" }),
        tool("Bash", { command: "pnpm test\n--reporter dot" }),
        tool("Grep", { pattern: "retry" }),
        tool("WebFetch", { url: "https://organization.example.invalid/a?b=1" }),
        tool("Read", { file_path: "/etc/hosts" }),
        tool("mcp__gram__set_title", { title: "x" }),
        chunk({ type: "text-start", id: "t" }),
      ),
    ).toEqual([
      "Thinking",
      "Reading src/app.ts",
      "Running pnpm test",
      "Searching for retry",
      "Fetching organization.example.invalid",
      "Reading /etc/hosts",
      "Using gram: set_title",
      "Writing a reply",
    ]);
  });

  it("shortens a path under a folder whose name starts with two dots", () => {
    expect(lines(tool("Read", { file_path: `${CWD}/..cache/notes.md` }))).toEqual([
      "Reading ..cache/notes.md",
    ]);
  });

  it("shows paths with forward slashes on every OS", () => {
    expect(lines(tool("Read", { file_path: "C:\\Users\\x\\notes.md" }))).toEqual([
      "Reading C:/Users/x/notes.md",
    ]);
  });

  it("counts the files edited this turn and forgets them at the end", () => {
    const tracker = new ActivityTracker();
    tracker.apply(tool("Edit", { file_path: "/work/repo/a.ts" }), CWD);
    expect(tracker.line).toBe("Editing a.ts");
    // The next edit's input is still streaming: keep the line rather than flicker to "Editing a file".
    tracker.apply(
      chunk({ type: "tool-input-start", toolCallId: "toolu_2", toolName: "Write" }),
      CWD,
    );
    expect(tracker.line).toBe("Editing a.ts");
    tracker.apply(tool("Write", { file_path: "/work/repo/b.ts" }), CWD);
    tracker.apply(tool("Edit", { file_path: "/work/repo/c.ts" }), CWD);
    expect(tracker.line).toBe("Editing 3 files");
    tracker.apply(tool("Edit", { file_path: "/work/repo/a.ts" }), CWD);
    expect(tracker.line).toBe("Editing 3 files");

    tracker.apply({ type: "turnEnd", reason: "completed" }, CWD);
    expect(tracker.line).toBeUndefined();
    tracker.apply(tool("Write", { file_path: "/work/repo/new.ts" }), CWD);
    expect(tracker.line).toBe("Writing new.ts");
  });

  it("shows a wait and restores the work once the request resolves", () => {
    expect(
      lines(
        tool("Bash", { command: "git push" }),
        {
          type: "request",
          request: {
            kind: "approval",
            id: "r1" as RequestId,
            toolName: "Bash",
            displayName: "Bash",
            input: {},
            suggestions: [],
          },
        },
        { type: "status", status: "awaitingApproval" },
        { type: "requestResolved", requestId: "r1" as RequestId },
        { type: "status", status: "retrying", detail: "API retry 1/3" },
        { type: "status", status: "running" },
        { type: "status", status: "idle" },
      ),
    ).toEqual([
      "Running git push",
      "Waiting for approval",
      "Waiting for approval",
      "Running git push",
      "API retry 1/3",
      "Running git push",
      undefined,
    ]);
  });

  it("says it is compacting until the agent runs on, then shows its work again", () => {
    expect(
      lines(
        { type: "status", status: "compacting", compaction: { startedAt: 1 } },
        { type: "status", status: "running" },
        tool("Bash", { command: "pnpm test" }),
        { type: "status", status: "compacting", compaction: { startedAt: 2 } },
        { type: "status", status: "running" },
      ),
    ).toEqual([
      "Compacting context",
      undefined,
      "Running pnpm test",
      "Compacting context",
      "Running pnpm test",
    ]);
  });

  it("prefixes a subagent's work with its type", () => {
    expect(
      lines(
        tool(
          "Task",
          { description: "Find the retry helper", subagent_type: "Explore" },
          "toolu_task",
        ),
        chunk({ type: "start", messageMetadata: { parentToolUseId: "toolu_task" } }, "sub-1"),
        tool("Grep", { pattern: "retry" }, "toolu_2", "sub-1"),
        tool("Read", { file_path: "/work/repo/src/retry.ts" }, "toolu_3", "m1"),
      ),
    ).toEqual([
      "Explore: Find the retry helper",
      "Explore: Find the retry helper",
      "Explore: Searching for retry",
      "Reading src/retry.ts",
    ]);
  });

  it("reports whether the line changed", () => {
    const tracker = new ActivityTracker();
    expect(tracker.apply(tool("Read", { file_path: "/work/repo/a.ts" }), CWD)).toBe(true);
    expect(tracker.apply(tool("Read", { file_path: "/work/repo/a.ts" }), CWD)).toBe(false);
    expect(tracker.apply({ type: "usage", tokens: { inputTokens: 1, outputTokens: 1 } }, CWD)).toBe(
      false,
    );
  });

  it("keeps a background subagent's line after the turn until the subagent finishes", () => {
    const tracker = new ActivityTracker();
    const line = (event: AgentEvent) => {
      tracker.apply(event, CWD);
      return tracker.line;
    };
    line(chunk({ type: "start" }));
    line(tool("Agent", { description: "List files", subagent_type: "Explore" }, "toolu_bg"));
    line(chunk({ type: "start", messageMetadata: { parentToolUseId: "toolu_bg" } }, "sub-1"));
    expect(line(tool("Grep", { pattern: "retry" }, "toolu_2", "sub-1"))).toBe(
      "Explore: Searching for retry",
    );
    line(chunk({ type: "finish" }));

    expect(line({ type: "turnEnd", reason: "completed" })).toBe("Explore: Searching for retry");
    expect(line({ type: "status", status: "idle" })).toBe("Explore: Searching for retry");
    expect(tracker.subagentsRunning).toBe(true);
    expect(line(chunk({ type: "reasoning-start", id: "r" }, "sub-1"))).toBe("Explore: Thinking");

    expect(line(chunk({ type: "finish" }, "sub-1"))).toBeUndefined();
    expect(tracker.subagentsRunning).toBe(false);
  });

  it("keeps the line when a foreground subagent finishes mid-turn", () => {
    expect(
      lines(
        tool("Task", { description: "Find it", subagent_type: "Explore" }, "toolu_task"),
        chunk({ type: "start", messageMetadata: { parentToolUseId: "toolu_task" } }, "sub-1"),
        tool("Grep", { pattern: "retry" }, "toolu_2", "sub-1"),
        chunk({ type: "finish" }, "sub-1"),
        { type: "turnEnd", reason: "completed" },
      ),
    ).toEqual([
      "Explore: Find it",
      "Explore: Find it",
      "Explore: Searching for retry",
      "Explore: Searching for retry",
      undefined,
    ]);
  });
});
