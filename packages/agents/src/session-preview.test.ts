import type { SessionMessage as ClaudeMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { toSessionPreview, transcriptText } from "./claude/sessions.ts";
import { previewLine, previewOf } from "./session-preview.ts";

const claude = (
  type: ClaudeMessage["type"],
  content: unknown,
  parent: string | null = null,
): ClaudeMessage => ({
  type,
  uuid: `u-${Math.random()}`,
  session_id: "s1",
  message: { role: type, content },
  parent_tool_use_id: parent,
  parent_agent_id: null,
});

describe("session previews", () => {
  it("fold whitespace onto one capped line", () => {
    expect(previewLine("  fix\n\n the  tests ")).toBe("fix the tests");
    expect(previewLine("   ")).toBeUndefined();
    const long = previewLine("x".repeat(500))!;
    expect(long).toHaveLength(240);
    expect(long.endsWith("…")).toBe(true);
  });

  it("take the first prompt and the last reply that have text", () => {
    expect(
      previewOf([
        { role: "user", text: " " },
        { role: "user", text: "Speed up tests" },
        { role: "assistant", text: "Looking" },
        { role: "assistant", text: undefined },
        { role: "user", text: "thanks" },
      ]),
    ).toEqual({ firstPrompt: "Speed up tests", lastReply: "Looking" });
    expect(previewOf([])).toEqual({});
  });

  it("read Claude transcripts, skipping tool results, system entries and subagents", () => {
    expect(transcriptText({ content: [{ type: "tool_result", content: "ok" }] })).toBeUndefined();
    expect(
      toSessionPreview([
        claude("system", "compact boundary"),
        claude("user", "The retry tests take 40 s, make them fast."),
        claude("assistant", [{ type: "tool_use", name: "Bash" }]),
        claude("user", [{ type: "tool_result", content: "done" }]),
        claude("assistant", [{ type: "text", text: "Subagent notes" }], "toolu_1"),
        claude("assistant", [
          { type: "text", text: "Swapped the sleeps" },
          { type: "text", text: "for fake timers." },
        ]),
      ]),
    ).toEqual({
      firstPrompt: "The retry tests take 40 s, make them fast.",
      lastReply: "Swapped the sleeps for fake timers.",
    });
  });
});
