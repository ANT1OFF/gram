import { describe, expect, it } from "vitest";
import { makeHistoryReducer } from "./history-records.ts";
import { canonicalHistory } from "./history-canonical.ts";
const timestamp = "2026-10-06T12:00:00Z";
const raw = (type: string, payload: object) => ({ type, timestamp, payload });
const counts = (input_tokens: number, output_tokens = 1) => ({
  input_tokens,
  output_tokens,
  cached_input_tokens: 0,
  reasoning_output_tokens: 0,
  cache_write_input_tokens: 0,
});
const context = (turn_id = "turn", model = "actual-model") =>
  raw("turn_context", { turn_id, model });
const token = (total: object | undefined, last: object | undefined) =>
  raw("event_msg", {
    type: "token_count",
    info: { total_token_usage: total, last_token_usage: last },
  });
const meta = (id = "session", extra = {}) => raw("session_meta", { id, ...extra });
const done = (turn_id = "turn") => raw("event_msg", { type: "task_complete", turn_id });
const modern = (response_id: string, usage: object, turn_token_usage: object, extra = {}) =>
  raw("token_usage_record", {
    thread_id: "session",
    turn_id: "turn",
    response_id,
    usage,
    turn_token_usage,
    ...extra,
  });
const reduce = (events: object[]) => {
  const reducer = makeHistoryReducer("codex");
  events.forEach((event) => reducer.consume(event));
  return reducer;
};
const rows = (events: object[]) => [
  ...canonicalHistory([...reduce(events).records.values()]).unique.values(),
];

describe("pinned Codex rollout accounting", () => {
  it("carries an unknown first baseline and later unproven reset across the whole native turn", () => {
    for (const events of [
      [
        meta(),
        context(),
        token(counts(100, 10), undefined),
        token(counts(110, 11), counts(10)),
        done(),
      ],
      [
        meta(),
        token(counts(100, 10), undefined),
        context(),
        token(counts(110, 11), counts(10)),
        token(counts(1, 0), undefined),
        done(),
      ],
    ]) {
      expect(rows(events)[0]).toMatchObject({
        tokens: { inputTokens: 10, outputTokens: 1 },
        partial: true,
        complete: true,
      });
    }
  });
  it("does not replay an older stable native turn or rewind the baseline for the next new turn", () => {
    const first = [context("first"), token(counts(110, 11), counts(10)), done("first")];
    const reducer = reduce([
      meta(),
      token(counts(100, 10), undefined),
      ...first,
      context("second"),
      token(counts(120, 12), counts(10)),
      done("second"),
      ...first,
      context("third"),
      token(counts(130, 13), counts(10)),
      done("third"),
    ]);
    expect(reducer.invalid).toBeGreaterThan(0);
    expect([...reducer.records.values()].map((record) => record.tokens.inputTokens)).toEqual([
      10, 10, 10,
    ]);
  });
  it("keeps missing and contradictory model evidence across equal snapshots and repeated starts", () => {
    const data = rows([
      meta(),
      token(counts(100, 10), undefined),
      context("turn", "one"),
      token(counts(110, 11), counts(10)),
      raw("event_msg", { type: "task_started", turn_id: "turn" }),
      raw("event_msg", { type: "model_reroute", to_model: "two" }),
      token(counts(110, 11), counts(10)),
      done(),
    ]);
    expect(data[0]).toMatchObject({
      model: null,
      modelConflict: true,
      tokens: { inputTokens: 10 },
    });
  });
  it("seeds idle resumed counters without charging them, then attributes observed differences", () => {
    const data = rows([
      meta(),
      token(counts(1000), counts(10)),
      context(),
      token(counts(1010, 2), counts(10)),
      done(),
    ]);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      tokens: { inputTokens: 10, outputTokens: 1 },
      basis: "delta",
      partial: false,
      complete: true,
      model: "actual-model",
    });
  });
  it("retains a known first request but marks absent/reset baselines incomplete", () => {
    const data = rows([meta(), context(), token(counts(1010), counts(10)), done()]);
    expect(data[0]).toMatchObject({
      tokens: { inputTokens: 10 },
      basis: "last-request",
      partial: true,
    });
    expect(rows([meta(), context(), token(counts(1010), undefined), done()])).toEqual([]);
  });
  it("groups per-response records by exact native turn and suppresses duplicate counter summaries", () => {
    const data = rows([
      meta(),
      context(),
      modern("response-a", counts(10), counts(10)),
      modern("response-a", counts(10), counts(10)),
      modern("response-b", counts(10), counts(20, 2)),
      token(counts(20, 2), counts(10)),
      done(),
    ]);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      nativeIds: ["turn"],
      tokens: { inputTokens: 20, outputTokens: 2 },
      complete: true,
      partial: false,
      basis: "delta",
    });
  });
  it("does not replace a Gram turn when modern responses cannot prove the whole native turn", () => {
    expect(
      rows([meta(), context(), modern("a", counts(10), counts(20, 2)), done()])[0]?.complete,
    ).toBe(false);
    expect(rows([meta(), context(), modern("a", counts(10), counts(10))])[0]?.complete).toBe(false);
  });
  it("does not mint incoming markers or trust inherited modern requests", () => {
    const data = rows([
      meta(),
      context(),
      modern("a", counts(10), counts(10), { telemetryVersion: "arbitrary" }),
      done(),
    ]);
    expect(data[0]?.basis).toBe("delta");
    expect(
      rows([
        meta("child", { forked_from_id: "session" }),
        context(),
        modern("a", counts(10), counts(10)),
        done(),
      ]),
    ).toEqual([]);
    expect(
      rows([
        meta("session", { parent_thread_id: "main" }),
        context(),
        modern("a", counts(10), counts(10)),
        done(),
      ]),
    ).toEqual([]);
  });
  it("uses actual context/model reroute only and leaves conflicting model attribution Unknown", () => {
    const data = rows([
      meta(),
      context(),
      modern("a", counts(10), counts(10)),
      raw("event_msg", { type: "model_reroute", to_model: "actual-new" }),
      modern("b", counts(10), counts(20, 2)),
      done(),
    ]);
    expect(data[0]?.model).toBeNull();
    expect(rows([meta(), modern("a", counts(10), counts(10)), done()])[0]?.model).toBeNull();
  });
  it("rejects conflicting responses and refuses later session metadata to change ownership", () => {
    const reducer = reduce([
      meta(),
      context(),
      modern("a", counts(10), counts(10)),
      modern("a", counts(11), counts(11)),
      meta("different"),
    ]);
    expect(reducer.owner).toBe("session");
    expect(canonicalHistory([...reducer.records.values()]).unique.size).toBe(0);
    expect(
      rows([raw("session_meta", {}), meta(), context(), modern("a", counts(10), counts(10))]),
    ).toEqual([]);
  });
  it("clears stale context after corruption but preserves native ancestry outside the window", () => {
    const reducer = reduce([meta(), context(), token(counts(100), counts(10))]);
    reducer.breakContext();
    reducer.consume(token(counts(110, 2), counts(10)));
    expect([...reducer.records.values()][0]?.tokens.inputTokens).toBe(10);
    reducer.window(Date.parse("2026-10-07T00:00:00Z"), Infinity);
    expect(reducer.records.size).toBe(0);
    expect([...reducer.nativeTurnIds]).toEqual(["turn"]);
  });
});

const assistant = (uuid: string | undefined, extra = {}) => ({
  type: "assistant",
  timestamp,
  sessionId: "claude-session",
  uuid,
  requestId: "request",
  message: {
    id: "message",
    model: "wire-model",
    usage: {
      input_tokens: 7,
      output_tokens: 2,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 3,
    },
  },
  ...extra,
});
describe("Claude request identity", () => {
  it("keeps cache lanes distinct and deduplicates repeated blocks without copying Codex markers", () => {
    const reducer = makeHistoryReducer("claude");
    reducer.consume(assistant("one", { telemetryVersion: "codex-request-delta-v1" }));
    reducer.consume(assistant("two"));
    expect([...reducer.records.values()][0]).toMatchObject({
      nativeIds: ["one", "two"],
      tokens: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 20, cacheWriteTokens: 3 },
      model: "wire-model",
      complete: true,
    });
    expect([...reducer.records.values()][0]?.basis).toBeUndefined();
  });
  it("retains known amounts without manufacturing negative UUID identity evidence", () => {
    const reducer = makeHistoryReducer("claude");
    reducer.consume(assistant(undefined));
    reducer.consume(assistant("later"));
    expect([...reducer.records.values()][0]?.complete).toBe(false);
  });
  it("excludes positive SDK fork copies and nested requests", () => {
    const reducer = makeHistoryReducer("claude");
    reducer.consume(
      assistant("copy", { forkedFrom: { sessionId: "parent", messageUuid: "original" } }),
    );
    reducer.consume(assistant("nested", { isSidechain: true }));
    expect(reducer.records.size).toBe(0);
    expect(reducer.ambiguous).toBe(1);
  });
});
