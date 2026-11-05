import { describe, expect, it } from "@effect/vitest";

import { failureText } from "./thread-error.ts";

describe("failureText", () => {
  it("states a rate limit without guessing when it clears", () => {
    // "Try again in a moment" sat beside the card's "when this clears isn't known": the card says
    // what is known about the reset, so the sentence says only what happened.
    const text = failureText(
      { kind: "rateLimit", retryable: true, httpStatus: 429 },
      "429 Too Many Requests",
      { gateway: false },
    );
    expect(text).toBe("The provider is rate limiting requests (HTTP 429).");
    expect(failureText({ kind: "rateLimit", retryable: true }, "", { gateway: true })).toBe(
      "The gateway is rate limiting requests.",
    );
  });
});
