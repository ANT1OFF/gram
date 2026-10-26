import type { GramUIMessage } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { chaptersOf, splitSubagents } from "./parts";

describe("conversation contents", () => {
  it("keeps server notice payloads behind their existing disclosures", () => {
    const noticeParts: GramUIMessage["parts"] = [
      {
        type: "data-review-notice",
        data: { kind: "review", number: 1, blockers: [], suggestions: [], ciFailed: [] },
      },
      {
        type: "data-human-review-notice",
        data: { kind: "humanReview", number: 1, reviews: [], newReviewIds: [] },
      },
      {
        type: "data-orchestration-digest",
        data: {
          kind: "orchestration",
          variant: "digest",
          generation: 1,
          workspaceId: "synthetic-workspace" as never,
          workspaceName: "Synthetic workspace",
          reasons: [],
          changes: [],
          reports: [],
          features: [],
          notes: [],
          budget: { liveWorkers: 0, maxConcurrentWorkers: 1, costUsdToday: 0 },
        },
      },
    ];
    const messages: GramUIMessage[] = noticeParts.map((part, i) => ({
      id: `notice-${i}`,
      role: "user",
      parts: [part, { type: "text", text: "HIDDEN_AGENT_CONTEXT" }],
    }));
    expect(chaptersOf(messages)).toEqual([]);
    messages[0]!.parts.push({
      type: "data-chapter",
      data: { id: "public", title: "Explicit notice chapter" },
    });
    expect(chaptersOf(messages).map((entry) => entry.title)).toEqual(["Explicit notice chapter"]);
  });
  it("offers ordinary prompts, retains explicit chapters, and isolates child lanes and hidden content", () => {
    const messages: GramUIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Compare\n SQLite   and plain files" }],
      },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Not a chapter" },
          { type: "reasoning", text: "PRIVATE_REASONING" },
          { type: "data-chapter", data: { id: "decision", title: "Storage decision" } },
          {
            type: "dynamic-tool",
            toolName: "Bash",
            toolCallId: "output",
            state: "output-available",
            input: {},
            output: "PRIVATE_TOOL_OUTPUT".repeat(100_000),
          },
        ],
      },
      {
        id: "child",
        role: "user",
        metadata: { parentToolUseId: "task" },
        parts: [{ type: "text", text: "PRIVATE_CHILD_PROMPT" }],
      },
      {
        id: "u2",
        role: "user",
        parts: [
          { type: "text", text: "This row already has a chapter" },
          { type: "data-chapter", data: { id: "named", title: "Rollback" } },
        ],
      },
    ];
    const outline = chaptersOf(splitSubagents(messages).top);
    expect(outline.map((entry) => [entry.title, entry.messageId])).toEqual([
      ["Compare SQLite and plain files", "u1"],
      ["Storage decision", "a1"],
      ["Rollback", "u2"],
    ]);
    expect(chaptersOf(messages)).toEqual(
      outline.map((entry, i) => ({ ...entry, index: i === 2 ? 3 : i })),
    );
  });

  it("uses accurate fallbacks without exposing attachment paths or nontext data", () => {
    const outline = chaptersOf([
      { id: "empty", role: "user", parts: [{ type: "text", text: " \n\t" }] },
      {
        id: "attachment",
        role: "user",
        parts: [
          {
            type: "file",
            mediaType: "image/png",
            filename: "PRIVATE_NAME",
            url: "file:///PRIVATE_PATH",
          },
        ],
      },
      { id: "data", role: "user", parts: [{ type: "data-session-restart", data: { at: 1 } }] },
      {
        id: "literal",
        role: "user",
        parts: [{ type: "text", text: '<img src=x onerror="attack()"> ' + "long ".repeat(1000) }],
      },
    ]);
    expect(outline.map((entry) => entry.title).slice(0, 3)).toEqual([
      "Empty prompt",
      "Attachment prompt",
      "Non-text prompt",
    ]);
    expect(outline[3]!.title).toMatch(/^<img src=x onerror="attack\(\)"> /);
    expect(outline[3]!.title.length).toBeLessThanOrEqual(81);
    expect(JSON.stringify(outline)).not.toMatch(/PRIVATE_NAME|PRIVATE_PATH/);
  });
});
