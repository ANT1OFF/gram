// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { matches } from "./registry";

const press = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("layout preset shortcuts", () => {
  it("match Ctrl+Shift+digit by physical key, on macOS and elsewhere", () => {
    const three = press({ key: "#", code: "Digit3", ctrlKey: true, shiftKey: true });
    expect(matches("ctrl+shift+3", three, true)).toBe(true);
    expect(matches("ctrl+shift+3", three, false)).toBe(true);
    expect(matches("ctrl+shift+4", three, true)).toBe(false);
    expect(
      matches(
        "ctrl+shift+3",
        press({ key: "#", code: "Digit3", metaKey: true, shiftKey: true }),
        true,
      ),
    ).toBe(false);
  });

  it("takes the zoom characters as typed, so a Nordic ⌘- is not ⌘/", () => {
    // Norwegian: `-` is on the US `/` key, `+` on the US `-` key.
    const nordicMinus = press({ key: "-", code: "Slash", metaKey: true });
    expect(matches("mod+-", nordicMinus, true)).toBe(true);
    expect(matches("mod+/", nordicMinus, true)).toBe(false);
    const nordicPlus = press({ key: "+", code: "Minus", metaKey: true });
    expect(matches("mod+-", nordicPlus, true)).toBe(false);

    // A US keyboard is unchanged: `/` and `-` are their own keys, and ⌘/ still goes by position.
    expect(matches("mod+/", press({ key: "/", code: "Slash", metaKey: true }), true)).toBe(true);
    expect(matches("mod+-", press({ key: "-", code: "Minus", metaKey: true }), true)).toBe(true);
    expect(matches("mod+=", press({ key: "=", code: "Equal", metaKey: true }), true)).toBe(true);
  });

  it("takes + for a binding on =, shifted on a US keyboard or a key of its own on a Nordic one", () => {
    const usPlus = press({ key: "+", code: "Equal", metaKey: true, shiftKey: true });
    const nordicPlus = press({ key: "+", code: "Minus", metaKey: true });
    expect(matches("mod+=", usPlus, true)).toBe(true);
    expect(matches("mod+=", nordicPlus, true)).toBe(true);
    // Still a chord: not without ⌘, and not with ⌥ added.
    expect(matches("mod+=", press({ key: "+", code: "Minus" }), true)).toBe(false);
    expect(
      matches("mod+=", press({ key: "+", code: "Minus", metaKey: true, altKey: true }), true),
    ).toBe(false);
  });
});
