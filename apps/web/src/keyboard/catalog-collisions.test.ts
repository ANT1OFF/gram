import { describe, expect, it } from "vitest";

import { SHORTCUT_CATALOG } from "./catalog";
import { parseKeys } from "./registry";

/** The chord a default resolves to on a platform: off macOS, `mod` is the Control key. */
const chordOn = (keys: string, mac: boolean) => {
  const chord = parseKeys(keys);
  const meta = mac && chord.mod;
  const ctrl = mac ? chord.ctrl : chord.mod || chord.ctrl;
  return `${meta ? "meta+" : ""}${ctrl ? "ctrl+" : ""}${chord.alt ? "alt+" : ""}${chord.shift ? "shift+" : ""}${chord.key}`;
};

describe("layout preset shortcuts", () => {
  it.each([true, false])("don't collide with any other default binding (mac: %s)", (mac) => {
    const presets = SHORTCUT_CATALOG.filter((d) => d.id.startsWith("layout.preset"));
    expect(presets.map((d) => d.keys)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `ctrl+shift+${n}`));

    const others = new Map(
      SHORTCUT_CATALOG.filter((d) => !d.id.startsWith("layout.preset")).map((d) => [
        chordOn(d.keys, mac),
        d.id,
      ]),
    );
    for (const preset of presets) {
      expect(others.get(chordOn(preset.keys, mac)), preset.id).toBeUndefined();
    }
    // The pane jumps are the nearest neighbours: same digits, no Shift.
    expect(chordOn("mod+3", mac)).not.toBe(chordOn("ctrl+shift+3", mac));
  });
});
