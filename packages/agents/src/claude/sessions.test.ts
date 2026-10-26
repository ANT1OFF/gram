import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { TRANSCRIPT_TOOL_MAX_CHARS } from "../transcript-text.ts";
import { toSessionSummary, toSessionTranscript } from "./sessions.ts";

const info = (extra: Partial<SDKSessionInfo>): SDKSessionInfo =>
  ({ sessionId: "s1", summary: "", lastModified: 1_700_000_000_000, ...extra }) as SDKSessionInfo;

describe("toSessionSummary", () => {
  it("prefers the custom title, then the summary, then the first prompt", () => {
    expect(
      toSessionSummary(info({ customTitle: "Mine", summary: "Auto", firstPrompt: "Fix it" })).title,
    ).toBe("Mine");
    expect(toSessionSummary(info({ summary: "Auto", firstPrompt: "Fix it" })).title).toBe("Auto");
    expect(toSessionSummary(info({ summary: " ", firstPrompt: "Fix it" })).title).toBe("Fix it");
    expect(toSessionSummary(info({})).title).toBe("s1");
  });

  it("carries the time, branch, cwd and first prompt when present", () => {
    expect(
      toSessionSummary(info({ firstPrompt: "Fix it", gitBranch: "main", cwd: "/repo" })),
    ).toEqual({
      agentSessionId: "s1",
      title: "Fix it",
      updatedAt: 1_700_000_000_000,
      firstPrompt: "Fix it",
      gitBranch: "main",
      cwd: "/repo",
    });
    expect(Object.keys(toSessionSummary(info({ summary: "x" })))).toEqual([
      "agentSessionId",
      "title",
      "updatedAt",
    ]);
  });
});

/**
 * A recorded stream's user and assistant messages. They carry the fields `getSessionMessages`
 * returns (`type`, `message`, `parent_tool_use_id`), one content block per message as on disk.
 */
const recorded = (name: string): ReadonlyArray<SessionMessage> =>
  readFileSync(new URL(`../../fixtures/claude/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => (JSON.parse(line) as { msg?: SessionMessage }).msg)
    .filter(
      (msg): msg is SessionMessage =>
        msg !== undefined && (msg.type === "user" || msg.type === "assistant"),
    );

const entry = (
  type: SessionMessage["type"],
  content: unknown,
  parent: string | null = null,
): SessionMessage => ({
  type,
  uuid: "u",
  session_id: "s",
  message: { content },
  parent_tool_use_id: parent,
  parent_agent_id: null,
});

describe("toSessionTranscript", () => {
  it("pairs each tool call with its result and drops thinking", () => {
    const messages = toSessionTranscript(recorded("p05-approvals"));
    expect(messages.map((m) => m.role)).toEqual(Array(6).fill("assistant"));
    expect(messages[0]).toEqual({
      role: "assistant",
      text: "",
      tools: [
        {
          name: "Bash",
          input: JSON.stringify({
            command: "echo hello > hi.txt",
            description: 'Create a file with "hello" content',
          }),
          output: "(Bash completed with no output)",
        },
      ],
    });
    expect(messages[1]).toEqual({ role: "assistant", text: "DONE" });
    expect(messages[4]?.tools?.[0]?.output).toBe("User denied this fixture command.");
    expect(JSON.stringify(messages)).not.toContain("thinking");
  });

  it("keeps the main conversation only", () => {
    const messages = toSessionTranscript(recorded("p12-background-subagent"));
    expect(messages.flatMap((m) => m.tools ?? []).map((tool) => tool.name)).toEqual(["Agent"]);
    expect(messages.at(-1)).toEqual({ role: "assistant", text: "DONE" });
    expect(messages.some((m) => m.text.includes("glob patterns"))).toBe(false);
  });

  it("maps string content, system messages, image results and oversized sides", () => {
    const big = "x".repeat(TRANSCRIPT_TOOL_MAX_CHARS + 10);
    const messages = toSessionTranscript([
      entry("user", "  Look at this  "),
      entry("system", "Conversation compacted"),
      entry("assistant", [
        { type: "text", text: "Reading." },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: big } },
        { type: "tool_use", id: "t2", name: "Glob", input: {} },
      ]),
      entry("user", [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "text", text: "a" }, { type: "image" }],
        },
        { type: "tool_result", tool_use_id: "unknown", content: "orphan" },
      ]),
      entry("assistant", [{ type: "thinking", thinking: "hm" }]),
      entry("assistant", [{ type: "text", text: "inside a subagent" }], "t1"),
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ role: "user", text: "Look at this" });
    expect(messages[1]).toEqual({ role: "system", text: "Conversation compacted" });
    const [read, glob] = messages[2]!.tools!;
    expect(read!.output).toBe("a\n[image]");
    expect(read!.input!.length).toBeLessThan(TRANSCRIPT_TOOL_MAX_CHARS + 80);
    expect(read!.input).toContain("[truncated:");
    expect(glob).toEqual({ name: "Glob", input: "{}" });
  });
});
