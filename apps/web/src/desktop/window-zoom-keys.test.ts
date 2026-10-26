import { describe, expect, it } from "vitest";

import { windowZoomStep } from "./window-zoom-keys";

const press = (
  key: string,
  mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey", boolean>> = {},
) => ({
  key,
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

describe("windowZoomStep", () => {
  it("goes by the character typed, wherever the layout puts it", () => {
    // Nordic `+` is unshifted, US `+` is Shift+`=`, and ⌘= is the US habit: all three are "in".
    expect(windowZoomStep(press("+"), true)).toBe("in");
    expect(windowZoomStep(press("="), true)).toBe("in");
    expect(windowZoomStep(press("-"), true)).toBe("out");
    expect(windowZoomStep(press("0"), true)).toBe("reset");
  });

  it("leaves the keys to an IME that is composing", () => {
    expect(windowZoomStep({ ...press("+"), isComposing: true }, true)).toBeUndefined();
    expect(windowZoomStep({ ...press("-"), keyCode: 229 }, true)).toBeUndefined();
    expect(windowZoomStep({ ...press("-"), isComposing: false, keyCode: 189 }, true)).toBe("out");
  });

  it("wants ⌘ alone, and only on macOS", () => {
    expect(windowZoomStep(press("+", { metaKey: false }), true)).toBeUndefined();
    expect(windowZoomStep(press("+", { ctrlKey: true }), true)).toBeUndefined();
    expect(windowZoomStep(press("-", { altKey: true }), true)).toBeUndefined();
    expect(windowZoomStep(press("+"), false)).toBeUndefined();
    expect(windowZoomStep(press("a"), true)).toBeUndefined();
  });
});
