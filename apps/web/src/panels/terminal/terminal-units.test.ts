import { createHash } from "node:crypto";
import { derivePalette, PRESET_PALETTES } from "@gram/themes";
import { useBindingsStore } from "@/keyboard/bindings-store";
import type { Shortcut } from "@/keyboard/registry";
import { DEFAULT_SYSTEM_PREFS } from "@/theme/theme";
import { describe, expect, it } from "vitest";

import { isAppShortcut, terminalClipboardKey } from "./keys";
import { terminalTheme } from "./terminal-theme";

const shortcut = (keys: string): Shortcut => ({
  id: keys,
  keys,
  label: keys,
  group: "App",
  run: () => {},
});

const key = (init: Partial<KeyboardEvent>) =>
  ({
    type: "keydown",
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  }) as KeyboardEvent;

const ctrl = (letter: string, code: string, extra: Partial<KeyboardEvent> = {}) =>
  key({ key: letter, code, ctrlKey: true, ...extra });

describe("isAppShortcut", () => {
  const shortcuts = [shortcut("mod+k"), shortcut("mod+b"), shortcut("mod+1"), shortcut("?")];

  it("leaves modifier shortcuts to the app", () => {
    expect(isAppShortcut(key({ key: "k", code: "KeyK", metaKey: true }), shortcuts, true)).toBe(
      true,
    );
    expect(isAppShortcut(key({ key: "1", code: "Digit1", ctrlKey: true }), shortcuts, false)).toBe(
      true,
    );
  });

  it("sends everything else to the shell", () => {
    expect(isAppShortcut(key({ key: "k", code: "KeyK" }), shortcuts, true)).toBe(false);
    expect(isAppShortcut(key({ key: "?", code: "Slash", shiftKey: true }), shortcuts, true)).toBe(
      false,
    );
    expect(isAppShortcut(key({ key: "c", code: "KeyC", ctrlKey: true }), shortcuts, true)).toBe(
      false,
    );
    expect(isAppShortcut(key({ key: "k", metaKey: true, type: "keyup" }), shortcuts, true)).toBe(
      false,
    );
  });

  it("sends AltGr text to the shell even when it looks like a Ctrl+Alt shortcut", () => {
    const panel = [shortcut("mod+alt+b")];
    // Hungarian AltGr+B types `{`; off macOS it arrives as Ctrl+Alt.
    const brace = key({ key: "{", code: "KeyB", ctrlKey: true, altKey: true });
    expect(isAppShortcut(brace, panel, false)).toBe(false);
    const ctrlAltB = key({ key: "b", code: "KeyB", ctrlKey: true, altKey: true });
    expect(isAppShortcut(ctrlAltB, panel, false)).toBe(true);
  });

  it("off macOS leaves plain Ctrl letters and punctuation to the shell", () => {
    const app: Shortcut[] = [
      shortcut("mod+b"),
      shortcut("mod+k"),
      shortcut("mod+w"),
      shortcut("mod+\\"),
      shortcut("mod+2"),
      shortcut("mod+,"),
      shortcut("mod+shift+p"),
      shortcut("mod+alt+w"),
      shortcut("ctrl+tab"),
      { ...shortcut("mod+f"), group: "Terminal" },
    ];

    for (const [letter, code] of [
      ["b", "KeyB"],
      ["k", "KeyK"],
      ["w", "KeyW"],
      ["\\", "Backslash"],
    ] as const) {
      expect(isAppShortcut(ctrl(letter, code), app, false), `Ctrl+${letter}`).toBe(false);
      expect(isAppShortcut(key({ key: letter, code, metaKey: true }), app, true)).toBe(true);
    }
    expect(isAppShortcut(ctrl("2", "Digit2"), app, false)).toBe(true);
    expect(isAppShortcut(ctrl(",", "Comma"), app, false)).toBe(true);
    expect(isAppShortcut(ctrl("P", "KeyP", { shiftKey: true }), app, false)).toBe(true);
    expect(isAppShortcut(ctrl("w", "KeyW", { altKey: true }), app, false)).toBe(true);
    expect(isAppShortcut(ctrl("Tab", "Tab"), app, false)).toBe(true);
    expect(isAppShortcut(ctrl("f", "KeyF"), app, false)).toBe(true);
    expect(isAppShortcut(ctrl("Tab", "Tab"), app, true)).toBe(true);
  });

  it("keeps Ctrl+Shift+C and Ctrl+Shift+V for the terminal off macOS, whatever the app binds", () => {
    const copyMessage = [shortcut("mod+shift+c"), shortcut("mod+shift+v")];
    const copy = key({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true });
    const paste = key({ key: "V", code: "KeyV", ctrlKey: true, shiftKey: true });
    expect(isAppShortcut(copy, copyMessage, false)).toBe(false);
    expect(isAppShortcut(paste, copyMessage, false)).toBe(false);
    expect(terminalClipboardKey(copy, false)).toBe("copy");
    expect(terminalClipboardKey(paste, false)).toBe("paste");
    // On macOS the chord is ⌘C, and ⌘V is the browser's own paste.
    expect(terminalClipboardKey(copy, true)).toBeUndefined();
    expect(terminalClipboardKey(key({ key: "c", code: "KeyC", metaKey: true }), true)).toBe("copy");
    expect(
      terminalClipboardKey(key({ key: "c", code: "KeyC", metaKey: true }), false),
    ).toBeUndefined();
    expect(
      terminalClipboardKey(key({ key: "v", code: "KeyV", metaKey: true }), true),
    ).toBeUndefined();
    const cmdShiftC = key({ key: "c", code: "KeyC", metaKey: true, shiftKey: true });
    expect(isAppShortcut(cmdShiftC, copyMessage, true)).toBe(true);
  });

  it("gives a disabled binding's keys back to the shell", () => {
    const palette = { ...shortcut("mod+k"), id: "palette.open" };
    const cmdK = key({ key: "k", code: "KeyK", metaKey: true });
    expect(isAppShortcut(cmdK, [palette], true)).toBe(true);
    useBindingsStore.setState({ overrides: { "palette.open": null } });
    try {
      expect(isAppShortcut(cmdK, [palette], true)).toBe(false);
    } finally {
      useBindingsStore.setState({ overrides: {} });
    }
  });
});

describe("terminalTheme", () => {
  it("preserves the exact ANSI matrix of all 22 existing presets", () => {
    const matrix = PRESET_PALETTES.slice(0, 22).flatMap((palette) =>
      (["standard", "more"] as const).map((contrast) => ({
        id: palette.id,
        contrast,
        ansi: derivePalette(palette, contrast).ansi,
      })),
    );
    // Frozen fb2ff2cb matrix, captured before the ANSI correction.
    expect(createHash("sha256").update(JSON.stringify(matrix)).digest("hex")).toBe(
      "af4596158d6f1f167b1c8809d1a059ebaebb32aaa9fedcf07b10b829f812ada6",
    );
  });

  it("uses the paired palette's ANSI set", () => {
    const prefs = { palette: "tokyo-night", mode: "system", contrast: "system" } as const;
    const dark = terminalTheme(prefs, [], DEFAULT_SYSTEM_PREFS);
    expect(dark).toMatchObject({ background: "#1a1b26", red: "#f7768e", brightBlack: "#565f89" });
    const light = terminalTheme(prefs, [], { ...DEFAULT_SYSTEM_PREFS, prefersDark: false });
    expect(light.background).toBe("#d5d6db");
  });
});
