import { describe, expect, it } from "vitest";

import { derivedTitle } from "./thread-title.ts";

describe("derivedTitle", () => {
  it("drops the full stop and keeps a short task whole", () => {
    expect(derivedTitle("Add retry coverage for the queue consumer.")).toBe(
      "Add retry coverage for the queue consumer",
    );
  });

  it("takes the first sentence of the first non-empty line", () => {
    expect(
      derivedTitle("\n  Fix the flaky retry test. It fails on CI about once a day.\nMore"),
    ).toBe("Fix the flaky retry test");
  });

  it("cuts a long sentence at a clause, else at a word boundary", () => {
    expect(
      derivedTitle(
        "Add retry coverage for the queue consumer, and make the backoff exponential with jitter",
      ),
    ).toBe("Add retry coverage for the queue consumer");
    expect(
      derivedTitle(
        "Rewrite the settings search index to rank exact label matches above descriptions",
      ),
    ).toBe("Rewrite the settings search index to rank exact");
  });

  it("names the work, not the asking", () => {
    expect(derivedTitle("please fix the dark mode toggle")).toBe("Fix the dark mode toggle");
    expect(derivedTitle("Can you bump the dependencies?")).toBe("Bump the dependencies?");
  });

  it("stays within 60 characters", () => {
    const title = derivedTitle(
      "Internationalisation-ready pluralisation helpers for notification-centre microcopy everywhere",
    );
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title).not.toBe("");
  });

  it("falls back to New thread", () => {
    expect(derivedTitle(undefined)).toBe("New thread");
    expect(derivedTitle("   \n ")).toBe("New thread");
    expect(derivedTitle("...")).toBe("New thread");
  });
});
