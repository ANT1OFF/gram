import { expect, it, vi } from "vitest";
import { makeCodexUsageLedger } from "@gram/agents/codex";
import type * as Coverage from "./codex-history-coverage.ts";

const { visits } = vi.hoisted(() => ({ visits: { allocations: 0, scopes: 0 } }));
vi.mock("./codex-history-coverage.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof Coverage>();
  return {
    ...actual,
    makeCodexHistoryCoverage: () => {
      const coverage = actual.makeCodexHistoryCoverage();
      return {
        ...coverage,
        allocationCovered: (...args: Parameters<typeof coverage.allocationCovered>) => {
          visits.allocations++;
          return coverage.allocationCovered(...args);
        },
        scopeCovered: (...args: Parameters<typeof coverage.scopeCovered>) => {
          visits.scopes++;
          return coverage.scopeCovered(...args);
        },
      };
    },
  };
});
import { makeHistoryReducer } from "./history-records.ts";
import { canonicalHistory } from "./history-canonical.ts";

const counts = (inputTokens: number, cacheReadTokens: number) => ({
  inputTokens,
  outputTokens: 0,
  cacheReadTokens,
});
const at = "2026-10-06T12:00:00Z";
const old = "2026-09-01T12:00:00Z";
const c = (input_tokens: number, cached_input_tokens?: number) => ({
  input_tokens,
  output_tokens: 0,
  ...(cached_input_tokens === undefined ? {} : { cached_input_tokens }),
});
const event = (type: string, payload: object, timestamp = at) => ({ type, payload, timestamp });
const ctx = (turn_id: string, model = "actual", timestamp = at) =>
  event("turn_context", { turn_id, model }, timestamp);
const token = (total: object, last?: object, timestamp = at) =>
  event(
    "event_msg",
    { type: "token_count", info: { total_token_usage: total, last_token_usage: last } },
    timestamp,
  );
const done = (turn_id: string, timestamp = at) =>
  event("event_msg", { type: "task_complete", turn_id }, timestamp);
const response = (
  turn_id: string,
  response_id: string,
  usage: object,
  expected: object,
  timestamp = at,
) =>
  event(
    "token_usage_record",
    { thread_id: "session", turn_id, response_id, usage, turn_token_usage: expected },
    timestamp,
  );
const setup = () => {
  const r = makeHistoryReducer("codex");
  r.consume(event("session_meta", { id: "session" }));
  r.consume(token(c(0, 0)));
  return r;
};

it("incremental same-scope admissions and unchanged getter reads have linear delegated work", () => {
  visits.allocations = visits.scopes = 0;
  const r = setup();
  r.consume(ctx("known"));
  for (let i = 1; i <= 512; i++) {
    r.consume(token(c(i, 0), c(1, 0)));
    expect(r.records.get("known")?.tokens.inputTokens).toBe(i);
  }
  const before = { ...visits };
  for (let i = 0; i < 512; i++) expect(r.records.get("known")?.tokens.inputTokens).toBe(512);
  expect(visits).toEqual(before);
  expect(visits.allocations + visits.scopes).toBeLessThanOrEqual(2_048);
});

for (const earlyGetter of [false, true])
  it(`future cap/work refusal preserves admitted prefix even with deferred getter=${!earlyGetter}`, () => {
    const r = setup();
    r.consume(ctx("known"));
    r.consume(token(c(100, 0), c(1, 0)));
    r.consume(done("known"));
    if (earlyGetter) expect(r.records.get("known")?.tokens.inputTokens).toBe(100);
    for (let i = 0; i < 50_000; i++) r.consume(ctx(`future-${i}`));
    for (let i = 0; i < 20; i++) expect(r.records.get("known")?.tokens.inputTokens).toBe(100);
    expect(r.nativeOverflow).toBe(true);
  });

for (const late of [false, true])
  for (const firstMissing of [false, true])
    it(`late preceding lane requirements retain positive evidence: late=${late}, firstMissing=${firstMissing}`, () => {
      const r = makeHistoryReducer("codex", Date.parse(at), Infinity);
      const rows = [
        event("session_meta", { id: "session" }, old),
        token(c(1_000, 900), undefined, old),
        ctx("old", "old-model", old),
        token(c(1_100, 900), c(100, 0), old),
        response("old", "r1", c(100, firstMissing ? undefined : 80), c(100, 80), old),
        ...(!late
          ? [response("old", "r2", c(100, firstMissing ? 80 : undefined), c(200, 80), old)]
          : []),
        token(c(1_200, 900), c(100, 0), old),
        done("old", old),
        ctx("new"),
        token(c(1_300, 990), c(100, 10)),
        done("new"),
        ...(late
          ? [response("old", "r2", c(100, firstMissing ? 80 : undefined), c(200, 80), old)]
          : []),
      ];
      rows.forEach((row) => r.consume(row));
      for (let i = 0; i < 20; i++)
        expect(r.records.get("new")).toMatchObject({
          tokens: { inputTokens: 100, cacheReadTokens: 10 },
          partial: true,
          basis: "last-request",
        });
    });

it("unsafe addition and omitted modern conflict preserve a safe Unknown prefix on repeated reads", () => {
  const r = setup(),
    max = Number.MAX_SAFE_INTEGER - 1;
  [
    ctx("known", "A"),
    token(c(max, 0), c(max, 0)),
    response("known", "r1", c(max, 0), c(max, 0)),
    ctx("known", "B"),
    response("known", "r1", c(max, 0), c(max, 0)),
    token(c(10, 0), c(10, 0)),
    done("known"),
  ].forEach((row) => r.consume(row));
  const invalid = r.invalid;
  for (let i = 0; i < 20; i++) {
    const rows = [...canonicalHistory([...r.records.values()]).unique.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tokens: { inputTokens: max },
      model: null,
      modelConflict: true,
    });
    expect(r.invalid).toBe(invalid);
  }
});

it("cache refinement keeps once-only primary usage then admits an actual equal-cost increment and known zero", () => {
  const ledger = makeCodexUsageLedger(true);
  ledger.startTurn();
  expect(ledger.observe(counts(10, 0), counts(10, 0)).tokens?.inputTokens).toBe(10);
  expect(ledger.observe(counts(10, 5), counts(10, 5))).toEqual({ partial: true });
  expect(ledger.observe(counts(20, 10), counts(10, 5))).toMatchObject({
    tokens: { inputTokens: 10, cacheReadTokens: 5 },
    partial: false,
    basis: "delta",
  });
  ledger.endTurn();
  ledger.startTurn();
  expect(ledger.observe(counts(20, 10), counts(0, 0))).toMatchObject({
    tokens: { inputTokens: 0, outputTokens: 0 },
    partial: false,
    basis: "delta",
  });
});

it("auxiliary conflict leaves known primary history with unclassified detail through later reconciliation", () => {
  const r = setup();
  [
    ctx("known"),
    token(c(10, 0), c(10, 0)),
    token(c(10, 5), c(10, 5)),
    token(c(20, 10), c(10, 5)),
    done("known"),
  ].forEach((row) => r.consume(row));
  for (let i = 0; i < 20; i++) {
    const record = r.records.get("known");
    expect(record?.tokens).toEqual({ inputTokens: 20, outputTokens: 0 });
    expect(record?.partial).toBe(true);
  }
});
