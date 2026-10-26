// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { formatKeys, keysFromEvent, matches } from "./registry";

const press = (init: KeyboardEventInit & { key: string; code: string }) =>
  new KeyboardEvent("keydown", init);

/** Records `event`, then checks the recorded keys answer to the same press. */
const recordOn = (event: KeyboardEvent, mac: boolean) => {
  const keys = keysFromEvent(event, mac);
  if (keys !== undefined) expect(matches(keys, event, mac), keys).toBe(true);
  return keys;
};

describe("keysFromEvent", () => {
  it("records modifiers and physical letters on macOS", () => {
    expect(recordOn(press({ key: "K", code: "KeyK", metaKey: true, shiftKey: true }), true)).toBe(
      "mod+shift+k",
    );
    expect(
      recordOn(
        press({ key: "“", code: "BracketLeft", ctrlKey: true, altKey: true, shiftKey: true }),
        true,
      ),
    ).toBe("ctrl+alt+shift+[");
    expect(formatKeys("ctrl+alt+shift+[", true)).toBe("⌃⌥⇧[");
  });

  it("records Ctrl+Shift+digits and brackets by the physical key off macOS", () => {
    expect(
      recordOn(press({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }), false),
    ).toBe("mod+shift+1");
    expect(
      recordOn(press({ key: "{", code: "BracketLeft", ctrlKey: true, shiftKey: true }), false),
    ).toBe("mod+shift+[");
  });

  it("keeps a typed character for keys matched by character, and names F-keys and Space", () => {
    expect(recordOn(press({ key: ";", code: "Semicolon", metaKey: true }), true)).toBe("mod+;");
    expect(recordOn(press({ key: "F2", code: "F2" }), true)).toBe("f2");
    expect(recordOn(press({ key: " ", code: "Space", metaKey: true }), true)).toBe("mod+space");
    expect(formatKeys("mod+space", true)).toBe("⌘Space");
  });

  it("records nothing for a lone modifier or a key a keys string can't name", () => {
    expect(keysFromEvent(press({ key: "Shift", code: "ShiftLeft", shiftKey: true }), true)).toBe(
      undefined,
    );
    expect(keysFromEvent(press({ key: "Meta", code: "MetaLeft", metaKey: true }), true)).toBe(
      undefined,
    );
    expect(keysFromEvent(press({ key: "+", code: "Equal", shiftKey: true }), true)).toBe(undefined);
    expect(keysFromEvent(press({ key: "Dead", code: "Quote", altKey: true }), true)).toBe(
      undefined,
    );
  });
});
