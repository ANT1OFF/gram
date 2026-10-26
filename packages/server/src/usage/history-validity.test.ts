import { afterEach, expect, it } from "vitest";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateUsage } from "./aggregate.ts";
import { canonicalHistory } from "./history-canonical.ts";
import { mergeHistoryUsage } from "./history-merge.ts";
import { HISTORY_LIMITS, makeHistoryReader } from "./history-reader.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const temp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "gram-history-validity-offline-"));
  dirs.push(dir);
  return dir;
};
const now = Date.parse("2026-10-12T12:00:00Z"),
  at = "2026-10-06T12:00:00Z";
const signal = () => new AbortController().signal;
const row = (uuid: string, model = "actual", extra = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at,
    sessionId: "session",
    uuid,
    requestId: uuid,
    ...extra,
    message: {
      id: uuid,
      model,
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  }) + "\n";
const counts = (input_tokens: number, output_tokens: number) => ({ input_tokens, output_tokens });
const event = (timestamp: string, type: string, payload: object, extra = {}) =>
  JSON.stringify({ timestamp, type, payload, ...extra }) + "\n";
const token = (timestamp: string, input: number, output: number, last?: object) =>
  event(timestamp, "event_msg", {
    type: "token_count",
    info: { total_token_usage: counts(input, output), last_token_usage: last },
  });
const context = (timestamp: string, turn_id: string) =>
  event(timestamp, "turn_context", { turn_id, model: "actual-" + turn_id });
const done = (timestamp: string, turn_id: string) =>
  event(timestamp, "event_msg", { type: "task_complete", turn_id });
const overview = (scan: Awaited<ReturnType<ReturnType<typeof makeHistoryReader>["scan"]>>) =>
  aggregateUsage(mergeHistoryUsage([], scan).records, { days: 7 }, now);

it("charges changed-prefix/append reads once per admitted file and makes bounded refresh progress", async () => {
  const dir = await temp(),
    roots = [{ provider: "claude" as const, dir }];
  for (let i = 0; i < 3; i++) await writeFile(join(dir, `${i}.jsonl`), row(String(i), "initial"));
  const reader = makeHistoryReader({ ...HISTORY_LIMITS, files: 1 });
  for (let i = 0; i < 3; i++) await reader.scan(roots, signal());
  const warm = await reader.scan(roots, signal());
  expect(warm.work).toMatchObject({ bytes: 0, files: 0 });
  expect(warm.sources[0]).toMatchObject({ files: 3, status: "available" });
  for (let i = 0; i < 3; i++)
    await writeFile(
      join(dir, `${i}.jsonl`),
      row(String(i), "changed") + row("append-" + i, "changed"),
    );
  const first = await reader.scan(roots, signal());
  expect(first.work?.files).toBe(2); // one admitted read plus one unopened refusal sentinel
  expect(first.work!.bytes).toBeLessThanOrEqual(
    Buffer.byteLength(row("0", "initial")) +
      Buffer.byteLength(row("0", "changed") + row("append-0", "changed")),
  );
  expect(first.sources[0]).toMatchObject({ files: 1, status: "partial" });
  expect(first.records).toHaveLength(2);
  await reader.scan(roots, signal());
  const final = await reader.scan(roots, signal());
  expect(final.sources[0]).toMatchObject({ files: 3, status: "available" });
  expect(final.records).toHaveLength(6);
  expect(final.records.every((record) => record.model === "changed")).toBe(true);
  const unchanged = await reader.scan(roots, signal());
  expect(unchanged.work).toMatchObject({ bytes: 0, files: 0 });
  expect(overview(unchanged).totals.totalTokens).toBe(66);
});

for (const field of ["model", "uuid", "ignored"] as const) {
  it(`rejects actual invalid UTF-8 bytes in ${field}, including ignored content`, async () => {
    const dir = await temp(),
      bytes = Buffer.from(row("marker-id", "marker-model", { ignored: "marker-ignored" }));
    const needle = field === "uuid" ? "marker-id" : "marker-" + field;
    bytes[bytes.indexOf(needle)] = 0xff;
    await writeFile(join(dir, "history.jsonl"), bytes);
    const scan = await makeHistoryReader().scan([{ provider: "claude", dir }], signal());
    expect(scan.records).toEqual([]);
    expect(scan.sources[0]).toMatchObject({ status: "partial", invalidLines: 1 });
    expect(scan.provenance).toEqual([]);
  });
}
it("accepts real replacement characters/Unicode across chunks and completes an appended UTF-8 tail", async () => {
  const dir = await temp(),
    model = "actual-秘密🙂�",
    roots = [{ provider: "claude" as const, dir }];
  const prefix = Buffer.from(row("one", model, { ignored: "" })).indexOf("秘密");
  const bytes = Buffer.from(row("one", model, { ignored: "x".repeat(65535 - prefix) }));
  expect(bytes.indexOf("秘密")).toBe(65535);
  const split = bytes.indexOf("秘密") + 1,
    file = join(dir, "history.jsonl");
  await writeFile(file, bytes.subarray(0, split));
  const reader = makeHistoryReader();
  const tail = await reader.scan(roots, signal());
  expect(tail.sources[0]).toMatchObject({ status: "partial", invalidLines: 0 });
  expect(tail.records).toEqual([]);
  await appendFile(file, bytes.subarray(split));
  const recovered = await reader.scan(roots, signal());
  expect(recovered.sources[0]).toMatchObject({ status: "available", invalidLines: 0 });
  expect(recovered.records[0]).toMatchObject({ model, complete: true });
  expect(overview(recovered).totals.totalTokens).toBe(11);
  expect(JSON.stringify(recovered)).not.toContain("x".repeat(100));
});

for (const selectedLast of [counts(10, 1), counts(0, 0), undefined]) {
  it(`invalidates prior continuity across multiple corrupt/encoding gaps with last ${JSON.stringify(selectedLast)}`, async () => {
    const dir = await temp(),
      file = join(dir, "rollout-gap.jsonl"),
      old = "2026-09-01T12:00:00Z";
    const first =
      event(old, "session_meta", { id: "session" }) +
      token(old, 0, 0) +
      context(old, "baseline") +
      token(old, 100, 10, counts(100, 10)) +
      done(old, "baseline");
    const reader = makeHistoryReader(),
      roots = [{ provider: "codex" as const, dir }],
      window = { from: now - 7 * 86400000, to: now };
    await writeFile(file, first);
    expect((await reader.scan(roots, signal(), window)).records).toEqual([]);
    const corrupt = Buffer.from(
      event(
        old,
        "event_msg",
        { type: "token_count", info: { total_token_usage: counts(1100, 110) } },
        { ignored: "poison" },
      ),
    );
    corrupt[corrupt.indexOf("poison")] = 0xff;
    await appendFile(
      file,
      Buffer.concat([
        Buffer.from(context(old, "skipped") + "not-json\n"),
        corrupt,
        Buffer.from(
          context(at, "selected") + token(at, 1110, 111, selectedLast) + done(at, "selected"),
        ),
      ]),
    );
    const scan = await reader.scan(roots, signal(), window),
      data = overview(scan);
    expect(scan.sources[0]).toMatchObject({ status: "partial", invalidLines: 2 });
    expect(data.totals.totalTokens).toBe(
      selectedLast === undefined ? 0 : selectedLast.input_tokens + selectedLast.output_tokens,
    );
    expect(data.recordedTurns).toBe(selectedLast === undefined ? 0 : 1);
    if (selectedLast !== undefined) {
      expect(scan.records[0]).toMatchObject({
        partial: true,
        complete: false,
        nativeIds: ["selected"],
        model: "actual-selected",
      });
      expect(data.partialUsageTurns).toBe(1);
    }
    expect(await reader.scan(roots, signal(), window)).toMatchObject({
      records: scan.records,
      sources: scan.sources,
      work: { bytes: 0, files: 0 },
    });
  });
}
it("keeps earlier known contributions inside the window and independent modern responses after a gap", async () => {
  const dir = await temp(),
    before = "2026-10-05T12:00:00Z";
  const text =
    event(before, "session_meta", { id: "session" }) +
    token(before, 0, 0) +
    context(before, "prior") +
    token(before, 100, 10, counts(100, 10)) +
    done(before, "prior") +
    "broken\n" +
    context(at, "selected") +
    token(at, 1110, 111, counts(10, 1)) +
    event(at, "token_usage_record", {
      thread_id: "session",
      turn_id: "selected",
      response_id: "request",
      usage: counts(10, 1),
      turn_token_usage: counts(10, 1),
    }) +
    done(at, "selected");
  await writeFile(join(dir, "rollout-gap.jsonl"), text);
  const scan = await makeHistoryReader().scan([{ provider: "codex", dir }], signal()),
    merged = mergeHistoryUsage([], scan);
  expect(overview(scan).totals.totalTokens).toBe(121);
  expect(
    overview(scan)
      .rows.map((record) => record.model)
      .toSorted(),
  ).toEqual(["actual-prior", "actual-selected"]);
  expect(merged.coverage).toMatchObject({
    importedRecords: 2,
    supersededRecords: 1,
    historyRecords: 3,
  });
  expect(merged.records.every((record) => record.usage?.includes('"partial":true'))).toBe(true);
});
it("reconciles both model witnesses before modern supersession without changing canonical counts or identities", () => {
  const record = {
    provider: "codex" as const,
    session: "session",
    id: "turn",
    nativeIds: ["turn"],
    model: null,
    modelWitness: "observed-A",
    at: now - 1000,
    tokens: { inputTokens: 10, outputTokens: 1 },
    partial: false,
    complete: true,
    trusted: true,
    parent: null,
  };
  const modern = {
    ...record,
    id: "response:r",
    turn: "turn",
    model: "observed-B",
    modelWitness: "observed-B",
    turnComplete: true,
    expectedTurnTokens: record.tokens,
  };
  const before = JSON.stringify([record, modern]),
    result = [...canonicalHistory([record, modern]).unique.values()];
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    model: null,
    modelConflict: true,
    tokens: record.tokens,
    at: record.at,
    session: record.session,
    nativeIds: record.nativeIds,
  });
  expect(JSON.stringify([record, modern])).toBe(before);
  const original = {
    thread_id: "gram",
    started_at: record.at,
    ended_at: now - 500,
    reason: "completed",
    agent: "codex",
    model: null,
    model_conflict: 0,
    source_session: "session",
    native_ids: '["turn"]',
    usage: JSON.stringify({
      tokens: { inputTokens: 150, outputTokens: 15 },
      telemetryVersion: "codex-request-delta-v1",
    }),
  };
  const saved = JSON.stringify(original),
    joined = mergeHistoryUsage([original], {
      records: result.map((candidate) => ({ ...candidate, partial: true })),
      sources: [],
      ambiguous: 0,
    });
  expect(joined.records).toEqual([original]);
  expect(JSON.stringify(original)).toBe(saved);
});

it("retains actual counter model evidence when the optional witness is absent and response context is missing", () => {
  const counted = {
    provider: "codex" as const,
    session: "session",
    id: "turn",
    nativeIds: ["turn"],
    model: "observed-A",
    at: now - 1000,
    tokens: { inputTokens: 10, outputTokens: 1 },
    partial: false,
    complete: true,
    trusted: true,
    parent: null,
  };
  const response = {
    ...counted,
    id: "response:r",
    turn: "turn",
    model: null,
    turnComplete: true,
    expectedTurnTokens: counted.tokens,
  };
  const rows = [...canonicalHistory([counted, response]).unique.values()];
  expect(rows[0]).toMatchObject({
    model: null,
    modelWitness: "observed-A",
    tokens: counted.tokens,
  });
  const original = {
    thread_id: "gram",
    started_at: counted.at,
    ended_at: now - 500,
    reason: "completed",
    agent: "codex",
    model: "observed-B",
    model_conflict: 0,
    source_session: "session",
    native_ids: '["turn"]',
    usage: JSON.stringify({ tokens: { inputTokens: 150, outputTokens: 15 } }),
  };
  const saved = JSON.stringify(original),
    merged = mergeHistoryUsage([original], {
      records: [counted, response],
      sources: [],
      ambiguous: 0,
    });
  expect(aggregateUsage(merged.records, { days: 7 }, now)).toMatchObject({
    totals: { totalTokens: 11 },
    unknownModelTurns: 1,
  });
  expect(merged.records[0]).toMatchObject({
    started_at: original.started_at,
    ended_at: original.ended_at,
  });
  expect(JSON.stringify(original)).toBe(saved);
});
