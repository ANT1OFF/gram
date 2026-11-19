import { describe, expect, it } from "@effect/vitest";

import { AgentUnavailable, KEPT_WORK_GONE_CODE } from "@gram/contracts";
import { failureText, keptWorkGoneError } from "./thread-error.ts";

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

describe("keptWorkGoneError", () => {
  const reason = "Its saved work is gone from the remote.";
  it("marks a session its machine holds off for saved work that is gone, and nothing else", () => {
    const held = new AgentUnavailable({
      agent: "claude",
      reason: "startup-failed",
      message: reason,
    });
    // Before, the thread said its folder no longer exists, and offered no way out.
    expect(keptWorkGoneError(held, reason, 5)).toEqual({
      kind: "unknown",
      retryable: false,
      code: KEPT_WORK_GONE_CODE,
      text: reason,
      at: 5,
    });
    const other = new AgentUnavailable({ agent: "claude", message: "Its folder isn't there." });
    expect(keptWorkGoneError(other, reason, 5)).toBeUndefined();
  });
});
