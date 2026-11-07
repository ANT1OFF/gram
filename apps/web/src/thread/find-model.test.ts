import type { GramUIMessage } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { findMatches, stepMatch } from "./find-model";

const message = (id: string, parts: unknown[]) =>
  ({ id, role: "assistant", parts }) as unknown as GramUIMessage;

describe("findMatches", () => {
  const messages = [
    message("a", [{ type: "text", text: "Retry the Upload, then upload again" }]),
    message("b", [
      { type: "reasoning", text: "upload failed" },
      {
        type: "tool-Bash",
        toolCallId: "c1",
        state: "output-error",
        input: { command: "ls" },
        errorText: "upload: no such file",
      },
    ]),
    message("c", [{ type: "text", text: "nothing here" }]),
  ];

  it("finds each case-blind occurrence, top to bottom, numbered within its message", () => {
    const { matches, truncated } = findMatches(messages, "UPLOAD");
    expect(truncated).toBe(false);
    expect(matches.map((m) => [m.messageId, m.occurrence, m.toolCallId])).toEqual([
      ["a", 0, undefined],
      ["a", 1, undefined],
      ["b", 0, undefined],
      ["b", 1, "c1"],
    ]);
  });

  it("finds nothing for a blank query and caps what it counts", () => {
    expect(findMatches(messages, "  ").matches).toEqual([]);
    expect(findMatches(messages, "upload", 2)).toEqual({
      matches: expect.any(Array),
      truncated: true,
    });
  });

  it("steps round both ends", () => {
    expect(stepMatch(0, -1, 3)).toBe(2);
    expect(stepMatch(2, 1, 3)).toBe(0);
    expect(stepMatch(0, 1, 0)).toBe(-1);
  });
});
