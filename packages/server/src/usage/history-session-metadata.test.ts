import { expect, it } from "vitest";
import { makeHistoryReducer } from "./history-records.ts";
import { canonicalHistory } from "./history-canonical.ts";

const timestamp = "2026-10-06T12:00:00Z";
const raw = (type: string, payload: object) => ({ type, payload, timestamp });
const meta = (payload: object) => raw("session_meta", payload);
const counts = (input_tokens: number) => ({ input_tokens, output_tokens: 0 });
const token = (total: number, last = total) =>
  raw("event_msg", {
    type: "token_count",
    info: { total_token_usage: counts(total), last_token_usage: counts(last) },
  });
const context = (turn_id: string) => raw("turn_context", { turn_id, model: "actual" });
const terminal = (turn_id: string) => raw("event_msg", { type: "task_complete", turn_id });
const request = (thread_id: string, turn_id: string, response_id: string, input = 3) =>
  raw("token_usage_record", {
    thread_id,
    turn_id,
    response_id,
    usage: counts(input),
    turn_token_usage: counts(input),
  });
const prefix = [meta({ id: "owner" }), token(0), context("prefix"), token(10)];
const conflicts = [
  { id: "other" },
  { id: "other", parent_thread_id: "owner" },
  { id: "other", forked_from_id: "owner" },
  { id: "owner", session_id: "other" },
  { id: "owner", session_id: 7 },
  { id: 7, session_id: "owner" },
  {},
  { id: "owner", forked_from_id: "parent" },
  { id: "owner", forked_from_id: 7 },
  { id: "owner", parent_thread_id: "parent" },
  { id: "owner", parent_thread_id: 7 },
  { id: "owner", source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } } },
  { id: "owner", source: { subagent: { thread_spawn: { parent_thread_id: 7 } } } },
  {
    id: "owner",
    parent_thread_id: "a",
    source: { subagent: { thread_spawn: { parent_thread_id: "b" } } },
  },
];
for (const closed of [false, true])
  for (const conflicting of conflicts) {
    it(`retains only the supported prefix after conflicting metadata closed=${closed} ${JSON.stringify(conflicting)}`, () => {
      const r = makeHistoryReducer("codex");
      [
        ...prefix,
        ...(closed ? [terminal("prefix")] : []),
        meta(conflicting),
        context("foreign"),
        token(100),
        terminal("prefix"),
        terminal("foreign"),
        meta({ id: "owner" }),
        context("returned"),
        token(110, 10),
        terminal("returned"),
      ].forEach((event) => r.consume(event));
      expect(r.owner).toBe("owner");
      expect(r.invalid).toBeGreaterThan(0);
      expect(r.identityComplete).toBe(false);
      expect([...r.nativeTurnIds]).toEqual(["prefix"]);
      const records = [...r.records.values()];
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        id: "prefix",
        session: "owner",
        model: "actual",
        tokens: { inputTokens: 10, outputTokens: 0 },
        complete: closed,
        trusted: true,
      });
      const projection = structuredClone(records);
      r.breakContext();
      [context("reset"), token(3), terminal("reset"), request("other", "foreign", "wrong")].forEach(
        (event) => r.consume(event),
      );
      expect([...r.records.values()]).toEqual(projection);
      expect(r.retainedBytes()).toBeLessThan(32 * 1024 * 1024);
    });
  }
for (const original of [
  { id: "owner", forked_from_id: "parent" },
  { id: "owner", parent_thread_id: "parent" },
  { id: "owner", source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } } },
])
  it(`same owner cannot remove initially captured ancestry ${JSON.stringify(original)}`, () => {
    const r = makeHistoryReducer("codex");
    [
      meta(original),
      meta({ id: "owner" }),
      context("foreign"),
      token(100),
      terminal("foreign"),
    ].forEach((event) => r.consume(event));
    expect(r.owner).toBe("owner");
    expect(r.identityComplete).toBe(false);
    expect(r.invalid).toBeGreaterThan(0);
    expect(r.records.size).toBe(0);
    expect(r.nativeTurnIds.size).toBe(0);
  });
for (const replay of [
  { id: "owner" },
  { session_id: "owner" },
  { id: "owner", session_id: "owner" },
  { id: "owner", forked_from_id: null, parent_thread_id: null },
])
  for (const closed of [false, true])
    it(`consistent alias replay preserves continuity closed=${closed} ${JSON.stringify(replay)}`, () => {
      const r = makeHistoryReducer("codex");
      [
        ...prefix,
        ...(closed ? [terminal("prefix")] : []),
        meta(replay),
        ...(closed ? [context("next")] : []),
        token(100, 90),
        terminal(closed ? "next" : "prefix"),
      ].forEach((event) => r.consume(event));
      expect(r.invalid).toBe(0);
      expect(r.identityComplete).toBe(true);
      expect([...r.records.values()].reduce((sum, x) => sum + x.tokens.inputTokens, 0)).toBe(100);
      expect([...r.records.values()].every((x) => x.complete && x.trusted)).toBe(true);
    });
it("equivalent direct and spawned parent metadata keeps a nested session excluded", () => {
  const r = makeHistoryReducer("codex");
  [
    meta({ id: "owner", parent_thread_id: "parent" }),
    meta({
      session_id: "owner",
      source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } },
    }),
    context("nested"),
    token(10),
    request("owner", "nested", "response"),
    terminal("nested"),
  ].forEach((event) => r.consume(event));
  expect(r.invalid).toBe(0);
  expect(r.identityComplete).toBe(true);
  expect(r.records.size).toBe(0);
});
for (const first of [
  {},
  { id: 5 },
  { id: "owner", session_id: "other" },
  { id: "owner", forked_from_id: 5 },
])
  it(`invalid first metadata cannot be repaired by a new owner ${JSON.stringify(first)}`, () => {
    const r = makeHistoryReducer("codex");
    [
      meta(first),
      meta({ id: "owner" }),
      context("invented"),
      token(100),
      request("owner", "invented", "response"),
      terminal("invented"),
    ].forEach((event) => r.consume(event));
    expect(r.owner).toBeUndefined();
    expect(r.records.size).toBe(0);
    expect(r.identityComplete).toBe(false);
    expect(r.nativeTurnIds.size).toBe(0);
  });
it("unowned preceding telemetry cannot seed a later header or its native ancestry", () => {
  const r = makeHistoryReducer("codex");
  [
    token(0),
    context("unowned"),
    token(100),
    terminal("unowned"),
    meta({ id: "owner" }),
    context("owned"),
    token(110, 10),
    terminal("owned"),
  ].forEach((event) => r.consume(event));
  expect(r.owner).toBe("owner");
  expect(r.identityComplete).toBe(false);
  expect([...r.nativeTurnIds]).toEqual(["owned"]);
  expect([...r.records.values()]).toHaveLength(1);
  expect([...r.records.values()][0]).toMatchObject({
    session: "owner",
    id: "owned",
    tokens: { inputTokens: 10, outputTokens: 0 },
    partial: true,
    basis: "last-request",
  });
});
it("no header supplies no owner, amount or native identity proof", () => {
  const r = makeHistoryReducer("codex");
  [
    token(0),
    context("unowned"),
    token(100),
    request("owner", "unowned", "r"),
    terminal("unowned"),
  ].forEach((event) => r.consume(event));
  expect(r.owner).toBeUndefined();
  expect(r.records.size).toBe(0);
  expect(r.nativeTurnIds.size).toBe(0);
  expect(r.identityComplete).toBe(false);
});
it("independent original-owner modern request stays known once without borrowed model or terminal proof", () => {
  const r = makeHistoryReducer("codex");
  [
    ...prefix,
    terminal("prefix"),
    meta({ id: "other" }),
    context("foreign"),
    token(100),
    request("other", "foreign", "wrong"),
    request("owner", "independent", "actual"),
    request("owner", "independent", "actual"),
    terminal("independent"),
  ].forEach((event) => r.consume(event));
  const records = [...canonicalHistory([...r.records.values()]).unique.values()];
  expect(records).toHaveLength(2);
  expect(records.find((x) => x.id === "prefix")).toMatchObject({
    tokens: { inputTokens: 10 },
    model: "actual",
  });
  expect(records.find((x) => x.id === "independent")).toMatchObject({
    session: "owner",
    tokens: { inputTokens: 3 },
    model: null,
    complete: false,
    trusted: true,
  });
  expect([...r.nativeTurnIds]).toEqual(["prefix", "independent"]);
  expect(r.identityComplete).toBe(false);
});
for (const first of [false, true])
  for (const header of [
    { id: null, session_id: "owner" },
    { id: "owner", session_id: null },
  ])
    it(`malformed explicit owner aliases cannot certify identity first=${first} ${JSON.stringify(header)}`, () => {
      const r = makeHistoryReducer("codex");
      [
        ...(first ? [] : [meta({ id: "owner" })]),
        meta(header),
        meta({ id: "owner" }),
        context("bad"),
        token(10),
        terminal("bad"),
      ].forEach((event) => r.consume(event));
      expect(r.owner).toBe(first ? undefined : "owner");
      expect(r.records.size).toBe(0);
      expect(r.identityComplete).toBe(false);
      expect(r.invalid).toBeGreaterThan(0);
    });
