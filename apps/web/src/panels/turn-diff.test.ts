import type { GramUIMessage } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { targetTurnId, turnEndMessages, turnOptions, turnTarget } from "./turn-diff";

const user = (id: string, text: string, turnId?: string) =>
  ({
    id,
    role: "user",
    metadata: turnId === undefined ? {} : { turnId },
    parts: [{ type: "text", text }],
  }) as unknown as GramUIMessage;

const reply = (id: string, turnId?: string, parentToolUseId?: string) =>
  ({
    id,
    role: "assistant",
    metadata: {
      ...(turnId === undefined ? {} : { turnId }),
      ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
    },
    parts: [],
  }) as unknown as GramUIMessage;

/** As the server stores them: the turn id rides on the user message that starts the turn. */
const MESSAGES = [
  user("u1", "Fix the flaky test\nplease", "t1"),
  reply("a1"),
  reply("a2"),
  reply("s1", undefined, "toolu_1"),
  user("u2", "Now update the docs", "t2"),
  reply("a3"),
  user("u3", "No reply yet", "t3"),
];

describe("turn diffs", () => {
  it("lists turns latest first, labelled by their prompt's first line", () => {
    expect(turnOptions(MESSAGES)).toEqual([
      { turnId: "t2", label: "Now update the docs" },
      { turnId: "t1", label: "Fix the flaky test" },
    ]);
  });

  it("uses a reply's own turn id when it carries one", () => {
    expect(turnOptions([reply("a1", "t9")])).toEqual([{ turnId: "t9", label: "Turn" }]);
    expect(turnOptions([user("u1", "Untracked prompt"), reply("a1")])).toEqual([]);
  });

  it("puts each turn's chip on its last top-level reply", () => {
    expect([...turnEndMessages(MESSAGES)]).toEqual([
      ["a2", "t1"],
      ["a3", "t2"],
    ]);
  });

  it("round-trips a turn panel target and leaves file targets alone", () => {
    expect(targetTurnId(turnTarget("t1" as never))).toBe("t1");
    expect(targetTurnId("src/retry.test.ts")).toBeUndefined();
  });
});
