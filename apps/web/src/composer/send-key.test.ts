import { describe, expect, it } from "vitest";

import { enterSends } from "./send-key";

const enter = (patch: Partial<Parameters<typeof enterSends>[0]> = {}) => ({
  key: "Enter",
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...patch,
});

describe("enterSends", () => {
  it("sends on plain Enter, and leaves Shift+Enter as a new line", () => {
    expect(enterSends(enter(), "enter")).toBe(true);
    expect(enterSends(enter({ shiftKey: true }), "enter")).toBe(false);
    expect(enterSends(enter({ key: "a" }), "enter")).toBe(false);
  });

  it("leaves modified Enter to the shortcuts that own it", () => {
    for (const patch of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }])
      expect(enterSends(enter(patch), "enter")).toBe(false);
  });

  it("never sends while an IME is composing", () => {
    expect(enterSends(enter({ isComposing: true }), "enter")).toBe(false);
    expect(enterSends(enter({ keyCode: 229 }), "enter")).toBe(false);
  });

  it("never sends on Enter when the user chose ⌘Enter", () => {
    expect(enterSends(enter(), "modEnter")).toBe(false);
  });

  it("sends nothing until settings have loaded and the choice is known", () => {
    expect(enterSends(enter(), undefined)).toBe(false);
  });
});
