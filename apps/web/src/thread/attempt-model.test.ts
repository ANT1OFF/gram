import type { GramUIMessage, ThreadError, TurnId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { attemptsOf, errorKey, stopOf } from "./attempt-model";

const user = (id: string, text: string, createdAt?: number, turnId?: string): GramUIMessage => ({
  id,
  role: "user",
  metadata: {
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(turnId === undefined ? {} : { turnId: turnId as TurnId }),
  },
  parts: [{ type: "text", text }],
});

const failure = (at: number, turnId?: string): ThreadError => ({
  kind: "rateLimit",
  retryable: true,
  text: "Rate limited.",
  at,
  ...(turnId === undefined ? {} : { turnId: turnId as TurnId }),
});

const failed = (id: string, error: ThreadError): GramUIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "data-agent-error", id, data: error }],
});

const reply = (id: string, turnEnd?: GramUIMessage["metadata"]): GramUIMessage => ({
  id,
  role: "assistant",
  ...(turnEnd === undefined ? {} : { metadata: turnEnd }),
  parts: [{ type: "text", text: "Done.", state: "done" }],
});

describe("attemptsOf", () => {
  const first = failure(10, "t1");

  it("marks a failed turn retried once the same words go again, pointing at that attempt", () => {
    const facts = attemptsOf([
      user("u1", "Run the suite", 1, "t1"),
      failed("e1", first),
      user("u2", "Run the suite", 20),
      reply("a2"),
    ]).get(errorKey(first));
    expect(facts).toEqual({
      attempt: 1,
      retried: {
        messageId: "u2",
        at: 20,
        failed: false,
        latestMessageId: "u2",
        latestFailed: false,
      },
    });
  });

  it("says which attempt needs action when the retries failed too", () => {
    const second = failure(30);
    const third = failure(50);
    const facts = attemptsOf([
      user("u1", "Run the suite", 1, "t1"),
      failed("e1", first),
      user("u2", "Run the suite", 20),
      failed("e2", second),
      user("u3", "Run the suite", 40),
      failed("e3", third),
    ]);
    expect(facts.get(errorKey(first))?.retried).toMatchObject({
      messageId: "u2",
      failed: true,
      latestMessageId: "u3",
      latestFailed: true,
    });
    expect(facts.get(errorKey(second))).toMatchObject({ attempt: 2, retried: { messageId: "u3" } });
    expect(facts.get(errorKey(third))).toEqual({ attempt: 3, retried: undefined });
  });

  it("doesn't call different words a retry", () => {
    const facts = attemptsOf([
      user("u1", "Run the suite", 1, "t1"),
      failed("e1", first),
      user("u2", "Skip the e2e part", 20),
      reply("a2"),
    ]);
    expect(facts.get(errorKey(first))).toEqual({ attempt: 1, retried: undefined });
  });
});

const interrupted = (at: number) => ({ turnEnd: { at, reason: "interrupted" as const } });

describe("stopOf", () => {
  it("is the user's stop when they pressed Stop just before the turn ended interrupted", () => {
    expect(stopOf([user("u1", "Go", 1), reply("a1", interrupted(105))], 100)).toEqual({
      at: 105,
      byYou: true,
    });
  });

  it("reads as a stop without saying who when nobody pressed Stop here", () => {
    expect(stopOf([user("u1", "Go", 1), reply("a1", interrupted(105))], undefined)).toEqual({
      at: 105,
      byYou: false,
    });
  });

  it("is the user's stop before any reply came", () => {
    expect(stopOf([user("u1", "Go", 1)], 100)).toEqual({ at: 100, byYou: true });
  });

  it("is gone once something follows, or when the turn ended any other way", () => {
    expect(
      stopOf([user("u1", "Go", 1), reply("a1", interrupted(105)), user("u2", "Again", 200)], 100),
    ).toBeUndefined();
    expect(
      stopOf(
        [user("u1", "Go", 1), reply("a1", { turnEnd: { at: 105, reason: "completed" } })],
        100,
      ),
    ).toBeUndefined();
    // A Stop pressed before the latest message went belongs to an earlier turn.
    expect(stopOf([user("u1", "Go", 300)], 100)).toBeUndefined();
  });
});
