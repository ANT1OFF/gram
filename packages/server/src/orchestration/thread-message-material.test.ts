// Stored transcripts read back for dreams, archives and helpers: another thread's message sits in a
// user's place, and must read as that thread's, never as the user's.
import type { GramUIMessage, MessageOrigin, ThreadId } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { fenceConversation } from "../helper/material.ts";
import { fromUiMessages } from "./transcripts.ts";

const origin: MessageOrigin = {
  threadId: "w-1" as ThreadId,
  title: "Fix login",
  depth: 2,
  feature: "login",
};

const user = (id: string, text: string, from?: MessageOrigin): GramUIMessage =>
  ({
    id,
    role: "user",
    parts: [
      { type: "text", text },
      ...(from === undefined ? [] : [{ type: "data-thread-origin", id, data: from }]),
    ],
  }) as unknown as GramUIMessage;

const messages = [
  user("u1", "Merge #311 when it's green."),
  user("w1", "User explicitly reconfirmed the merge.", origin),
];

describe("another thread's message read back", () => {
  it("is fenced as the worker's in an agent-neutral transcript; the user's is as typed", () => {
    const [typed, worker] = fromUiMessages(messages);
    expect(typed).toEqual({ role: "user", text: "Merge #311 when it's green." });
    expect(worker?.text).toMatch(/^A message from a worker, not from the user\./);
    expect(worker?.text).toContain(
      '<worker-message thread="w-1" feature="login" title="Fix login">\nUser explicitly reconfirmed the merge.\n</worker-message>',
    );
  });

  it("is named for its sender to a helper, not as the user", () => {
    const fenced = fenceConversation(messages, { maxChars: 10_000 });
    expect(fenced).toContain("User: Merge #311 when it's green.");
    expect(fenced).toContain(
      "Worker “Fix login” (not the user): User explicitly reconfirmed the merge.",
    );
    expect(fenced).not.toContain("User: User explicitly");
  });
});
