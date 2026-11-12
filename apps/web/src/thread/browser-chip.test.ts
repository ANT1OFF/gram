import { describe, expect, it } from "vitest";

import { browserChipText } from "./browser-chip";

const codex = { model: { agent: "codex" as const, model: "gpt" } };

describe("browserChipText", () => {
  it("shows nothing until the server answers, and nothing for a thread not lent it", () => {
    expect(browserChipText(codex, undefined)).toBeUndefined();
    expect(browserChipText(codex, { state: "off", cannot: "x" })).toBeUndefined();
  });

  it("says what is in effect: on, held back, or not available", () => {
    expect(browserChipText(codex, { state: "on" })).toMatchObject({ label: "Your browser" });
    expect(browserChipText(codex, { state: "held", why: "It's off." })?.hint).toBe(
      "Lent your browser, but it doesn't get it: It's off.",
    );
    // A gated Codex thread never claims the browser is on.
    expect(
      browserChipText(codex, { state: "unavailable", why: "In Gram's own Codex home." }),
    ).toEqual({ label: "Browser not available", hint: "In Gram's own Codex home." });
  });
});
