// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { catalogKeys } from "./catalog";
import { dispatchShortcut, keysFromEvent, matches, registerShortcut } from "./registry";

const press = (init: KeyboardEventInit & { key: string; code: string }, target?: EventTarget) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  if (target) Object.defineProperty(event, "target", { value: target });
  return event;
};

// Off macOS, AltGr arrives as Ctrl+Alt with the character it typed.
const altGr = (key: string, code: string) => press({ key, code, ctrlKey: true, altKey: true });

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("AltGr off macOS", () => {
  it("is text, not a Ctrl+Alt shortcut", () => {
    // Norwegian AltGr+8 types `[`, Hungarian AltGr+B `{`, Czech AltGr+W `|`, Polish AltGr+A `ą`.
    expect(matches("mod+alt+8", altGr("[", "Digit8"), false)).toBe(false);
    expect(matches("mod+alt+b", altGr("{", "KeyB"), false)).toBe(false);
    expect(matches("mod+alt+w", altGr("|", "KeyW"), false)).toBe(false);
    expect(matches("mod+alt+a", altGr("ą", "KeyA"), false)).toBe(false);
  });

  it("leaves real Ctrl+Alt shortcuts working, by physical key", () => {
    // Ctrl+Alt+B on a US layout: "Show / hide right panel".
    expect(matches(catalogKeys("panel.toggle")!, altGr("b", "KeyB"), false)).toBe(true);
    expect(matches("mod+alt+8", altGr("8", "Digit8"), false)).toBe(true);
    // AZERTY: the key where US has W types `z`.
    expect(matches("mod+alt+w", altGr("z", "KeyW"), false)).toBe(true);
    // On macOS ⌃⌥ never means AltGr.
    expect(matches("ctrl+alt+[", altGr("[", "BracketLeft"), true)).toBe(true);
  });

  it("types the character in a text field instead of running a Ctrl+Alt shortcut", () => {
    const run = vi.fn();
    cleanups.push(
      registerShortcut({ id: "panel", keys: "mod+alt+b", label: "Panel", group: "App", run }),
    );
    const textarea = document.createElement("textarea");
    const typed = press({ key: "{", code: "KeyB", ctrlKey: true, altKey: true }, textarea);

    expect(dispatchShortcut(typed, false)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(typed.defaultPrevented).toBe(false);
  });

  it("records nothing for AltGr text or the Windows key", () => {
    expect(keysFromEvent(altGr("[", "Digit8"), false)).toBeUndefined();
    expect(keysFromEvent(altGr("@", "Digit2"), false)).toBeUndefined();
    expect(keysFromEvent(press({ key: "k", code: "KeyK", metaKey: true }), false)).toBeUndefined();

    expect(keysFromEvent(altGr("b", "KeyB"), false)).toBe("mod+alt+b");
    expect(keysFromEvent(press({ key: "k", code: "KeyK", metaKey: true }), true)).toBe("mod+k");
  });
});
