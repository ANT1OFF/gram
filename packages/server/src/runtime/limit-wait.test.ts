import { describe, expect, it } from "@effect/vitest";
import type { LimitWait, ThreadId } from "@gram/contracts";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_DELAY_MS,
  backoffDelay,
  classifyLimit,
  earlyReleaseDue,
  LIMIT_EARLY_GAP_MAX_MS,
  LIMIT_EARLY_GAP_MS,
  LIMIT_FRESH_MS,
  limitClearedBy,
  LIMIT_RESUME_BATCH_GAP_MS,
  LIMIT_RESUME_DELAY_MS,
  LIMIT_RESUME_JITTER_MS,
  limitResetAt,
  limitTurnedOver,
  releaseBatchAt,
  resumePlan,
  windowsOf,
} from "./limit-wait.ts";
import { LIMIT_SAME_WINDOW_MS } from "@gram/contracts";

// 11:00 in Oslo (CEST, UTC+2).
const NOW = Date.parse("2026-10-15T09:00:00Z");

describe("limitResetAt", () => {
  it("reads Claude Code's session limit in the zone it names", () => {
    expect(
      limitResetAt("You've hit your session limit · resets 12:50pm (Europe/Oslo)", NOW, "UTC"),
    ).toBe(Date.parse("2026-10-15T10:50:00Z"));
  });

  it("reads a reset in another zone than the machine's, across midnight", () => {
    // 23:26 in Oslo, 22:26 in London: Claude Code names London's 1:40am, which is tomorrow's.
    const late = Date.parse("2026-10-20T21:26:00Z");
    const text = "You've hit your session limit · resets 1:40am (Europe/London)";
    expect(limitResetAt(text, late, "Europe/Oslo")).toBe(Date.parse("2026-10-21T00:40:00Z"));
    expect(limitResetAt(text, late, "Europe/London")).toBe(Date.parse("2026-10-21T00:40:00Z"));
  });

  it("takes a time already past today as tomorrow's", () => {
    const later = Date.parse("2026-10-15T11:30:00Z");
    expect(limitResetAt("Session limit reached ∙ resets 12:50pm (Europe/Oslo)", later)).toBe(
      Date.parse("2026-10-16T10:50:00Z"),
    );
  });

  it("reads a dated weekly reset and a bare hour in the machine's zone", () => {
    expect(
      limitResetAt("Weekly limit reached ∙ resets Oct 17, 10am (Europe/Oslo)", NOW, "UTC"),
    ).toBe(Date.parse("2026-10-17T08:00:00Z"));
    expect(limitResetAt("5-hour limit reached ∙ resets 3pm", NOW, "Europe/Oslo")).toBe(
      Date.parse("2026-10-15T13:00:00Z"),
    );
  });

  it("reads Codex's clock time, its dated form and its older span", () => {
    expect(
      limitResetAt("You've hit your usage limit. Try again at 3:05 PM.", NOW, "Europe/Oslo"),
    ).toBe(Date.parse("2026-10-15T13:05:00Z"));
    expect(
      limitResetAt("You've hit your usage limit. Try again at Oct 16th, 2026 3:05 PM.", NOW, "UTC"),
    ).toBe(Date.parse("2026-10-16T15:05:00Z"));
    expect(limitResetAt("usage limit reached, try again in 2 hours 5 minutes", NOW)).toBe(
      NOW + (2 * 60 + 5) * 60_000,
    );
  });

  it("reads Claude's older epoch form", () => {
    expect(limitResetAt("Claude AI usage limit reached|1792058400", NOW)).toBe(1792058400 * 1000);
  });

  it("names no reset for text without one, a bare count, or one far off", () => {
    expect(limitResetAt("Too many requests", NOW)).toBeUndefined();
    expect(limitResetAt("You've hit your usage limit. Try again later.", NOW)).toBeUndefined();
    expect(limitResetAt("the counter resets 5 times", NOW)).toBeUndefined();
    expect(limitResetAt("Claude AI usage limit reached|1000000000", NOW)).toBeUndefined();
  });

  it("names no reset for one that has just gone by, rather than one now or tomorrow", () => {
    // 12:51 in Oslo: "resets 12:50pm" is the reset that just passed.
    const after = Date.parse("2026-10-15T10:51:00Z");
    expect(limitResetAt("resets 12:50pm (Europe/Oslo)", after)).toBeUndefined();
    expect(limitResetAt("Claude AI usage limit reached|1792061400", after)).toBeUndefined();
    expect(
      classifyLimit(
        { kind: "rateLimit", httpStatus: 429, retryable: true },
        "resets 12:50pm (Europe/Oslo)",
        after,
        undefined,
      ),
    ).toEqual({ kind: "backoff" });
  });
});

describe("classifyLimit", () => {
  const rate = { kind: "rateLimit", httpStatus: 429, retryable: true } as const;

  it("tells a limit with a reset, a bare 429 and any other failure apart", () => {
    expect(classifyLimit(rate, "resets 12:50pm (Europe/Oslo)", NOW, undefined)).toEqual({
      kind: "limit",
      resetsAt: Date.parse("2026-10-15T10:50:00Z"),
    });
    expect(classifyLimit(rate, "Too many requests", NOW, undefined)).toEqual({ kind: "backoff" });
    expect(classifyLimit({ kind: "auth", retryable: false }, "resets 3pm", NOW, undefined)).toBe(
      undefined,
    );
    expect(classifyLimit({ kind: "gatewayRefused", retryable: false }, "", NOW, undefined)).toBe(
      undefined,
    );
  });

  it("reads the reset already waited out as the same one, never tomorrow's", () => {
    const waitedOut = Date.parse("2026-10-15T10:50:00Z");
    const later = Date.parse("2026-10-15T11:05:00Z");
    expect(
      classifyLimit(rate, "resets 12:50pm (Europe/Oslo)", later, undefined, "UTC", waitedOut),
    ).toEqual({
      kind: "backoff",
    });
    // A rejected reading no later than it isn't new either, even for a final usage limit.
    const usage = { kind: "rateLimit", code: "usageLimitExceeded", retryable: false } as const;
    expect(classifyLimit(usage, "Try again later.", later, waitedOut, "UTC", waitedOut)).toEqual({
      kind: "backoff",
    });
    // A genuinely new reset rolls forward.
    expect(
      classifyLimit(rate, "resets 5:50pm (Europe/Oslo)", later, undefined, "UTC", waitedOut),
    ).toEqual({
      kind: "limit",
      resetsAt: Date.parse("2026-10-15T15:50:00Z"),
    });
  });

  it("waits for the weekly rejection even when the error names a sooner session reset", () => {
    const weekly = NOW + 7 * 24 * 3_600_000;
    expect(classifyLimit(rate, "Try again in 2 hours", NOW, weekly)).toEqual({
      kind: "limit",
      resetsAt: weekly,
    });
  });

  it("waits for its own reset, not a later one other threads on the account wait for", () => {
    // A weekly reset a sibling still waits for, though it may since have lifted.
    const weekly = Date.parse("2026-10-19T20:00:00Z");
    expect(
      classifyLimit(rate, "resets 12:50pm (Europe/Oslo)", NOW, undefined, "UTC", undefined, weekly),
    ).toEqual({ kind: "limit", resetsAt: Date.parse("2026-10-15T10:50:00Z") });
    // With nothing of its own to go on, the siblings' reset stands in.
    expect(
      classifyLimit(rate, "Too many requests", NOW, undefined, "UTC", undefined, weekly),
    ).toEqual({ kind: "limit", resetsAt: weekly });
  });

  it("takes the account's rejected reading when the text names no reset", () => {
    const usage = { kind: "rateLimit", code: "usageLimitExceeded", retryable: false } as const;
    expect(classifyLimit(usage, "Try again later.", NOW, NOW + 3_600_000)).toEqual({
      kind: "limit",
      resetsAt: NOW + 3_600_000,
    });
    expect(classifyLimit(usage, "Try again later.", NOW, undefined)).toEqual({
      kind: "limit",
      resetsAt: undefined,
    });
  });
});

const wait = (since: number): LimitWait => ({
  kind: "limit",
  account: "claude/",
  resetsAt: NOW,
  resumeAt: NOW,
  since,
  attempt: 0,
});

describe("resume timing", () => {
  it("resumes the orchestrator first, then workers in bounded batches", () => {
    const workers = ["w1", "w2", "w3", "w4", "w5"].map((id, i) => ({
      threadId: id as ThreadId,
      wait: wait(i),
      orchestrator: false,
    }));
    const plan = resumePlan(
      [...workers, { threadId: "o" as ThreadId, wait: wait(9), orchestrator: true }],
      NOW,
    );
    const offset = (id: string) => plan.get(id as ThreadId)! - NOW - LIMIT_RESUME_DELAY_MS;
    expect(offset("o")).toBeLessThanOrEqual(LIMIT_RESUME_JITTER_MS);
    for (const id of ["w1", "w2", "w3"]) {
      expect(offset(id) - LIMIT_RESUME_BATCH_GAP_MS).toBeGreaterThanOrEqual(0);
      expect(offset(id) - LIMIT_RESUME_BATCH_GAP_MS).toBeLessThanOrEqual(LIMIT_RESUME_JITTER_MS);
    }
    for (const id of ["w4", "w5"]) {
      expect(offset(id) - 2 * LIMIT_RESUME_BATCH_GAP_MS).toBeGreaterThanOrEqual(0);
    }
  });

  it("doubles a backoff up to its cap", () => {
    const id = "t" as ThreadId;
    expect(backoffDelay(id, 1)).toBeGreaterThanOrEqual(BACKOFF_BASE_MS);
    expect(backoffDelay(id, 2) - backoffDelay(id, 1)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelay(id, 20)).toBe(backoffDelay(id, 10));
    expect(backoffDelay(id, 20)).toBeLessThanOrEqual(BACKOFF_MAX_DELAY_MS + 5000);
  });
});

/** One window of Claude's own login, read at `at`. */
const read = (utilization: number, at: number, extra: Record<string, unknown> = {}) => ({
  agent: "claude",
  window: "five_hour",
  status: "allowed",
  utilization,
  at,
  ...extra,
});

describe("limitClearedBy", () => {
  const HIT = NOW - 10 * 60_000;

  it("clears on a fresh reading, since the limit, of every window below it", () => {
    expect(
      limitClearedBy([read(0.16, NOW - 1000), read(0.01, NOW - 1000)], "claude/", HIT, NOW),
    ).toBe(true);
  });

  it("holds while any window is full or rejected, however low the others", () => {
    expect(limitClearedBy([read(0.16, NOW), read(1, HIT - 1)], "claude/", HIT, NOW)).toBe(false);
    expect(limitClearedBy([read(0.2, NOW, { status: "rejected" })], "claude/", HIT, NOW)).toBe(
      false,
    );
  });

  it("clears a full window that credits carry on past", () => {
    expect(limitClearedBy([read(1, NOW, { credits: true })], "claude/", HIT, NOW)).toBe(true);
  });

  it("holds on no reading, one from before the limit, or one too old to say", () => {
    expect(limitClearedBy([], "claude/", HIT, NOW)).toBe(false);
    expect(limitClearedBy([read(0.1, HIT - 1)], "claude/", HIT, NOW)).toBe(false);
    expect(
      limitClearedBy(
        [read(0.1, NOW - LIMIT_FRESH_MS - 1)],
        "claude/",
        NOW - 2 * LIMIT_FRESH_MS,
        NOW,
      ),
    ).toBe(false);
  });

  it("reads only the account's own login", () => {
    expect(limitClearedBy([read(0.1, NOW, { agent: "codex" })], "claude/", HIT, NOW)).toBe(false);
    expect(limitClearedBy([read(0.1, NOW, { profileId: "gw" })], "claude/", HIT, NOW)).toBe(false);
  });
});

describe("earlyReleaseDue", () => {
  it("releases at once the first time, then further apart, up to the cap", () => {
    expect(earlyReleaseDue(undefined)).toBe(-Infinity);
    expect(earlyReleaseDue({ at: NOW, count: 1 })).toBe(NOW + LIMIT_EARLY_GAP_MS);
    expect(earlyReleaseDue({ at: NOW, count: 2 })).toBe(NOW + 2 * LIMIT_EARLY_GAP_MS);
    expect(earlyReleaseDue({ at: NOW, count: 20 })).toBe(NOW + LIMIT_EARLY_GAP_MAX_MS);
  });
});

describe("limitTurnedOver", () => {
  const RESET = NOW + 4 * 3_600_000;
  const WEEK = NOW + 5 * 86_400_000;
  const released = (at: number) => ({
    at,
    count: 3,
    windows: windowsOf(
      [read(0.97, at, { resetsAt: RESET }), read(0.4, at, { window: "seven_day", resetsAt: WEEK })],
      "claude/",
    ),
  });

  it("sees another login's windows, or a window reset early, read since the last release", () => {
    const last = released(NOW - 3 * 60_000);
    // Another account: its 5-hour window resets an hour later than the one released on.
    expect(
      limitTurnedOver([read(0, NOW, { resetsAt: RESET + 3_600_000 })], "claude/", last, NOW),
    ).toBe(true);
    // The weekly window, reset early: a week from now, not the old reset.
    expect(
      limitTurnedOver(
        [
          read(0.97, NOW, { resetsAt: RESET }),
          read(0, NOW, { window: "seven_day", resetsAt: NOW + 7 * 86_400_000 }),
        ],
        "claude/",
        last,
        NOW,
      ),
    ).toBe(true);
  });

  it("holds the same windows, a reset that drifted a little, and stale or unknown readings", () => {
    const last = released(NOW - 3 * 60_000);
    expect(limitTurnedOver([read(0.2, NOW, { resetsAt: RESET })], "claude/", last, NOW)).toBe(
      false,
    );
    expect(
      limitTurnedOver(
        [read(0.2, NOW, { resetsAt: RESET + LIMIT_SAME_WINDOW_MS })],
        "claude/",
        last,
        NOW,
      ),
    ).toBe(false);
    // Read before the release, or too long ago to say anything now.
    const turned = { resetsAt: RESET + 3_600_000 };
    expect(limitTurnedOver([read(0, last.at - 1, turned)], "claude/", last, NOW)).toBe(false);
    expect(
      limitTurnedOver(
        [read(0, NOW - LIMIT_FRESH_MS - 1, turned)],
        "claude/",
        released(NOW - 2 * LIMIT_FRESH_MS),
        NOW,
      ),
    ).toBe(false);
    // No reset now, a window the release never read, another login, or no release at all.
    expect(limitTurnedOver([read(0, NOW)], "claude/", last, NOW)).toBe(false);
    expect(
      limitTurnedOver(
        [read(0, NOW, { window: "seven_day_opus", ...turned })],
        "claude/",
        last,
        NOW,
      ),
    ).toBe(false);
    expect(
      limitTurnedOver([read(0, NOW, { profileId: "gw", ...turned })], "claude/", last, NOW),
    ).toBe(false);
    expect(limitTurnedOver([read(0, NOW, turned)], "claude/", undefined, NOW)).toBe(false);
  });
});

describe("releaseBatchAt", () => {
  it("lets three go at once, then each next three a batch gap on", () => {
    expect([0, 1, 2, 3, 5, 6].map((index) => releaseBatchAt(index, NOW) - NOW)).toEqual([
      0,
      0,
      0,
      LIMIT_RESUME_BATCH_GAP_MS,
      LIMIT_RESUME_BATCH_GAP_MS,
      2 * LIMIT_RESUME_BATCH_GAP_MS,
    ]);
  });
});
