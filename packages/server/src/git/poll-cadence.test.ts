import { describe, expect, it } from "vitest";
import { closestAttention, lookupEvery, type LookupCadenceInput } from "./poll-cadence.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const every = (overrides: Partial<LookupCadenceInput> = {}) =>
  lookupEvery({
    attention: "listed",
    watched: false,
    idleMs: 0,
    burst: false,
    level: "active",
    ...overrides,
  });

const open = { state: "OPEN", checks: "passing", headRefOid: "abc" } as const;

const listed = (idleMs: number) => every({ idleMs, pr: open });

describe("lookupEvery", () => {
  it("asks on every sweep about what the user is in, however long it sat before", () => {
    expect(every({ attention: "focused", idleMs: 72 * HOUR })).toBe(1);
  });

  it("lets a thread's row cool the longer it is left alone", () => {
    expect(listed(5 * MINUTE)).toBe(1);
    expect(listed(30 * MINUTE)).toBe(2);
    expect(listed(3 * HOUR)).toBe(4);
    expect(listed(12 * HOUR)).toBe(12);
    expect(listed(72 * HOUR)).toBe(40);
  });

  it("keeps a pane that is showing warmer than a row", () => {
    expect(every({ attention: "shown", idleMs: 72 * HOUR })).toBe(4);
    expect(every({ attention: "shown", idleMs: MINUTE })).toBe(1);
  });

  it("asks on every sweep while GitHub is about to say something", () => {
    const stale = { idleMs: 72 * HOUR };
    expect(every({ ...stale, pr: { ...open, checks: "pending" } })).toBe(1);
    expect(every({ ...stale, burst: true })).toBe(1);
    const round = { bots: [], reviewedHead: false, roundInFlight: true, threads: NO_THREADS };
    expect(every({ ...stale, pr: { ...open, review: round } })).toBe(1);
  });

  it("stops asking about a PR merged at the checkout's own HEAD, until HEAD moves", () => {
    const merged = { ...open, state: "MERGED" } as const;
    expect(every({ attention: "focused", pr: merged, head: "abc" })).toBe(Number.POSITIVE_INFINITY);
    expect(every({ attention: "focused", pr: merged, head: "def" })).toBe(1);
    // A push or a rerun on it is still followed.
    expect(every({ pr: merged, head: "abc", burst: true })).toBe(1);
    // As is a PR its thread follows beside it that is still open: only a lookup sees it merge.
    expect(every({ attention: "focused", pr: merged, head: "abc", followsOpen: true })).toBe(1);
  });

  it("asks about a closed PR rarely, since it can be reopened", () => {
    expect(every({ attention: "focused", pr: { ...open, state: "CLOSED" }, head: "abc" })).toBe(20);
  });

  it("leaves what nobody can see alone, but for a watch", () => {
    expect(every({ attention: "hidden" })).toBe(Number.POSITIVE_INFINITY);
    expect(every({ attention: "hidden", watched: true })).toBe(12);
    expect(every({ attention: "hidden", watched: true, level: "idle" })).toBe(3);
  });

  it("never lets a watched thread cool past a minute", () => {
    expect(every({ watched: true, idleMs: 72 * HOUR })).toBe(4);
    expect(every({ watched: true, idleMs: MINUTE })).toBe(1);
  });
});

const NO_THREADS = { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 };

describe("closestAttention", () => {
  it("takes a checkout to be as watched as its most-watched thread", () => {
    expect(closestAttention(["listed", "focused", "hidden"])).toBe("focused");
    expect(closestAttention(["hidden", "listed"])).toBe("listed");
    expect(closestAttention([])).toBe("hidden");
  });
});
