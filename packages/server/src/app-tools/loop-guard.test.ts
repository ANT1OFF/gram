import { describe, expect, it } from "@effect/vitest";
import type { MessageOrigin, ThreadId } from "@gram/contracts";
import { checkSend, MAX_CHAIN_DEPTH, SENDS_PER_MINUTE, type SendCheck } from "./loop-guard.ts";

const A = "thread-a" as ThreadId;
const B = "thread-b" as ThreadId;
const C = "thread-c" as ThreadId;

const origin = (threadId: ThreadId, depth: number): MessageOrigin => ({
  threadId,
  title: `Thread ${threadId}`,
  depth,
});

const check = (overrides: Partial<SendCheck> = {}): SendCheck => ({
  caller: A,
  target: B,
  callerOrigin: undefined,
  targetInputs: [{}],
  recentSends: [],
  now: 100_000,
  ...overrides,
});

describe("checkSend", () => {
  it("lets a user-driven thread send at depth 1 and records the send", () => {
    expect(checkSend(check())).toEqual({ ok: true, depth: 1, recentSends: [100_000] });
  });

  it("refuses self-sends", () => {
    expect(checkSend(check({ target: A }))).toMatchObject({
      ok: false,
      reason: "A thread can't send a message to itself.",
    });
  });

  it("allows A → B → C and stops C from sending on", () => {
    expect(checkSend(check({ caller: B, target: C, callerOrigin: origin(A, 1) }))).toMatchObject({
      ok: true,
      depth: 2,
    });
    const refused = checkSend(
      check({ caller: C, target: A, callerOrigin: origin(B, MAX_CHAIN_DEPTH) }),
    );
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? "" : refused.reason).toContain("stop after 2 hops");
  });

  it("refuses a back-to-back send until someone else writes to the target", () => {
    const sentByA = [{}, { origin: origin(A, 1) }];
    expect(checkSend(check({ targetInputs: sentByA }))).toMatchObject({ ok: false });
    expect(checkSend(check({ targetInputs: [...sentByA, {}] }))).toMatchObject({ ok: true });
    expect(
      checkSend(check({ targetInputs: [...sentByA, { origin: origin(C, 1) }] })),
    ).toMatchObject({ ok: true });
  });

  it("limits sends per minute and names the wait", () => {
    const now = 100_000;
    const full = Array.from({ length: SENDS_PER_MINUTE }, (_, i) => now - 50_000 + i * 1_000);
    const refused = checkSend(check({ recentSends: full, now }));
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? "" : refused.reason).toBe(
      "send_message allows 5 messages a minute per thread; try again in 10s.",
    );
    expect(checkSend(check({ recentSends: full, now: now + 10_000 }))).toMatchObject({
      ok: true,
      recentSends: [...full.slice(1), now + 10_000],
    });
  });
});
