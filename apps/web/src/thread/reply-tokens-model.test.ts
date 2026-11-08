import { describe, expect, it } from "vitest";

import { cachedShare, replyTokens } from "./reply-tokens-model";

describe("a reply's token line", () => {
  it("adds up what the turn read and wrote, and says what makes it up", () => {
    const tokens = replyTokens({
      tokens: {
        inputTokens: 1_200,
        outputTokens: 840,
        cacheReadTokens: 41_000,
        cacheWriteTokens: 2_300,
        reasoningTokens: 300,
      },
      contextWindow: 200_000,
      contextTokens: 44_500,
    })!;
    expect(tokens.total).toBe(45_340);
    expect(tokens.label).toBe("45.3K tokens");
    expect(tokens.rows.map((row) => [row.label, row.value, row.part ?? false])).toEqual([
      ["Input", "1,200", false],
      ["Cache read", "41,000", false],
      ["Cache write", "2,300", false],
      ["Output", "840", false],
      ["Thinking", "300", true],
    ]);
    expect(tokens.context).toEqual({ tokens: 44_500, window: 200_000, percent: 22 });
    expect(cachedShare(tokens)).toBe(90);
  });

  it("leaves out what the agent didn't report, and says a partial count is a floor", () => {
    const tokens = replyTokens({ tokens: { inputTokens: 900, outputTokens: 100 }, partial: true })!;
    expect(tokens.label).toBe("≥ 1K tokens");
    expect(tokens.rows.map((row) => row.key)).toEqual(["input", "output"]);
    expect(tokens.context).toEqual({});
    expect(cachedShare(tokens)).toBeUndefined();
  });

  it("shows nothing for a reply without a stamp, or a turn that used no tokens", () => {
    expect(replyTokens(undefined)).toBeUndefined();
    expect(replyTokens({ tokens: { inputTokens: 0, outputTokens: 0 } })).toBeUndefined();
  });
});
