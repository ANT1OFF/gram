import { expect, it } from "vitest";
import { makeHistoryReducer } from "./history-records.ts";
import { canonicalHistory } from "./history-canonical.ts";
import type { HistoryRecord } from "./history-types.ts";

const old = "2026-09-01T12:00:00Z",
  now = "2026-10-06T12:00:00Z";
const e = (type: string, payload: object, timestamp = old) => ({ type, payload, timestamp });
const c = (input_tokens: number, output_tokens = 0, detail: object = {}) => ({
  input_tokens,
  output_tokens,
  ...detail,
});
const absent = Symbol("absent");
const request = (
  expected: unknown,
  usage = c(10),
  timestamp = "invalid",
  turn_id = "old",
  thread_id = "owner",
) =>
  e(
    "token_usage_record",
    {
      thread_id,
      turn_id,
      response_id: "r1",
      usage,
      ...(expected === absent ? {} : { turn_token_usage: expected }),
    },
    timestamp,
  );
const token = (total: unknown, last: unknown = absent, timestamp = old) =>
  e(
    "event_msg",
    {
      type: "token_count",
      info: { total_token_usage: total, ...(last === absent ? {} : { last_token_usage: last }) },
    },
    timestamp,
  );
const terminal = (turn_id: string) => e("event_msg", { type: "task_complete", turn_id });
const canonical = (r: ReturnType<typeof makeHistoryReducer>) => [
  ...canonicalHistory([...r.records.values()]).unique.values(),
];
const prefix = (model: string | null = "actual") => {
  const r = makeHistoryReducer("codex");
  [
    e("session_meta", { id: "owner" }),
    token(c(0), c(0)),
    e("turn_context", { turn_id: "old", model }, "invalid"),
    token(c(10), c(10)),
    request(c(10)),
  ].forEach((x) => r.consume(x));
  return r;
};
for (const model of [null, "actual"])
  for (const expected of [c(5), absent, null, c(10, 0, { cached_input_tokens: 11 })])
    for (const recover of [false, true])
      it(`refused origin retains independent requirement gaps model=${model} requirement=${String(expected)} recover=${recover}`, () => {
        const r = prefix(model);
        r.consume(request(expected, c(10), now));
        r.consume(request(expected, c(10), now));
        if (recover) r.consume(token(c(20), c(10)));
        [
          terminal("old"),
          e("turn_context", { turn_id: "new", model: "new-actual" }, now),
          token(c(30), c(10), now),
          terminal("new"),
        ].forEach((x) => r.consume(x));
        const rows = canonical(r);
        expect(r.records.has("response:r1")).toBe(false);
        expect(rows.find((x) => x.id === "old")).toMatchObject({
          at: Date.parse(old),
          model,
          tokens: { inputTokens: 10 },
        });
        expect(rows.find((x) => x.id === "new")).toMatchObject({
          tokens: { inputTokens: 10 },
          model: "new-actual",
          partial: !recover,
          basis: recover ? "delta" : "last-request",
        });
        expect(r.retainedBytes()).toBeLessThan(32 * 1024 * 1024);
      });
it("wrong-owner requirement evidence cannot invalidate original-session continuity", () => {
  const r = prefix();
  r.consume(request(c(5), c(10), now, "old", "foreign"));
  [
    terminal("old"),
    e("turn_context", { turn_id: "new", model: "actual" }, now),
    token(c(30), c(10), now),
    terminal("new"),
  ].forEach((x) => r.consume(x));
  expect(canonical(r).find((x) => x.id === "new")).toMatchObject({
    tokens: { inputTokens: 20 },
    partial: false,
  });
});
for (const conflict of ["count", "turn"])
  it(`true scoped ${conflict} contradiction remains refused after a null origin`, () => {
    const r = prefix();
    r.consume(
      request(
        c(10),
        c(conflict === "count" ? 11 : 10),
        now,
        conflict === "turn" ? "foreign-turn" : "old",
      ),
    );
    [
      terminal("old"),
      e("turn_context", { turn_id: "new", model: "actual" }, now),
      token(c(30), c(10), now),
      terminal("new"),
    ].forEach((x) => r.consume(x));
    expect(r.records.has("response:r1")).toBe(false);
    expect(canonical(r).find((x) => x.id === "old")?.tokens.inputTokens).toBe(10);
    expect(canonical(r).find((x) => x.id === "new")).toMatchObject({
      tokens: { inputTokens: 10 },
      partial: true,
    });
  });
it("quarantine does not restore refused origin or borrow terminal proof for independent original-owner requests", () => {
  const r = prefix();
  r.consume(e("session_meta", { id: "foreign" }, now));
  r.consume(request(c(5), c(10), now));
  r.consume(
    e(
      "token_usage_record",
      {
        thread_id: "owner",
        turn_id: "new",
        response_id: "r2",
        usage: c(7),
        turn_token_usage: c(7),
      },
      now,
    ),
  );
  r.consume(terminal("new"));
  const rows = canonical(r);
  expect(r.records.has("response:r1")).toBe(false);
  expect(rows.find((x) => x.id === "old")?.tokens.inputTokens).toBe(10);
  expect(rows.find((x) => x.id === "new")).toMatchObject({
    at: Date.parse(now),
    tokens: { inputTokens: 7 },
    model: null,
    complete: false,
  });
});
const record = (tokens: HistoryRecord["tokens"], modern = false): HistoryRecord => ({
  provider: "codex",
  session: "owner",
  id: modern ? "response:r1" : "native",
  ...(modern
    ? {
        turn: "native",
        turnComplete: true,
        expectedTurnTokens: { inputTokens: 40, outputTokens: 20 },
      }
    : {}),
  nativeIds: ["native"],
  model: "actual",
  modelWitness: "actual",
  at: Date.parse(now),
  tokens,
  partial: false,
  complete: true,
  trusted: true,
  parent: null,
  basis: "delta",
});
const pairs = [
  {
    old: {
      inputTokens: 20,
      outputTokens: 4,
      cacheReadTokens: 8,
      cacheWriteTokens: 0,
      reasoningTokens: 3,
    },
    modern: {
      inputTokens: 8,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      reasoningTokens: 4,
    },
    wanted: {
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 8,
      cacheWriteTokens: 3,
      reasoningTokens: 4,
    },
    cacheIncomplete: true,
  },
  {
    old: { inputTokens: 20, outputTokens: 0, cacheReadTokens: 5, cacheWriteTokens: 0 },
    modern: { inputTokens: 25, outputTokens: 0 },
    wanted: { inputTokens: 25, outputTokens: 0, cacheReadTokens: 5, cacheWriteTokens: 0 },
    cacheIncomplete: true,
  },
  {
    old: { inputTokens: 20, outputTokens: 0 },
    modern: { inputTokens: 8, outputTokens: 0 },
    wanted: { inputTokens: 20, outputTokens: 0 },
    cacheIncomplete: false,
  },
  {
    old: { inputTokens: 20, outputTokens: 0, cacheReadTokens: 15, cacheWriteTokens: 0 },
    modern: { inputTokens: 20, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 15 },
    wanted: { inputTokens: 20, outputTokens: 0, cacheReadTokens: 15, cacheWriteTokens: 0 },
    cacheIncomplete: true,
  },
  {
    old: { inputTokens: Number.MAX_SAFE_INTEGER - 1, outputTokens: 0 },
    modern: { inputTokens: 0, outputTokens: 2 },
    wanted: { inputTokens: Number.MAX_SAFE_INTEGER - 1, outputTokens: 0 },
    cacheIncomplete: true,
  },
];
for (const spec of pairs)
  for (const reversed of [false, true])
    it(`overlap lane minima stay safe and conservative ${JSON.stringify(spec)} reverse=${reversed}`, () => {
      const a = record(spec.old),
        b = record(spec.modern, true),
        input = reversed ? [b, a] : [a, b],
        original = structuredClone(input);
      const result = canonicalHistory(input);
      const rows = [...result.unique.values()];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tokens).toEqual(spec.wanted);
      expect(rows[0]).toMatchObject({
        complete: false,
        partial: true,
        model: "actual",
        basis: "delta",
      });
      expect(rows[0]!.cacheIncomplete === true).toBe(spec.cacheIncomplete);
      expect(input).toEqual(original);
      expect(result.supersededRecords).toBe(1);
    });
it("actual model conflict stays Unknown when retaining the counter amount", () => {
  const a = record({ inputTokens: 20, outputTokens: 0 }),
    b = record({ inputTokens: 8, outputTokens: 0 }, true);
  b.model = "other";
  b.modelWitness = "other";
  const row = [...canonicalHistory([a, b]).unique.values()][0]!;
  expect(row).toMatchObject({
    tokens: { inputTokens: 20 },
    model: null,
    modelConflict: true,
    complete: false,
  });
});
it("untrusted markerless or invalid counter representations cannot gain trust from reconciliation", () => {
  const response = record({ inputTokens: 8, outputTokens: 0 }, true);
  for (const counted of [
    { ...record({ inputTokens: 1000, outputTokens: 0 }), trusted: false },
    record({ inputTokens: -1, outputTokens: 0 }),
  ]) {
    delete counted.basis;
    const rows = [...canonicalHistory([counted, response]).unique.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokens.inputTokens).toBe(8);
    expect(rows[0]!.complete).toBe(false);
  }
});
it("actual complete modern coverage replaces the overlapping prefix once, with no synthetic completion from minima", () => {
  const a = record({ inputTokens: 20, outputTokens: 0 }),
    b = record({ inputTokens: 8, outputTokens: 0 }, true);
  const before = [...canonicalHistory([a, b]).unique.values()][0]!;
  expect(before).toMatchObject({ tokens: { inputTokens: 20 }, complete: false });
  const next = {
    ...b,
    id: "response:r2",
    tokens: { inputTokens: 12, outputTokens: 0 },
    expectedTurnTokens: { inputTokens: 20, outputTokens: 0 },
  };
  b.expectedTurnTokens = { inputTokens: 20, outputTokens: 0 };
  const result = canonicalHistory([a, b, next]);
  expect([...result.unique.values()]).toHaveLength(1);
  expect([...result.unique.values()][0]).toMatchObject({
    tokens: { inputTokens: 20 },
    complete: true,
    partial: false,
  });
});
