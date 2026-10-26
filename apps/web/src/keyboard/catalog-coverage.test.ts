import { describe, expect, it } from "vitest";

import { SHORTCUT_CATALOG } from "./catalog";
import { parseKeys } from "./registry";

const specs = import.meta.glob<string>("../../e2e/*.spec.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

const PLAYWRIGHT_KEYS: Readonly<Record<string, string>> = {
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  bracketleft: "[",
  bracketright: "]",
  equal: "=",
  minus: "-",
};

/** A chord as `mod+ctrl+alt+shift+key`, whether it came from the catalog or a Playwright press. */
const chord = (mods: ReadonlySet<string>, key: string) =>
  [...["mod", "ctrl", "alt", "shift"].filter((m) => mods.has(m)), key].join("+");

const playwrightKey = (name: string) => {
  const lower = name.toLowerCase();
  if (/^key[a-z]$/.test(lower)) return lower.slice(3);
  if (/^digit[0-9]$/.test(lower)) return lower.slice(5);
  return PLAYWRIGHT_KEYS[lower] ?? lower;
};

const playwrightModifier = (name: string) =>
  ({ controlormeta: "mod", meta: "mod", control: "ctrl", alt: "alt", shift: "shift" })[
    name.toLowerCase()
  ];

/** A modified chord in a string literal, as specs pass them to `press` through a loop variable. */
const CHORD_LITERAL =
  /["'`]((?:(?:ControlOrMeta|Meta|Control|Alt|Shift)\+)+[\w?,./\\[\]=-]+)["'`]/g;

const parsePress = (keys: string, held: ReadonlySet<string>) => {
  const parts = keys.split("+");
  const key = playwrightKey(parts.pop()!);
  const mods = new Set([...held, ...parts.map(playwrightModifier).filter((m) => m !== undefined)]);
  return chord(mods, key);
};

/**
 * Every chord a spec presses: direct `press` calls, counting modifiers held with `keyboard.down`,
 * and modified chords in string literals.
 */
function pressedChords(source: string): Set<string> {
  const pressed = new Set<string>();
  for (const match of source.matchAll(CHORD_LITERAL)) pressed.add(parsePress(match[1]!, new Set()));
  const held = new Set<string>();
  for (const match of source.matchAll(/\.(press|down|up)\(\s*"([^"]+)"/g)) {
    const [, action, keys] = match;
    const modifier = playwrightModifier(keys!);
    if (action === "down" && modifier) held.add(modifier);
    else if (action === "up" && modifier) held.delete(modifier);
    else if (action === "press") pressed.add(parsePress(keys!, held));
  }
  return pressed;
}

const catalogChord = (keys: string) => {
  const { mod, ctrl, alt, shift, key } = parseKeys(keys);
  // `?` is typed with Shift, so a spec presses it as `?`.
  const mods = new Set([
    mod && "mod",
    ctrl && "ctrl",
    alt && "alt",
    shift && key !== "?" && "shift",
  ]);
  return chord(new Set([...mods].filter((m): m is string => typeof m === "string")), key);
};

describe("catalog coverage", () => {
  it("presses every catalog shortcut's default keys in some e2e spec", () => {
    const pressed = new Set(Object.values(specs).flatMap((source) => [...pressedChords(source)]));
    const unpressed = SHORTCUT_CATALOG.filter((d) => !pressed.has(catalogChord(d.keys))).map(
      (d) => `${d.id} (${d.keys})`,
    );
    expect(unpressed).toEqual([]);
  });

  it("reads Playwright presses, held modifiers included", () => {
    const source = `
      await page.keyboard.press("ControlOrMeta+Shift+KeyP");
      await field.press("Enter");
      await page.keyboard.down("Control");
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.up("Control");
      await page.keyboard.press("ControlOrMeta+Digit3");
      for (const keys of ["ControlOrMeta+Alt+ArrowLeft"]) await page.keyboard.press(keys);
    `;
    // A literal also counts on its own, so `Shift+Tab` shows up without the held Control as well.
    expect([...pressedChords(source)].toSorted()).toEqual(
      [
        "mod+shift+p",
        "enter",
        "ctrl+shift+tab",
        "shift+tab",
        "mod+3",
        "mod+alt+arrowleft",
      ].toSorted(),
    );
    expect(catalogChord("mod+shift+p")).toBe("mod+shift+p");
    expect(catalogChord("?")).toBe("?");
    expect(catalogChord("mod+\\")).toBe("mod+\\");
  });
});
