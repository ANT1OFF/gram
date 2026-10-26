import type { GramUIMessage } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { messageMarkdown, turnMarkdown, turnMessages } from "./copy-markdown";

const assistant = (id: string, parts: unknown[], extra: object = {}) =>
  ({ id, role: "assistant", parts, ...extra }) as GramUIMessage;
const user = (id: string, parts: unknown[]) => ({ id, role: "user", parts }) as GramUIMessage;

const reply = assistant("a1", [
  { type: "step-start" },
  { type: "reasoning", text: "Checking the retry loop", state: "done" },
  { type: "text", text: "The loop swallows the last error:\n\n```ts\nthrow lastError;\n```" },
  {
    type: "tool-Read",
    toolCallId: "r1",
    state: "output-available",
    input: { file_path: "src/retry.ts" },
    output: { type: "text", file: {} },
  },
  {
    type: "tool-Bash",
    toolCallId: "b1",
    state: "input-available",
    input: { command: "pnpm vitest run retry\n--reporter dot", description: "Run the tests" },
  },
  {
    type: "dynamic-tool",
    toolName: "mcp__gram__list_threads",
    toolCallId: "d1",
    state: "input-available",
    input: {},
  },
  { type: "data-usage", id: "u", data: {} },
  { type: "text", text: "Fixed." },
]);

describe("messageMarkdown", () => {
  it("keeps text and code fences, puts each tool call on one line, and leaves thinking out", () => {
    expect(messageMarkdown(reply)).toBe(
      [
        "The loop swallows the last error:\n\n```ts\nthrow lastError;\n```",
        "[Read src/retry.ts]\n[Bash pnpm vitest run retry]\n[mcp__gram__list_threads]",
        "Fixed.",
      ].join("\n\n"),
    );
  });

  it("includes thinking as a quote when asked", () => {
    expect(messageMarkdown(reply, { reasoning: true })).toMatch(/^> Checking the retry loop\n\n/);
  });

  it("names attachments by file name", () => {
    const prompt = user("u1", [
      { type: "text", text: "Why does this fail?" },
      { type: "file", mediaType: "image/png", url: "file:///tmp/att/screen%20shot.png" },
      { type: "file", mediaType: "text/plain", filename: "log.txt", url: "file:///tmp/att/x" },
    ]);
    expect(messageMarkdown(prompt)).toBe(
      "Why does this fail?\n\n[Attached screen shot.png]\n[Attached log.txt]",
    );
  });
});

describe("turnMarkdown", () => {
  it("copies the prompt and every reply of the turn, skipping subagents and earlier turns", () => {
    const messages = [
      user("u0", [{ type: "text", text: "Earlier turn" }]),
      assistant("a0", [{ type: "text", text: "Earlier reply" }]),
      user("u1", [{ type: "text", text: "Fix the flake" }]),
      assistant("a1", [{ type: "text", text: "Looking" }]),
      assistant("s1", [{ type: "text", text: "subagent" }], { metadata: { parentToolUseId: "t" } }),
      assistant("a2", [{ type: "text", text: "Done" }]),
    ];
    const turn = turnMessages(messages, "a2");
    expect(turn.map((m) => m.id)).toEqual(["u1", "a1", "a2"]);
    expect(turnMarkdown(turn)).toBe(
      "**You**\n\nFix the flake\n\n**Assistant**\n\nLooking\n\n**Assistant**\n\nDone",
    );
    expect(turnMessages(messages, "missing")).toEqual([]);
  });
});
