// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { matches } from "./registry";

const press = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("bracket shortcuts", () => {
  it("match the physical key, whatever ⇧ turns it into", () => {
    const next = press({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true });
    expect(matches("mod+shift+]", next, true)).toBe(true);
    expect(matches("mod+shift+[", next, true)).toBe(false);
    expect(
      matches(
        "mod+shift+[",
        press({ key: "{", code: "BracketLeft", ctrlKey: true, shiftKey: true }),
        false,
      ),
    ).toBe(true);
    expect(
      matches("mod+shift+]", press({ key: "]", code: "BracketRight", metaKey: true }), true),
    ).toBe(false);
  });
});
