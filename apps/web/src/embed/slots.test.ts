import { describe, expect, it } from "vitest";

import { spokenStatus } from "./slots";

describe("a marked row's name for a screen reader", () => {
  it("says the mark's status after the name, and the name alone without one", () => {
    const row = { id: "bot", label: "Build bot", to: "/bots/build" };
    expect(
      spokenStatus({ ...row, mark: { status: "working", statusLabel: "Working" } }, "Build bot"),
    ).toBe("Build bot, Working");
    expect(spokenStatus({ ...row, mark: { shape: "square" } }, "Build bot")).toBe("Build bot");
    expect(spokenStatus(row, "Build bot")).toBe("Build bot");
  });
});
