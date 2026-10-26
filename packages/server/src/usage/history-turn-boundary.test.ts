import { afterEach, expect, it } from "vitest";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHistoryReader } from "./history-reader.ts";
import { makeHistoryReducer } from "./history-records.ts";
import { canonicalHistory } from "./history-canonical.ts";

const at = "2026-10-06T12:00:00Z";
const encode = (events: object[], timestamp = at) =>
  events.map((e) => JSON.stringify({ ...e, timestamp }) + "\n").join("");

const raw = (type: string, payload: object) => ({ type, timestamp: at, payload });
const counts = (input_tokens: number, output_tokens: number) => ({ input_tokens, output_tokens });
const context = (turn_id: string) => raw("turn_context", { turn_id, model: "actual" });
const token = (total: unknown, last: unknown) =>
  raw("event_msg", {
    type: "token_count",
    info: { total_token_usage: total, last_token_usage: last },
  });
const done = (turn_id: string) => raw("event_msg", { type: "task_complete", turn_id });
const begin = () => {
  const reducer = makeHistoryReducer("codex");
  [
    raw("session_meta", { id: "session" }),
    token(counts(0, 0), null),
    context("prior"),
    token(counts(100, 10), counts(100, 10)),
    done("prior"),
  ].forEach((e) => reducer.consume(e));
  return reducer;
};
for (const gap of ["absent", "null", "invalid", "zero"] as const) {
  for (const terminal of [true, false]) {
    for (const last of [counts(10, 1), counts(0, 0), undefined]) {
      it(`history ${gap} turn with terminal=${terminal}, last=${JSON.stringify(last)}`, () => {
        const reducer = begin();
        reducer.consume(context("gap"));
        if (gap === "null") reducer.consume(raw("event_msg", { type: "token_count", info: null }));
        if (gap === "invalid") reducer.consume(token(counts(-1, 0), counts(-1, 0)));
        if (gap === "zero") reducer.consume(token(counts(100, 10), counts(0, 0)));
        if (terminal) reducer.consume(done("gap"));
        // A duplicate complete for another native turn cannot certify this gap.
        reducer.consume(done("prior"));
        reducer.consume(context("current"));
        reducer.consume(raw("event_msg", { type: "task_started", turn_id: "current" }));
        reducer.consume(token(counts(210, 21), last));
        reducer.consume(done("current"));
        const records = [...reducer.records.values()];
        expect(records[0]).toMatchObject({
          id: "prior",
          tokens: { inputTokens: 100, outputTokens: 10 },
          complete: true,
          partial: false,
        });
        const current = records.find((r) => r.id === "current");
        if (gap !== "zero" && last === undefined) expect(current).toBeUndefined();
        else
          expect(current).toMatchObject({
            tokens:
              gap === "zero"
                ? { inputTokens: 110, outputTokens: 11 }
                : { inputTokens: last!.input_tokens, outputTokens: last!.output_tokens },
            basis: gap === "zero" ? "delta" : "last-request",
            partial: gap !== "zero",
            complete: true,
            nativeIds: ["current"],
            session: "session",
            model: "actual",
          });
      });
    }
  }
}
it("modern independent responses retain complete native proof without certifying a later session delta", () => {
  const reducer = begin();
  reducer.consume(context("modern"));
  const response = raw("token_usage_record", {
    thread_id: "session",
    turn_id: "modern",
    response_id: "response",
    usage: counts(100, 10),
    turn_token_usage: counts(100, 10),
  });
  reducer.consume(response);
  reducer.consume(response);
  reducer.consume(done("modern"));
  // Counter telemetry after the terminal boundary cannot rewind or repair the next baseline.
  reducer.consume(token(counts(200, 20), counts(100, 10)));
  reducer.consume(context("current"));
  reducer.consume(token(counts(210, 21), counts(10, 1)));
  reducer.consume(done("current"));
  const canonical = [...canonicalHistory([...reducer.records.values()]).unique.values()];
  expect(canonical).toHaveLength(3);
  expect(canonical.find((r) => r.id === "modern")).toMatchObject({
    tokens: { inputTokens: 100, outputTokens: 10 },
    partial: false,
    complete: true,
    nativeIds: ["modern"],
  });
  expect(canonical.find((r) => r.id === "current")).toMatchObject({
    tokens: { inputTokens: 10, outputTokens: 1 },
    partial: true,
    basis: "last-request",
  });
  // Older identified replay must not create a no-telemetry gap in the current observed baseline.
  reducer.consume(context("modern"));
  reducer.consume(response);
  reducer.consume(done("modern"));
  reducer.consume(context("new"));
  reducer.consume(token(counts(220, 22), counts(10, 1)));
  reducer.consume(done("new"));
  expect(reducer.records.get("new")).toMatchObject({
    tokens: { inputTokens: 10, outputTokens: 1 },
    basis: "delta",
    partial: false,
  });
});
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
it("incremental refresh preserves a terminal gap outside the window and recovers only known requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gram-continuity-offline-"));
  dirs.push(dir);
  const file = join(dir, "rollout-turn-gap.jsonl"),
    old = "2026-09-01T12:00:00Z";
  await writeFile(
    file,
    encode(
      [
        raw("session_meta", { id: "session" }),
        token(counts(0, 0), null),
        context("prior"),
        token(counts(100, 10), counts(100, 10)),
        done("prior"),
        context("gap"),
        done("gap"),
      ],
      old,
    ),
  );
  const reader = makeHistoryReader(),
    roots = [{ provider: "codex" as const, dir }],
    signal = new AbortController().signal,
    window = { from: Date.parse("2026-10-05T12:00:00Z"), to: Date.parse("2026-10-12T12:00:00Z") };
  expect((await reader.scan(roots, signal, window)).records).toEqual([]);
  await appendFile(
    file,
    encode([context("current"), token(counts(210, 21), counts(10, 1)), done("current")]),
  );
  const scan = await reader.scan(roots, signal, window);
  expect(scan.records).toHaveLength(1);
  expect(scan.records[0]).toMatchObject({
    tokens: { inputTokens: 10, outputTokens: 1 },
    partial: true,
    basis: "last-request",
    complete: true,
  });
  expect(scan.sources[0]).toMatchObject({ status: "partial" });
  expect(await reader.scan(roots, signal, window)).toMatchObject({
    records: scan.records,
    work: { bytes: 0, files: 0 },
  });
  await appendFile(
    file,
    encode([context("new"), token(counts(220, 22), counts(10, 1)), done("new")]),
  );
  const recovered = await reader.scan(roots, signal, window);
  expect(recovered.records.find((r) => r.id === "new")).toMatchObject({
    tokens: { inputTokens: 10, outputTokens: 1 },
    partial: false,
    basis: "delta",
  });
});

for (const end of [true, false]) {
  it(`cannot certify continuity between unidentified contexts, terminal=${end}`, () => {
    const reducer = makeHistoryReducer("codex");
    reducer.consume(raw("session_meta", { id: "session" }));
    reducer.consume(token(counts(0, 0), null));
    reducer.consume(raw("turn_context", { model: "old" }));
    if (end) reducer.consume(raw("event_msg", { type: "task_complete" }));
    reducer.consume(raw("turn_context", { model: "actual" }));
    reducer.consume(token(counts(110, 11), counts(10, 1)));
    expect([...reducer.records.values()]).toMatchObject([
      {
        tokens: { inputTokens: 10, outputTokens: 1 },
        partial: true,
        basis: "last-request",
        nativeIds: [],
        complete: false,
      },
    ]);
  });
}
it("retains late independently identified modern usage without using it as a cumulative baseline", () => {
  const reducer = begin();
  reducer.consume(context("gap"));
  reducer.consume(done("gap"));
  reducer.consume(
    raw("token_usage_record", {
      thread_id: "session",
      turn_id: "gap",
      response_id: "late-response",
      usage: counts(100, 10),
      turn_token_usage: counts(100, 10),
    }),
  );
  const late = reducer.records.get("response:late-response");
  expect(late).toMatchObject({
    tokens: { inputTokens: 100, outputTokens: 10 },
    basis: "delta",
    partial: false,
  });
  // Terminal proof for that response group is incomplete until an actual matching terminal record.
  expect(
    [...canonicalHistory([...reducer.records.values()]).unique.values()].find((r) => r.id === "gap")
      ?.complete,
  ).toBe(false);
  reducer.consume(done("gap"));
  expect(
    [...canonicalHistory([...reducer.records.values()]).unique.values()].find((r) => r.id === "gap")
      ?.complete,
  ).toBe(true);
  reducer.consume(context("current"));
  reducer.consume(token(counts(210, 21), counts(10, 1)));
  reducer.consume(done("current"));
  expect(reducer.records.get("current")).toMatchObject({
    tokens: { inputTokens: 10, outputTokens: 1 },
    partial: true,
    basis: "last-request",
  });
});

for (const invalidId of [undefined, null, "", {}, "x".repeat(257)]) {
  it(`closes counter admission at an unidentified terminal ${JSON.stringify(invalidId)}`, () => {
    const reducer = begin();
    reducer.consume(context("selected"));
    reducer.consume(token(counts(110, 11), counts(10, 1)));
    const uncertain = raw("event_msg", { type: "task_complete", turn_id: invalidId });
    reducer.consume(uncertain);
    reducer.consume(uncertain);
    reducer.consume(token(counts(110, 11), counts(10, 1)));
    reducer.consume(raw("event_msg", { type: "token_count", info: null }));
    reducer.consume(raw("event_msg", { type: "task_started", turn_id: "selected" }));
    reducer.consume(context("selected"));
    reducer.consume(token(counts(110, 11), counts(10, 1)));
    expect(reducer.records.get("selected")).toMatchObject({
      tokens: { inputTokens: 10, outputTokens: 1 },
      partial: true,
      complete: false,
      nativeIds: ["selected"],
      model: "actual",
    });
    // Response identity still proves a known request, without inventing terminal identity.
    const response = raw("token_usage_record", {
      thread_id: "session",
      turn_id: "selected",
      response_id: "response",
      usage: counts(10, 1),
      turn_token_usage: counts(10, 1),
    });
    reducer.consume(response);
    reducer.consume(response);
    expect(
      [...canonicalHistory([...reducer.records.values()]).unique.values()].find(
        (r) => r.id === "selected",
      ),
    ).toMatchObject({ tokens: { inputTokens: 10, outputTokens: 1 }, complete: false });
    reducer.consume(done("selected"));
    expect(
      [...canonicalHistory([...reducer.records.values()]).unique.values()].find(
        (r) => r.id === "selected",
      ),
    ).toMatchObject({ tokens: { inputTokens: 10, outputTokens: 1 }, complete: true });
    reducer.consume(context("new"));
    reducer.consume(token(counts(210, 21), counts(0, 0)));
    reducer.consume(done("new"));
    expect(reducer.records.get("new")).toMatchObject({
      tokens: { inputTokens: 0, outputTokens: 0 },
      partial: true,
      basis: "last-request",
    });
  });
}
it("older identified replay with an unidentified terminal cannot break the current observed baseline", () => {
  const reducer = begin();
  reducer.consume(context("current"));
  reducer.consume(token(counts(110, 11), counts(10, 1)));
  reducer.consume(done("current"));
  reducer.consume(context("prior"));
  reducer.consume(raw("event_msg", { type: "task_complete" }));
  reducer.consume(token(counts(100, 10), counts(100, 10)));
  reducer.consume(context("new"));
  reducer.consume(token(counts(120, 12), counts(10, 1)));
  reducer.consume(done("new"));
  expect(reducer.records.get("new")).toMatchObject({
    tokens: { inputTokens: 10, outputTokens: 1 },
    basis: "delta",
    partial: false,
  });
});

for (const last of [counts(0, 0), undefined]) {
  it(`historical cap refusal keeps prior known amounts and next last=${JSON.stringify(last)}`, () => {
    const reducer = makeHistoryReducer("codex");
    reducer.consume(raw("session_meta", { id: "session" }));
    reducer.consume(token(counts(0, 0), null));
    reducer.consume(context("old"));
    for (let i = 1; i <= 4097; i++) reducer.consume(token(counts(i, 0), counts(1, 0)));
    reducer.consume(done("old"));
    expect(reducer.records.get("old")).toMatchObject({
      tokens: { inputTokens: 4096, outputTokens: 0 },
      partial: true,
    });
    reducer.consume(context("new"));
    reducer.consume(token(counts(4100, 0), last));
    reducer.consume(done("new"));
    if (last === undefined) expect(reducer.records.get("new")).toBeUndefined();
    else
      expect(reducer.records.get("new")).toMatchObject({
        tokens: { inputTokens: 0, outputTokens: 0 },
        partial: true,
        basis: "last-request",
      });
    reducer.consume(context("observed"));
    reducer.consume(token(counts(4101, 0), counts(1, 0)));
    reducer.consume(done("observed"));
    expect(reducer.records.get("observed")).toMatchObject({
      tokens: { inputTokens: 1, outputTokens: 0 },
      partial: false,
      basis: "delta",
    });
  });
}
