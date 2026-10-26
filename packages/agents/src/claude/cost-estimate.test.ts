import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { advertisedRate, learnedRate, listRate, weightedTokens } from "./cost-estimate.ts";

const entry = (fields: Partial<ModelUsage>): ModelUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD: 0,
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  ...fields,
});

describe("weightedTokens", () => {
  it("weighs output, cache reads and cache writes against an input token", () => {
    expect(
      weightedTokens({
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 40,
        reasoningTokens: 8,
      }),
    ).toBe(100 + 50 + 100 + 50);
    expect(weightedTokens({ inputTokens: 3, outputTokens: 1 })).toBe(8);
  });
});

describe("advertisedRate", () => {
  it("reads the input price off the SDK's model description", () => {
    expect(advertisedRate("Sonnet 5 · Efficient for routine tasks · $2/$10 per Mtok")).toBe(2e-6);
    expect(advertisedRate("Fable 5.1 · Most capable · $10/$50 per Mtok")).toBe(10e-6);
    expect(advertisedRate("Half price · $0.5/$2.50 per Mtok")).toBe(0.5e-6);
  });

  it("is undefined for a description that names no price", () => {
    expect(advertisedRate("Custom model")).toBeUndefined();
    expect(advertisedRate(undefined)).toBeUndefined();
  });
});

describe("listRate", () => {
  it("knows the families and nothing else", () => {
    expect(listRate("claude-fable-5-1[1m]")).toBe(10e-6);
    expect(listRate("claude-opus-4-7")).toBe(5e-6);
    expect(listRate("claude-sonnet-5")).toBe(2e-6);
    expect(listRate("claude-sonnet-5-20260301")).toBe(2e-6);
    expect(listRate("us.anthropic.claude-sonnet-4-6-v1:0")).toBe(3e-6);
    expect(listRate("claude-haiku-4-5-20251001")).toBe(1e-6);
    expect(listRate("a-claude-haiku-4.5")).toBe(1e-6);
    expect(listRate("claude-haiku-5-5")).toBe(0.1e-6);
    expect(listRate("some-gateway-alias[1m]")).toBeUndefined();
  });
});

describe("learnedRate", () => {
  it("is what the session was charged per input-token equivalent", () => {
    // Half of list: a managed multiplier, which no table here could know.
    const rate = learnedRate(
      entry({
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadInputTokens: 10_000,
        costUSD: 0.0075,
      }),
    );
    expect(rate).toBeCloseTo(2.5e-6, 12);
  });

  it("is undefined for an entry that has priced nothing, or is missing its counts", () => {
    expect(learnedRate(entry({}))).toBeUndefined();
    expect(learnedRate(entry({ inputTokens: 500 }))).toBeUndefined();
    expect(learnedRate({ contextWindow: 200_000 } as ModelUsage)).toBeUndefined();
  });
});
