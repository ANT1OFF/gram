import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHistoryReducer } from "./history-records.ts";
import { canonicalHistory } from "./history-canonical.ts";
import { makeCodexHistoryCoverage } from "./codex-history-coverage.ts";
import { HISTORY_LIMITS, makeHistoryReader } from "./history-reader.ts";

const old = "2026-09-01T12:00:00Z",
  at = "2026-10-06T12:00:00Z";
const c = (input_tokens: number, cached_input_tokens = 0) => ({
  input_tokens,
  output_tokens: 0,
  cached_input_tokens,
  cache_write_input_tokens: 0,
  reasoning_output_tokens: 0,
});
const raw = (type: string, payload: object, timestamp = old) => ({ type, timestamp, payload });
const ctx = (turn_id: string, timestamp = old) =>
  raw("turn_context", { turn_id, model: "actual" }, timestamp);
const token = (total: object, last?: object, timestamp = old) =>
  raw(
    "event_msg",
    { type: "token_count", info: { total_token_usage: total, last_token_usage: last } },
    timestamp,
  );
const modern = (
  response_id: string,
  turn_id = "old",
  usage = c(100),
  expected = c(200),
  timestamp = old,
) =>
  raw(
    "token_usage_record",
    { thread_id: "session", turn_id, response_id, usage, turn_token_usage: expected },
    timestamp,
  );
const done = (turn_id: string, timestamp = old) =>
  raw("event_msg", { type: "task_complete", turn_id }, timestamp);
const start = (seed = c(0), first = c(100), last = c(100)) => {
  const r = makeHistoryReducer("codex");
  [
    raw("session_meta", { id: "session" }),
    token(seed),
    ctx("old"),
    token(first, last),
    modern("r1", "old", last, last),
  ].forEach((e) => r.consume(e));
  return r;
};
const value = (inputTokens: number) => ({ inputTokens, outputTokens: 0 });

for (const final of ["missing", "stale", "covering"] as const) {
  it(`nonzero session anchors require covered independent contributions, final=${final}`, () => {
    const r = start(c(1000), c(1100));
    r.consume(modern("r2"));
    if (final !== "missing") r.consume(token(c(final === "covering" ? 1200 : 1150), c(50)));
    r.consume(done("old"));
    r.consume(ctx("new", at));
    r.consume(token(c(1210), c(10), at));
    r.consume(done("new", at));
    expect(r.records.get("new")).toMatchObject({
      tokens: { inputTokens: 10, outputTokens: 0 },
      basis: final === "covering" ? "delta" : "last-request",
      partial: final !== "covering",
    });
    expect(
      [...canonicalHistory([...r.records.values()]).unique.values()]
        .filter((row) => row.id === "old")
        .reduce((n, row) => n + row.tokens.inputTokens, 0),
    ).toBe(200);
  });
}
it("a duplicate after a genuine covering counter does not invalidate the recovered baseline", () => {
  const r = start();
  r.consume(modern("r2"));
  r.consume(token(c(200), c(100)));
  const bytes = r.retainedBytes();
  r.consume(modern("r2"));
  expect(r.retainedBytes()).toBe(bytes);
  r.consume(done("old"));
  r.consume(ctx("new", at));
  r.consume(token(c(210), c(10), at));
  r.consume(done("new", at));
  expect(r.records.get("new")).toMatchObject({ tokens: value(10), basis: "delta", partial: false });
});
it("new independent responses at older native reentry are counted once and invalidate stale coverage", () => {
  const r = start();
  r.consume(modern("r2"));
  r.consume(token(c(200), c(100)));
  r.consume(done("old"));
  r.consume(ctx("first-new", at));
  r.consume(token(c(210), c(10), at));
  r.consume(done("first-new", at));
  r.consume(ctx("old"));
  r.consume(modern("r2"));
  r.consume(modern("r3", "old", c(100), c(300)));
  r.consume(token(c(300), c(100))); // replayed counter context cannot seed a baseline
  r.consume(done("old"));
  r.consume(ctx("new", at));
  r.consume(token(c(320), c(10), at));
  r.consume(done("new", at));
  expect(r.records.get("new")).toMatchObject({
    tokens: value(10),
    basis: "last-request",
    partial: true,
  });
  const rows = [...canonicalHistory([...r.records.values()]).unique.values()];
  expect(rows.reduce((n, row) => n + row.tokens.inputTokens, 0)).toBe(320);
});
for (const coveringCache of [false, true]) {
  it(`known cache contributions require their own covering counter lanes, covering=${coveringCache}`, () => {
    const r = start(c(1000, 900), c(1100, 980), c(100, 80));
    r.consume(modern("r2", "old", c(100, 80), c(200, 160)));
    r.consume(token(c(1200, coveringCache ? 1060 : 980), c(100, 80)));
    r.consume(done("old"));
    r.consume(ctx("new", at));
    r.consume(token(c(1210, 1060), c(10, 0), at));
    r.consume(done("new", at));
    expect(r.records.get("new")).toMatchObject({
      tokens: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0 },
      basis: coveringCache ? "delta" : "last-request",
      partial: !coveringCache,
    });
  });
}
it("unobserved starts use conservative observed-counter requirements, never invented session totals", () => {
  const r = makeHistoryReducer("codex");
  [
    raw("session_meta", { id: "session" }),
    ctx("old"),
    token(c(1000), c(100)),
    modern("r1", "old", c(100), c(100)),
    modern("r2"),
    token(c(1100), c(100)),
    done("old"),
    ctx("new", at),
    token(c(1110), c(10), at),
    done("new", at),
  ].forEach((e) => r.consume(e));
  expect(r.records.get("new")).toMatchObject({ tokens: value(10), basis: "delta", partial: false });
});
it("counter reset below retained positive evidence remains partial until a covering observation", () => {
  const r = start();
  r.consume(modern("r2"));
  r.consume(token(c(1), c(1)));
  r.consume(done("old"));
  r.consume(ctx("new", at));
  r.consume(token(c(11), c(10), at));
  r.consume(done("new", at));
  expect(r.records.get("new")).toMatchObject({
    tokens: value(10),
    basis: "last-request",
    partial: true,
  });
});
it("conflicting scoped response identity cannot certify later deltas", () => {
  const r = start();
  r.consume(modern("r2"));
  r.consume(modern("r2", "different", c(100), c(100)));
  r.consume(token(c(200), c(100)));
  r.consume(done("old"));
  r.consume(ctx("new", at));
  r.consume(token(c(210), c(10), at));
  r.consume(done("new", at));
  expect(r.records.get("new")).toMatchObject({
    tokens: value(10),
    basis: "last-request",
    partial: true,
  });
  expect(r.records.get("response:r2")?.trusted).toBe(false);
});
it("outside-window response/scope state is bounded and charged to retained-byte/cache admission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gram-modern-coverage-offline-"));
  dirs.push(dir);
  const events = [raw("session_meta", { id: "session" }), token(c(0)), ctx("old")];
  for (let i = 0; i < 30; i++) events.push(modern(`response-${i}`, "old", c(1), c(i + 1)));
  const file = join(dir, "rollout-metadata.jsonl");
  await writeFile(file, encode(events));
  const reader = makeHistoryReader({ ...HISTORY_LIMITS, metadataBytes: 1024 }),
    roots = [{ provider: "codex" as const, dir }],
    signal = new AbortController().signal,
    window = { from: Date.parse(at), to: Date.parse("2026-10-12T12:00:00Z") };
  const first = await reader.scan(roots, signal, window);
  expect(first.records).toEqual([]);
  expect(first.work!.cacheMetadataBytes).toBe(0);
  const next = await reader.scan(roots, signal, window);
  expect(next.work!.bytes).toBeGreaterThan(0);
  expect(next.work!.cacheMetadataBytes).toBeLessThanOrEqual(1024);
});
it("the 50000 response cap retains duplicates but refuses new evidence without allocating later deltas", () => {
  const coverage = makeCodexHistoryCoverage();
  coverage.start("old", value(0));
  for (let i = 0; i < 50_000; i++)
    expect(coverage.request("old", String(i), value(1), undefined)).toBe("new");
  expect(coverage.covers(value(50_000))).toBe(true);
  const bytes = coverage.retainedBytes();
  expect(coverage.request("old", "0", value(1), value(50_000))).toBe("duplicate");
  expect(coverage.overflow()).toBe(false);
  expect(coverage.retainedBytes()).toBe(bytes);
  expect(coverage.request("old", "extra", value(1), value(50_000))).toBe("refused");
  expect(coverage.covers(value(50_001))).toBe(false);
  expect(coverage.overflow()).toBe(true);
  expect(coverage.retainedBytes()).toBe(bytes);
});
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const encode = (events: object[]) => events.map((e) => JSON.stringify(e) + "\n").join("");
it("same response replay survives period filtering and late incremental append", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gram-modern-cache-offline-"));
  dirs.push(dir);
  const file = join(dir, "rollout-cache.jsonl"),
    reader = makeHistoryReader(),
    roots = [{ provider: "codex" as const, dir }],
    signal = new AbortController().signal,
    window = { from: Date.parse(at), to: Date.parse("2026-10-12T12:00:00Z") };
  await writeFile(
    file,
    encode([
      raw("session_meta", { id: "session" }),
      token(c(0)),
      ctx("old"),
      token(c(100), c(100)),
      modern("r1", "old", c(100), c(100)),
      modern("r2"),
      token(c(200), c(100)),
      done("old"),
    ]),
  );
  const warm = await reader.scan(roots, signal, window);
  expect(warm.records).toEqual([]);
  await appendFile(
    file,
    encode([modern("r2"), ctx("new", at), token(c(210), c(10), at), done("new", at)]),
  );
  const scan = await reader.scan(roots, signal, window);
  expect(scan.records[0]).toMatchObject({ tokens: value(10), basis: "delta", partial: false });
  expect(await reader.scan(roots, signal, window)).toMatchObject({
    records: scan.records,
    work: { bytes: 0, files: 0 },
  });
});

for (const last of [c(10), c(0), undefined]) {
  it(`late older response repairs an already reduced selected allocation, last=${JSON.stringify(last)}`, () => {
    const r = start();
    r.consume(done("old"));
    r.consume(ctx("new", at));
    r.consume(token(c(last?.input_tokens === 0 ? 200 : 210), last, at));
    r.consume(done("new", at));
    r.consume(modern("r2"));
    r.consume(done("old"));
    if (last === undefined) expect(r.records.get("new")).toBeUndefined();
    else
      expect(r.records.get("new")).toMatchObject({
        tokens: value(last.input_tokens),
        basis: "last-request",
        partial: true,
      });
    const rows = [...canonicalHistory([...r.records.values()]).unique.values()];
    expect(rows.reduce((n, row) => n + row.tokens.inputTokens, 0)).toBe(
      200 + (last?.input_tokens ?? 0),
    );
  });
}
it("late evidence also raises later modern-scope requirements without borrowing old increments", () => {
  const r = start();
  r.consume(done("old"));
  r.consume(ctx("new", at));
  r.consume(token(c(200), c(100), at));
  r.consume(modern("new-r1", "new", c(100), c(100), at));
  r.consume(modern("r2"));
  r.consume(modern("new-r2", "new", c(10), c(110), at));
  r.consume(token(c(310), c(10), at));
  r.consume(done("new", at));
  const rows = [...canonicalHistory([...r.records.values()]).unique.values()];
  expect(rows.reduce((n, row) => n + row.tokens.inputTokens, 0)).toBe(310);
  r.consume(ctx("next", at));
  r.consume(token(c(320), c(10), at));
  r.consume(done("next", at));
  expect(r.records.get("next")?.tokens.inputTokens).toBe(10);
});
