import { expect, it, vi } from "vitest";
import { makeHistoryReducer } from "./history-records.ts";
import { canonicalHistory } from "./history-canonical.ts";

const old = "2026-09-01T12:00:00Z",
  current = "2026-10-06T12:00:00Z",
  future = "2026-10-20T12:00:00Z";
const from = Date.parse("2026-10-05T00:00:00Z"),
  to = Date.parse("2026-10-12T00:00:00Z");
const event = (type: string, payload: object, timestamp = current) => ({
  type,
  payload,
  timestamp,
});
const counts = (input_tokens: number, output_tokens = 0, detail: object = {}) => ({
  input_tokens,
  output_tokens,
  ...detail,
});
const meta = (id: string, timestamp = current) => event("session_meta", { id }, timestamp);
const context = (turn_id: string, model: string | null = "actual", timestamp = current) =>
  event("turn_context", { turn_id, model }, timestamp);
const terminal = (turn_id: string, timestamp = current) =>
  event("event_msg", { type: "task_complete", turn_id }, timestamp);
const absent = Symbol("absent requirement");
const request = (
  response_id = "r1",
  usage: unknown = counts(10),
  expected: unknown = counts(10),
  timestamp = current,
  turn_id = "native",
  thread_id = "owner",
) =>
  event(
    "token_usage_record",
    {
      thread_id,
      turn_id,
      response_id,
      usage,
      ...(expected === absent ? {} : { turn_token_usage: expected }),
    },
    timestamp,
  );
const canonical = (r: ReturnType<typeof makeHistoryReducer>) => [
  ...canonicalHistory([...r.records.values()]).unique.values(),
];

for (const originalTime of [old, current, future])
  for (const closed of [false, true])
    for (const model of [null, "actual"])
      for (const gap of ["header", "discard", "null"] as const) {
        it(`replay never changes origin or known witness ${originalTime} closed=${closed} model=${model} gap=${gap}`, () => {
          const r = makeHistoryReducer("codex", from, to);
          [
            meta("owner", originalTime),
            context("native", model, originalTime),
            request("r1", counts(10), counts(10), originalTime),
            ...(closed ? [terminal("native", originalTime)] : []),
          ].forEach((x) => r.consume(x));
          const projection = structuredClone([...r.records.values()]);
          if (gap === "header") r.consume(meta("foreign"));
          else if (gap === "discard") r.breakContext();
          else r.consume(event("event_msg", { type: "token_count", info: null }));
          for (let i = 0; i < 3; i++) r.consume(request());
          expect([...r.records.values()]).toEqual(projection);
          expect(canonical(r).reduce((n, row) => n + row.tokens.inputTokens, 0)).toBe(
            originalTime === current ? 10 : 0,
          );
          expect(r.retainedBytes()).toBeLessThan(32 * 1024 * 1024);
          if (gap === "header") {
            r.consume(request("new", counts(3), counts(3), current, "independent"));
            r.consume(request("new", counts(3), counts(3), future, "independent"));
            r.consume(terminal("independent"));
            expect(canonical(r).find((x) => x.id === "independent")).toMatchObject({
              at: Date.parse(current),
              tokens: { inputTokens: 3 },
              model: null,
              trusted: true,
              complete: false,
            });
          }
        });
      }
for (const spec of [
  { label: "same", next: counts(10), complete: true, recovery: true },
  { label: "larger", next: counts(20), complete: false, recovery: true },
  { label: "decreased", next: counts(5), complete: false, recovery: false },
  { label: "missing", next: absent, complete: false, recovery: true },
  { label: "null", next: null, complete: false, recovery: false },
  { label: "negative", next: counts(-1), complete: false, recovery: false },
  { label: "unsafe", next: counts(Number.MAX_SAFE_INTEGER, 1), complete: false, recovery: false },
  {
    label: "invalid-cache",
    next: counts(10, 0, { cached_input_tokens: 11 }),
    complete: false,
    recovery: false,
  },
])
  for (const late of [false, true])
    it(`completion requirements survive amount dedup ${spec.label} late=${late}`, () => {
      const r = makeHistoryReducer("codex");
      [
        meta("owner"),
        context("native"),
        request(),
        ...(late ? [terminal("native")] : []),
        request("r1", counts(10), spec.next),
        ...(!late ? [terminal("native")] : []),
      ].forEach((x) => r.consume(x));
      const row = canonical(r)[0]!;
      expect(row).toMatchObject({
        session: "owner",
        id: "native",
        at: Date.parse(current),
        model: "actual",
        tokens: { inputTokens: 10, outputTokens: 0 },
        complete: spec.complete,
        trusted: true,
      });
      r.consume(request("r1", counts(10), spec.next));
      expect(canonical(r)).toEqual([row]);
      if (spec.label === "larger") {
        r.consume(request("r2", counts(10), counts(20)));
        r.consume(terminal("native"));
      } else {
        r.consume(request());
        r.consume(terminal("native"));
      }
      expect(canonical(r)[0]).toMatchObject({
        tokens: { inputTokens: spec.label === "larger" ? 20 : 10 },
        complete: spec.recovery,
      });
    });
it("later missing model is absence while an actual incompatible witness remains a contradiction", () => {
  const r = makeHistoryReducer("codex");
  [meta("owner"), context("native"), request(), terminal("native")].forEach((x) => r.consume(x));
  const original = structuredClone(r.records.get("response:r1"));
  r.breakContext();
  r.consume(request());
  expect(r.records.get("response:r1")).toEqual(original);
  r.consume(context("native", "different"));
  r.consume(request());
  expect(canonical(r)).toEqual([]);
  expect(r.records.get("response:r1")).toMatchObject({
    trusted: false,
    modelConflict: true,
    model: null,
    modelWitness: "actual",
  });
});
it("Unknown original model stays Unknown with a later actual witness, which still detects a real disagreement", () => {
  const r = makeHistoryReducer("codex");
  [meta("owner"), context("native", null), request(), terminal("native")].forEach((x) =>
    r.consume(x),
  );
  r.breakContext();
  r.consume(context("native", "later"));
  r.consume(request());
  expect(canonical(r)[0]).toMatchObject({
    model: null,
    tokens: { inputTokens: 10 },
    trusted: true,
  });
  r.breakContext();
  r.consume(context("native", "different"));
  r.consume(request());
  expect(canonical(r)).toEqual([]);
});
it("same response in another owner is refused without damaging the original; another native turn conflicts", () => {
  const r = makeHistoryReducer("codex");
  [meta("owner"), context("native"), request(), terminal("native")].forEach((x) => r.consume(x));
  const original = structuredClone(r.records.get("response:r1"));
  r.consume(request("r1", counts(100), counts(100), current, "native", "wrong"));
  expect(r.records.get("response:r1")).toEqual(original);
  r.consume(request("r1", counts(10), counts(10), current, "different-native"));
  expect(canonical(r)).toEqual([]);
});
it("missing original execution time cannot be invented by a correctly scoped later replay", () => {
  const r = makeHistoryReducer("codex", from, to);
  [
    meta("owner"),
    context("native", "actual", "invalid"),
    request("r1", counts(10), counts(10), "invalid"),
  ].forEach((x) => r.consume(x));
  r.consume(meta("foreign"));
  r.consume(request());
  r.consume(request());
  expect(r.records.size).toBe(0);
  expect(r.invalid).toBeGreaterThan(0);
  r.consume(request("distinct", counts(3), counts(3), current, "new"));
  expect(canonical(r)).toHaveLength(1);
  expect(canonical(r)[0]).toMatchObject({
    id: "new",
    at: Date.parse(current),
    tokens: { inputTokens: 3 },
    complete: false,
  });
});
it("expected lane evidence on an earlier response cannot disappear behind a larger requirement missing that lane", () => {
  const r = makeHistoryReducer("codex");
  [
    meta("owner"),
    context("native"),
    request(
      "r1",
      counts(80, 0, { cached_input_tokens: 80 }),
      counts(100, 0, { cached_input_tokens: 80 }),
    ),
    request("r2", counts(30), counts(110)),
    terminal("native"),
  ].forEach((x) => r.consume(x));
  expect(canonical(r)[0]).toMatchObject({
    tokens: { inputTokens: 110 },
    complete: false,
    trusted: true,
  });
  expect(canonical(r)[0]!.tokens.cacheReadTokens).toBeUndefined();
});
it("expected optional minima survive omission on the same response", () => {
  const r = makeHistoryReducer("codex");
  [
    meta("owner"),
    context("native"),
    request("r1", counts(10), counts(10, 0, { cached_input_tokens: 5 })),
    request(),
    terminal("native"),
  ].forEach((x) => r.consume(x));
  expect(r.records.get("response:r1")!.expectedTurnTokens!.cacheReadTokens).toBe(5);
  expect(canonical(r)[0]).toMatchObject({ tokens: { inputTokens: 10 }, complete: false });
});
it("incompatible safe lane requirements cannot build an unsafe combined requirement or erase a known amount", () => {
  const r = makeHistoryReducer("codex");
  [
    meta("owner"),
    context("native"),
    request("r1", counts(10), counts(10, 0, { cached_input_tokens: 8 })),
    request("r1", counts(10), counts(10, 0, { cache_write_input_tokens: 8 })),
    terminal("native"),
  ].forEach((x) => r.consume(x));
  expect(canonical(r)[0]).toMatchObject({
    tokens: { inputTokens: 10 },
    complete: false,
    trusted: true,
  });
  expect(r.invalid).toBeGreaterThan(0);
  expect(r.records.get("response:r1")!.expectedTurnTokens).toEqual({
    inputTokens: 10,
    outputTokens: 0,
    cacheReadTokens: 8,
  });
});
it("real zero remains once-only known zero and missing requirement does not invent positive usage", () => {
  const r = makeHistoryReducer("codex");
  [
    meta("owner"),
    context("native"),
    request("r1", counts(0), counts(0)),
    request("r1", counts(0), absent),
    terminal("native"),
  ].forEach((x) => r.consume(x));
  expect(canonical(r)[0]).toMatchObject({
    tokens: { inputTokens: 0, outputTokens: 0 },
    complete: false,
  });
  r.consume(request("r1", counts(0), counts(0)));
  expect(canonical(r)[0]).toMatchObject({
    tokens: { inputTokens: 0, outputTokens: 0 },
    complete: true,
  });
});
it("outside-window original response evidence remains bounded at actual request admission refusal", () => {
  const r = makeHistoryReducer("codex", from, to);
  r.consume(meta("owner"));
  r.consume(context("native", "actual", "invalid"));
  for (let i = 0; i < 50_001; i++) r.consume(request(`r${i}`, counts(1), counts(i + 1), "invalid"));
  expect(r.nativeOverflow).toBe(true);
  expect(r.records.size).toBe(0);
  const bytes = r.retainedBytes();
  expect(bytes).toBeLessThan(32 * 1024 * 1024);
  for (let i = 0; i < 3; i++) r.consume(request("r0", counts(1), counts(1)));
  expect(r.records.size).toBe(0);
  expect(r.retainedBytes()).toBe(bytes);
});
it("repeated real terminals do not revisit completed response evidence", () => {
  const r = makeHistoryReducer("codex");
  r.consume(meta("owner"));
  r.consume(context("native"));
  for (let i = 0; i < 100; i++) r.consume(request(`r${i}`, counts(1), counts(i + 1)));
  const get = Map.prototype.get;
  let visits = 0;
  const spy = vi.spyOn(Map.prototype, "get").mockImplementation(function (
    this: Map<unknown, unknown>,
    key: unknown,
  ) {
    if (typeof key === "string" && key.startsWith("response:r")) visits++;
    return get.call(this, key);
  });
  try {
    r.consume(terminal("native"));
    expect(visits).toBe(100);
    visits = 0;
    for (let i = 0; i < 512; i++) r.consume(terminal("native"));
    expect(visits).toBe(0);
  } finally {
    spy.mockRestore();
  }
  expect(canonical(r)[0]).toMatchObject({ tokens: { inputTokens: 100 }, complete: true });
});

for (const last of [10, 0, undefined])
  it(`an observed larger native completion requirement cannot lend a stale baseline to a later turn last=${last}`, () => {
    const e = event,
      c = counts;
    const r = makeHistoryReducer("codex");
    [
      e("session_meta", { id: "owner" }),
      e("event_msg", { type: "token_count", info: { total_token_usage: c(0) } }),
      e("turn_context", { turn_id: "old", model: "actual" }),
      e("event_msg", {
        type: "token_count",
        info: { total_token_usage: c(10), last_token_usage: c(10) },
      }),
      e("token_usage_record", {
        thread_id: "owner",
        turn_id: "old",
        response_id: "r1",
        usage: c(10),
        turn_token_usage: c(10),
      }),
      e("token_usage_record", {
        thread_id: "owner",
        turn_id: "old",
        response_id: "r1",
        usage: c(10),
        turn_token_usage: c(20),
      }),
      e("event_msg", { type: "task_complete", turn_id: "old" }),
      e("turn_context", { turn_id: "new", model: "actual" }),
      e("event_msg", {
        type: "token_count",
        info: {
          total_token_usage: c(last === 0 ? 20 : 30),
          ...(last === undefined ? {} : { last_token_usage: c(last) }),
        },
      }),
      e("event_msg", { type: "task_complete", turn_id: "new" }),
    ].forEach((x) => r.consume(x));
    const rows = [...canonicalHistory([...r.records.values()]).unique.values()];
    expect(rows.find((x) => x.id === "old")!.tokens.inputTokens).toBe(10);
    expect(rows.find((x) => x.id === "new")?.tokens.inputTokens).toBe(last);
    if (last !== undefined) expect(rows.find((x) => x.id === "new")!.partial).toBe(true);
  });

for (const expected of [absent, null, counts(5), counts(20, 0, { cached_input_tokens: 7 })])
  it(`unproven completion evidence preserves amounts but not later session continuity ${String(expected)}`, () => {
    const r = makeHistoryReducer("codex");
    [
      meta("owner"),
      event("event_msg", { type: "token_count", info: { total_token_usage: counts(0) } }),
      context("native"),
      event("event_msg", {
        type: "token_count",
        info: { total_token_usage: counts(10), last_token_usage: counts(10) },
      }),
      request(),
      request("r1", counts(10), expected),
      terminal("native"),
      context("new"),
      event("event_msg", {
        type: "token_count",
        info: { total_token_usage: counts(30), last_token_usage: counts(10) },
      }),
      terminal("new"),
    ].forEach((x) => r.consume(x));
    expect(canonical(r).find((x) => x.id === "native")!.tokens.inputTokens).toBe(10);
    expect(canonical(r).find((x) => x.id === "new")).toMatchObject({
      tokens: { inputTokens: 10 },
      partial: true,
      basis: "last-request",
    });
  });

it("an actually covering final counter recovers continuity without minting expected amounts", () => {
  const r = makeHistoryReducer("codex");
  [
    meta("owner"),
    event("event_msg", { type: "token_count", info: { total_token_usage: counts(0) } }),
    context("native"),
    event("event_msg", {
      type: "token_count",
      info: { total_token_usage: counts(10), last_token_usage: counts(10) },
    }),
    request(),
    request("r1", counts(10), counts(20)),
    request("r2", counts(10), counts(20)),
    event("event_msg", {
      type: "token_count",
      info: { total_token_usage: counts(20), last_token_usage: counts(10) },
    }),
    terminal("native"),
    context("new"),
    event("event_msg", {
      type: "token_count",
      info: { total_token_usage: counts(30), last_token_usage: counts(10) },
    }),
    terminal("new"),
  ].forEach((x) => r.consume(x));
  expect(canonical(r).find((x) => x.id === "native")).toMatchObject({
    tokens: { inputTokens: 20 },
    complete: true,
  });
  expect(canonical(r).find((x) => x.id === "new")).toMatchObject({
    tokens: { inputTokens: 10 },
    partial: false,
    basis: "delta",
  });
});
