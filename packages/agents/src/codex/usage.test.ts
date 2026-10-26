import { describe, expect, it } from "vitest";
import { codexCounts, makeCodexUsageLedger } from "./usage.ts";
const n = (inputTokens: number, outputTokens = 1) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
describe("Codex request deltas", () => {
  it("discards an unproven baseline without converting unknown usage to zero or session totals", () => {
    for (const last of [n(10, 1), n(0, 0), undefined]) {
      const ledger = makeCodexUsageLedger(true);
      ledger.observe(n(100, 10), n(100, 10));
      ledger.invalidateBaseline();
      ledger.startTurn();
      expect(ledger.observe(n(1110, 111), last)).toEqual(
        last === undefined
          ? { partial: true }
          : { tokens: last, basis: "last-request", partial: true },
      );
      ledger.startTurn();
      expect(ledger.observe(n(1120, 112), n(10, 1))).toEqual({
        tokens: n(10, 1),
        basis: "delta",
        partial: false,
      });
    }
  });
  it("retains explicit zero requests against unchanged nonzero session totals across new turns", () => {
    const ledger = makeCodexUsageLedger();
    ledger.observe(n(100, 10), undefined);
    for (let turn = 0; turn < 2; turn++) {
      ledger.startTurn();
      expect(ledger.observe(n(100, 10), n(0, 0))).toEqual({
        tokens: n(0, 0),
        basis: "delta",
        partial: false,
      });
      expect(ledger.observe(n(100, 10), n(0, 0))).toEqual({ partial: false });
    }
  });
  it("keeps the fresh first request and each resumed first new request", () => {
    expect(makeCodexUsageLedger(true).observe(n(10), n(10))).toEqual({
      tokens: n(10),
      basis: "delta",
      partial: false,
    });
    expect(makeCodexUsageLedger().observe(n(1010, 101), n(10))).toEqual({
      tokens: n(10),
      basis: "last-request",
      partial: true,
    });
  });
  it("distinguishes snapshot replay from two legitimate requests with identical cost", () => {
    const ledger = makeCodexUsageLedger(true);
    expect(ledger.observe(n(10), n(10)).tokens).toEqual(n(10));
    expect(ledger.observe(n(10), n(10)).tokens).toBeUndefined();
    expect(ledger.observe(n(20, 2), n(10)).tokens).toEqual(n(10));
  });
  it("does not count a session total when last usage and the baseline are absent", () => {
    const ledger = makeCodexUsageLedger();
    expect(ledger.observe(n(1000), undefined)).toEqual({ partial: true });
    expect(ledger.observe(n(1010, 2), undefined)).toEqual({
      tokens: n(10),
      basis: "delta",
      partial: false,
    });
  });
  it("handles counter reset using only an authoritative last request, not negative clamping", () => {
    const ledger = makeCodexUsageLedger(true);
    ledger.observe(n(100), n(100));
    expect(ledger.observe(n(3), n(3))).toEqual({
      tokens: n(3),
      basis: "last-request",
      partial: true,
    });
    expect(ledger.observe(n(3), n(3))).toEqual({ partial: false });
    expect(ledger.observe(n(7, 2), n(4))).toEqual({ tokens: n(4), basis: "delta", partial: false });
  });
  it("preserves missing cache fields and refuses unsafe or inconsistent counters", () => {
    expect(codexCounts({ input_tokens: 10, output_tokens: 2 }, true)).toEqual({
      inputTokens: 10,
      outputTokens: 2,
    });
    expect(
      codexCounts({ input_tokens: 10, cached_input_tokens: 11, output_tokens: 2 }, true),
    ).toBeUndefined();
    expect(
      codexCounts({ input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 2 }, true),
    ).toBeUndefined();
    expect(
      codexCounts({ input_tokens: 10, output_tokens: 2, reasoning_output_tokens: 3 }, true),
    ).toBeUndefined();
  });
});

describe("Codex baseline boundaries", () => {
  it("does not reinterpret an equal prior total as the first new turn", () => {
    const ledger = makeCodexUsageLedger();
    ledger.observe(n(100), undefined);
    ledger.startTurn();
    expect(ledger.observe(n(100), n(10))).toEqual({ partial: true });
    expect(ledger.observe(n(110, 2), n(10))).toEqual({
      tokens: n(10),
      basis: "delta",
      partial: false,
    });
  });
  it("keeps an actual fresh zero request and no ambiguous cumulative-only amount", () => {
    expect(makeCodexUsageLedger(true).observe(n(0, 0), n(0, 0))).toEqual({
      tokens: n(0, 0),
      basis: "delta",
      partial: false,
    });
    expect(makeCodexUsageLedger().observe(n(900), undefined)).toEqual({ partial: true });
  });
  it("retains one last request without totals, never adds possibly updated last snapshots", () => {
    const ledger = makeCodexUsageLedger();
    expect(ledger.observe(undefined, n(10))).toEqual({
      tokens: n(10),
      basis: "last-request",
      partial: true,
    });
    expect(ledger.observe(undefined, n(20))).toEqual({ partial: true });
    expect(ledger.observe(n(100), n(20))).toEqual({ partial: true });
    expect(ledger.observe(n(110, 2), n(10))).toEqual({
      tokens: n(10),
      basis: "delta",
      partial: false,
    });
  });
  it("rejects contradictory last totals and unsafe arithmetic before minting a basis", () => {
    const ledger = makeCodexUsageLedger(true);
    expect(ledger.observe(n(1), n(2))).toEqual({ partial: true });
    expect(ledger.observe(n(Number.MAX_SAFE_INTEGER, 1), undefined)).toEqual({ partial: true });
    expect(ledger.observe(n(10), n(10))).toEqual({
      tokens: n(10),
      basis: "last-request",
      partial: true,
    });
  });
  it("ignores nonconsecutive replay and distinguishes legitimate identical-cost requests by increased totals", () => {
    const ledger = makeCodexUsageLedger(true);
    ledger.observe(n(10), n(10));
    ledger.observe(n(20, 2), n(10));
    expect(ledger.observe(n(10), n(10))).toEqual({ partial: false });
    expect(ledger.observe(n(30, 3), n(10))).toEqual({
      tokens: n(10),
      basis: "delta",
      partial: false,
    });
    expect(ledger.observe(n(30, 3), n(5))).toEqual({ partial: false });
  });
  it("preserves equal valid zero reports on distinct native turns, while deduplicating a turn's replay", () => {
    const ledger = makeCodexUsageLedger(true);
    expect(ledger.observe(n(0, 0), n(0, 0))).toMatchObject({
      tokens: n(0, 0),
      basis: "delta",
      partial: false,
    });
    expect(ledger.observe(n(0, 0), n(0, 0))).toEqual({ partial: false });
    ledger.startTurn();
    expect(ledger.observe(n(0, 0), n(0, 0))).toMatchObject({
      tokens: n(0, 0),
      basis: "delta",
      partial: false,
    });
  });
  it("does not mint a basis once the per-turn event budget is exhausted", () => {
    const ledger = makeCodexUsageLedger(true);
    for (let i = 1; i <= 4096; i++) ledger.observe(n(i, i), n(1));
    expect(ledger.observe(n(4097, 4097), n(1))).toEqual({ partial: true });
    ledger.startTurn();
    expect(ledger.observe(n(4097, 4097), n(1))).toEqual({
      tokens: n(1),
      basis: "last-request",
      partial: true,
    });
  });
});
