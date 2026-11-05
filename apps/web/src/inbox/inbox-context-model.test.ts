import type { GramUIMessage } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { CONTEXT_TURNS, inboxContextOf } from "./inbox-context-model";

const text = (id: string, role: "user" | "assistant", words: string): GramUIMessage =>
  ({ id, role, parts: [{ type: "text", text: words }] }) as GramUIMessage;

const edit = (id: string, path: string): GramUIMessage =>
  ({
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-Edit",
        toolCallId: id,
        state: "output-available",
        input: { file_path: path, old_string: "a", new_string: "b\nc" },
        output: "",
      },
    ],
  }) as GramUIMessage;

describe("inboxContextOf", () => {
  it("keeps the latest turns that say something, oldest first", () => {
    const messages = [
      text("m1", "user", "Fix the flaky retry test."),
      text("m2", "assistant", "Looking at the timers."),
      edit("m3", "src/retry.ts"),
      text("m4", "assistant", "It passes  20/20\n\nnow."),
      text("m5", "user", "Push it."),
      text("m6", "assistant", "I'd like to push the branch."),
    ];
    const context = inboxContextOf(messages);
    expect(context.turns).toHaveLength(CONTEXT_TURNS);
    expect(context.turns.map((turn) => turn.id)).toEqual(["m2", "m4", "m5", "m6"]);
    // One paragraph: runs of space and line breaks fold to one space.
    expect(context.turns[1]).toEqual({ id: "m4", role: "assistant", text: "It passes 20/20 now." });
  });

  it("cuts a long turn short and sums what the edits changed", () => {
    const long = "word ".repeat(200);
    const context = inboxContextOf([
      text("m1", "assistant", long),
      edit("m2", "src/a.ts"),
      edit("m3", "src/b.ts"),
      edit("m4", "src/a.ts"),
    ]);
    expect(context.turns[0]!.text.endsWith("…")).toBe(true);
    expect(context.turns[0]!.text.length).toBeLessThanOrEqual(320);
    expect(context.files).toBe(2);
    expect(context.additions).toBeGreaterThan(0);
    expect(context.deletions).toBeGreaterThan(0);
  });

  it("is empty for a thread with nothing loaded", () => {
    expect(inboxContextOf([])).toEqual({ turns: [], files: 0, additions: 0, deletions: 0 });
  });
});
