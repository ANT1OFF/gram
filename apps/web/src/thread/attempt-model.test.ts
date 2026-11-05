import type { GramUIMessage, ThreadError, TurnId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { attemptsOf, errorKey, retryHiddenOf, stopOf } from "./attempt-model";

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
      of: 2,
      retried: {
        messageId: "u2",
        at: 20,
        failed: false,
        latestMessageId: "u2",
        latestFailed: false,
        recovered: false,
      },
      folded: false,
      earlier: [],
    });
  });

  it("calls the turn recovered once the retry's reply ends completed", () => {
    const facts = attemptsOf([
      user("u1", "Run the suite", 1, "t1"),
      failed("e1", first),
      user("u2", "Run the suite", 20),
      reply("a2", { turnEnd: { at: 30, reason: "completed" } }),
    ]).get(errorKey(first));
    expect(facts?.retried?.recovered).toBe(true);
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
    // One card for the run: the newest failure's, listing the two before it; theirs fold away.
    expect(facts.get(errorKey(third))).toEqual({
      attempt: 3,
      of: 3,
      retried: undefined,
      folded: false,
      earlier: [
        { attempt: 1, error: first },
        { attempt: 2, error: second },
      ],
    });
    expect(facts.get(errorKey(first))?.folded).toBe(true);
    expect(facts.get(errorKey(second))?.folded).toBe(true);
  });

  it("keeps the last failure's card as the receipt when a later retry went through", () => {
    const second = failure(30);
    const facts = attemptsOf([
      user("u1", "Run the suite", 1, "t1"),
      failed("e1", first),
      user("u2", "Run the suite", 20),
      failed("e2", second),
      user("u3", "Run the suite", 40),
      reply("a3", { turnEnd: { at: 50, reason: "completed" } }),
    ]);
    expect(facts.get(errorKey(first))?.folded).toBe(true);
    expect(facts.get(errorKey(second))).toMatchObject({
      attempt: 2,
      of: 3,
      folded: false,
      earlier: [{ attempt: 1, error: first }],
      retried: { messageId: "u3", failed: false, recovered: true },
    });
  });

  it("doesn't call different words a retry", () => {
    const facts = attemptsOf([
      user("u1", "Run the suite", 1, "t1"),
      failed("e1", first),
      user("u2", "Skip the e2e part", 20),
      reply("a2"),
    ]);
    expect(facts.get(errorKey(first))).toEqual({
      attempt: 1,
      of: 1,
      retried: undefined,
      folded: false,
      earlier: [],
    });
  });
});

describe("retryHiddenOf", () => {
  const first = failure(10, "t1");

  it("leaves out each retry's repeated words and a reply that is only a folded failure", () => {
    const second = failure(30);
    expect([
      ...retryHiddenOf([
        user("u1", "Run the suite", 1, "t1"),
        failed("e1", first),
        user("u2", "Run the suite", 20),
        failed("e2", second),
      ]),
    ]).toEqual(["u2", "e1"]);
  });

  it("keeps a reply that said something before it failed, and the receipt of a retry that worked", () => {
    const second = failure(30);
    const worked: GramUIMessage = {
      id: "e1",
      role: "assistant",
      parts: [
        { type: "text", text: "Reading the tests.", state: "done" },
        { type: "data-agent-error", id: "x", data: first },
      ],
    };
    expect([
      ...retryHiddenOf([
        user("u1", "Run the suite", 1, "t1"),
        worked,
        user("u2", "Run the suite", 20),
        failed("e2", second),
      ]),
    ]).toEqual(["u2"]);
    expect([
      ...retryHiddenOf([
        user("u1", "Run the suite", 1, "t1"),
        failed("e1", first),
        user("u2", "Run the suite", 20),
        reply("a2"),
      ]),
    ]).toEqual(["u2"]);
  });

  it("hides nothing without a retry", () => {
    expect(retryHiddenOf([user("u1", "Run the suite", 1, "t1"), failed("e1", first)]).size).toBe(0);
    expect(
      retryHiddenOf([
        user("u1", "Run the suite", 1, "t1"),
        failed("e1", first),
        user("u2", "Something else", 20),
      ]).size,
    ).toBe(0);
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
