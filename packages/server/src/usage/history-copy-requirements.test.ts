import { expect, it } from "vitest";
import { canonicalHistory } from "./history-canonical.ts";
import { makeHistoryReducer } from "./history-records.ts";
import type { HistoryRecord } from "./history-types.ts";

const at = "2026-10-06T12:00:00Z";
const amount = {
  input_tokens: 10,
  output_tokens: 3,
  cached_input_tokens: 2,
  cache_write_input_tokens: 1,
  reasoning_output_tokens: 2,
};
const e = (type: string, payload: object, timestamp = at) => ({ type, payload, timestamp });
const absent = Symbol("absent");
function rows(requirements: readonly unknown[], model: string | null = "actual", second = false) {
  const r = makeHistoryReducer("codex");
  r.consume(e("session_meta", { id: "owner" }));
  r.consume(e("turn_context", { turn_id: "native", model }));
  for (const requirement of requirements)
    r.consume(
      e("token_usage_record", {
        thread_id: "owner",
        turn_id: "native",
        response_id: "r1",
        usage: amount,
        ...(requirement === absent ? {} : { turn_token_usage: requirement }),
      }),
    );
  if (second)
    r.consume(
      e("token_usage_record", {
        thread_id: "owner",
        turn_id: "native",
        response_id: "r2",
        usage: amount,
        turn_token_usage: {
          input_tokens: 20,
          output_tokens: 6,
          cached_input_tokens: 4,
          cache_write_input_tokens: 2,
          reasoning_output_tokens: 4,
        },
      }),
    );
  r.consume(e("event_msg", { type: "task_complete", turn_id: "native" }));
  return [...r.records.values()];
}
// The copy at index 1 is the odd one out: these put it first, in the middle and last.
const permute = [
  [1, 0, 2],
  [0, 1, 2],
  [0, 2, 1],
];
const requirements = [
  {
    input_tokens: 20,
    output_tokens: 3,
    cached_input_tokens: 2,
    cache_write_input_tokens: 1,
    reasoning_output_tokens: 2,
  },
  { ...amount, output_tokens: 6 },
  { ...amount, cached_input_tokens: 5 },
  { ...amount, cache_write_input_tokens: 5 },
  { ...amount, reasoning_output_tokens: 3 },
];
// One requirement in every position of the odd copy; the rest once (the odd copy in the middle).
const requirementCases = [
  ...permute.map((order) => [requirements[0]!, order] as const),
  ...requirements.slice(1).map((requirement) => [requirement, permute[1]!] as const),
];
for (const [requirement, order] of requirementCases)
  it(`three physical copies preserve each positive requirement ${JSON.stringify(requirement)} order=${order}`, () => {
    const sources = [rows([amount]), rows([requirement]), rows([amount])];
    const input = order.flatMap((i) => sources[i]!);
    const original = structuredClone(input);
    const result = canonicalHistory(input);
    const record = [...result.unique.values()][0]!;
    expect(record.tokens).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      reasoningTokens: 2,
    });
    expect(record.complete).toBe(false);
    expect(record.model).toBe("actual");
    expect(record.at).toBe(Date.parse(at));
    expect(record.nativeIds).toEqual(["native"]);
    expect(result.duplicateRecords).toBe(2);
    expect(input).toEqual(original);
  });
for (const [order, model] of [
  [permute[0]!, "actual"],
  [permute[1]!, null],
  [permute[2]!, "actual"],
] as const)
  it(`real second response recovers complete requirements order=${order} model=${model}`, () => {
    const larger = {
      input_tokens: 20,
      output_tokens: 6,
      cached_input_tokens: 4,
      cache_write_input_tokens: 2,
      reasoning_output_tokens: 4,
    };
    const sources = [rows([amount], model), rows([larger], model, true), rows([larger], model)];
    const record = [...canonicalHistory(order.flatMap((i) => sources[i]!)).unique.values()][0]!;
    expect(record.tokens).toEqual({
      inputTokens: 20,
      outputTokens: 6,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      reasoningTokens: 4,
    });
    expect(record.complete).toBe(true);
    expect(record.model).toBe(model);
  });
for (const [requirement, reverse] of [
  [absent, false],
  [absent, true],
  [null, false],
  [{ ...amount, input_tokens: -1 }, true],
  [{ ...amount, cached_input_tokens: 11 }, false],
] as const)
  it(`missing or invalid evidence cannot be filled by another copy ${String(requirement)} reverse=${reverse}`, () => {
    const sources = [rows([amount]), rows([requirement])];
    const record = [
      ...canonicalHistory((reverse ? sources.toReversed() : sources).flat()).unique.values(),
    ][0]!;
    expect(record.tokens.inputTokens).toBe(10);
    expect(record.complete).toBe(false);
    expect(record.model).toBe("actual");
  });
for (const reverse of [false, true])
  it(`per-file decreasing requirement conflict remains latched reverse=${reverse}`, () => {
    const sources = [rows([amount, { ...amount, input_tokens: 5 }]), rows([amount])];
    const record = [
      ...canonicalHistory((reverse ? sources.toReversed() : sources).flat()).unique.values(),
    ][0]!;
    expect(record.tokens.inputTokens).toBe(10);
    expect(record.complete).toBe(false);
  });
it("incomparable requirement lanes retain both constraints", () => {
  const sources = [
    rows([{ ...amount, reasoning_output_tokens: 3 }]),
    rows([{ ...amount, cached_input_tokens: 5 }]),
  ];
  const record = [...canonicalHistory(sources.flat()).unique.values()][0]!;
  expect(record.expectedTurnTokens?.cacheReadTokens).toBe(5);
  expect(record.expectedTurnTokens?.reasoningTokens).toBe(3);
  expect(record.complete).toBe(false);
  expect(record.tokens.inputTokens).toBe(10);
});
const projection = (): HistoryRecord => rows([amount])[0]!;
for (const [requirement, reverse] of [
  [{ inputTokens: Number.MAX_SAFE_INTEGER - 1, outputTokens: 0 }, false],
  [{ inputTokens: Number.MAX_SAFE_INTEGER - 1, outputTokens: 0 }, true],
  [{ inputTokens: 10, outputTokens: 0, cacheReadTokens: 8 }, false],
] as const)
  it(`unsafe requirement union preserves safe amount and refuses later completion ${JSON.stringify(requirement)} reverse=${reverse}`, () => {
    const first = projection(),
      second = projection(),
      third = projection();
    first.expectedTurnTokens = requirement;
    second.expectedTurnTokens =
      requirement.outputTokens === 0 && requirement.inputTokens === 10
        ? { inputTokens: 10, outputTokens: 0, cacheWriteTokens: 8 }
        : { inputTokens: 10, outputTokens: 3 };
    const input = [first, second];
    if (reverse) input.reverse();
    input.push(third);
    const record = [...canonicalHistory(input).unique.values()][0]!;
    expect(record.tokens.inputTokens).toBe(10);
    expect(record.tokens.outputTokens).toBe(3);
    expect(record.complete).toBe(false);
  });
it("untrusted copy cannot lend requirements or completion", () => {
  const first = projection(),
    second = projection();
  second.trusted = false;
  second.expectedTurnTokens = { inputTokens: 20, outputTokens: 3 };
  const result = canonicalHistory([first, second]);
  expect([...result.unique.values()][0]!.complete).toBe(true);
  expect([...result.unique.values()][0]!.tokens.inputTokens).toBe(10);
  expect(result.omittedRecords).toBe(1);
});
for (const conflict of ["model", "time", "turn", "amount"])
  it(`actual duplicate identity conflict remains refused ${conflict}`, () => {
    const first = projection(),
      second = projection();
    if (conflict === "model") second.model = "other";
    if (conflict === "time") second.at++;
    if (conflict === "turn") second.turn = "other";
    if (conflict === "amount")
      second.tokens = { ...second.tokens, inputTokens: second.tokens.inputTokens + 1 };
    expect(canonicalHistory([first, second]).unique.size).toBe(0);
  });
it("optional absent and explicit zero requirements retain actual zero witnesses", () => {
  const zero = {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    reasoning_output_tokens: 0,
  };
  const r = makeHistoryReducer("codex");
  [
    e("session_meta", { id: "owner" }),
    e("turn_context", { turn_id: "native", model: "actual" }),
    e("token_usage_record", {
      thread_id: "owner",
      turn_id: "native",
      response_id: "r0",
      usage: zero,
      turn_token_usage: zero,
    }),
    e("event_msg", { type: "task_complete", turn_id: "native" }),
  ].forEach((x) => r.consume(x));
  const first = [...r.records.values()][0]!,
    second = structuredClone(first);
  second.expectedTurnTokens = { inputTokens: 0, outputTokens: 0 };
  const record = [...canonicalHistory([first, second, first]).unique.values()][0]!;
  expect(record.tokens.inputTokens).toBe(0);
  expect(record.complete).toBe(true);
  expect(record.expectedTurnTokens?.cacheReadTokens).toBe(0);
});
