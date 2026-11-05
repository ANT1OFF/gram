import { describe, expect, it } from "vitest";

import { bindingRows } from "@/keyboard/bindings";
import type { ShortcutDefinition } from "@/keyboard/catalog";

import {
  bindingCounts,
  filterBindings,
  NO_BINDING_FILTER,
  parseQueryChord,
  rowMatchesQuery,
  type BindingFilter,
} from "./keyboard-filter";

const catalog: ShortcutDefinition[] = [
  { id: "palette.open", keys: "mod+k", label: "Command palette", group: "App" },
  { id: "palette.actions", keys: "mod+shift+p", label: "Actions", group: "App" },
  { id: "overlay.shortcuts", keys: "?", label: "Keyboard shortcuts", group: "App" },
  { id: "settings.close", keys: "escape", label: "Leave settings", group: "App" },
  { id: "sidebar.toggle", keys: "mod+b", label: "Collapse / expand sidebar", group: "App" },
  { id: "panel.toggle", keys: "mod+alt+b", label: "Show / hide right panel", group: "App" },
  { id: "diff.nextHunk", keys: "n", label: "Next change in the diff", group: "Navigation" },
  { id: "composer.send", keys: "mod+enter", label: "Send", group: "Composer" },
  { id: "terminal.clear", keys: "ctrl+k", label: "Clear terminal", group: "Terminal" },
];

const rows = bindingRows(catalog, {});
const ids = (filter: Partial<BindingFilter>, mac = true, from = rows) =>
  filterBindings(from, { ...NO_BINDING_FILTER, ...filter }, mac).map((row) => row.id);

describe("parseQueryChord", () => {
  it("reads glyphs, words and plus-joined keys alike", () => {
    const palette = { mod: true, ctrl: false, alt: false, shift: false, key: "k" };
    expect(parseQueryChord("⌘K", true)).toEqual(palette);
    expect(parseQueryChord("cmd k", true)).toEqual(palette);
    expect(parseQueryChord("mod+k", true)).toEqual(palette);
    expect(parseQueryChord("Command+K", true)).toEqual(palette);
    expect(parseQueryChord("⌘⇧P", true)).toEqual({ ...palette, shift: true, key: "p" });
  });

  it("takes Ctrl as ⌘'s key off macOS, and as its own key on macOS", () => {
    expect(parseQueryChord("Ctrl+K", false)).toMatchObject({ mod: true, ctrl: false, key: "k" });
    expect(parseQueryChord("ctrl k", true)).toMatchObject({ mod: false, ctrl: true, key: "k" });
  });

  it("names keys the way formatKeys shows them", () => {
    expect(parseQueryChord("esc", true)?.key).toBe("escape");
    expect(parseQueryChord("⎋", true)?.key).toBe("escape");
    expect(parseQueryChord("⌘⏎", true)).toMatchObject({ mod: true, key: "enter" });
    expect(parseQueryChord("Ctrl+Enter", false)).toMatchObject({ mod: true, key: "enter" });
  });

  it("isn't a chord with a plain word in it or two keys", () => {
    expect(parseQueryChord("palette", true)).toBeUndefined();
    expect(parseQueryChord("k p", true)).toBeUndefined();
    expect(parseQueryChord("   ", true)).toBeUndefined();
  });
});

describe("filterBindings", () => {
  it("finds the command palette by its keys however they're typed", () => {
    for (const query of ["⌘K", "cmd k", "mod+k", "k", "⌘ k"]) {
      expect(ids({ query }), query).toContain("palette.open");
    }
    expect(ids({ query: "Ctrl+K" }, false)).toContain("palette.open");
    expect(ids({ query: "ctrl k" }, false)).toContain("palette.open");
  });

  it("keeps a chord to the bindings that hold every modifier typed", () => {
    expect(ids({ query: "⌘K" })).toEqual(["palette.open"]);
    // ⌃K on macOS is the terminal's own Control chord, not ⌘K.
    expect(ids({ query: "ctrl k" })).toEqual(["terminal.clear"]);
    expect(ids({ query: "⌘" })).toEqual([
      "palette.open",
      "palette.actions",
      "sidebar.toggle",
      "panel.toggle",
      "composer.send",
    ]);
    expect(ids({ query: "⌘⌥" })).toEqual(["panel.toggle"]);
    expect(ids({ query: "?" })).toEqual(["overlay.shortcuts"]);
    expect(ids({ query: "esc" })).toEqual(["settings.close"]);
  });

  it("matches every word of a name or group, in any order and any case", () => {
    expect(ids({ query: "palette" })).toEqual(["palette.open"]);
    expect(ids({ query: "SIDEBAR collapse" })).toEqual(["sidebar.toggle"]);
    expect(ids({ query: "navigation" })).toEqual(["diff.nextHunk"]);
    expect(ids({ query: "zzz" })).toEqual([]);
  });

  it("narrows to one group", () => {
    expect(ids({ scope: "Composer" })).toEqual(["composer.send"]);
    expect(ids({ scope: "Terminal", query: "k" })).toEqual(["terminal.clear"]);
    expect(ids({ scope: "Thread" })).toEqual([]);
  });

  it("shows only clashes or only custom bindings, and both together", () => {
    const custom = bindingRows(catalog, { "panel.toggle": "mod+b", "diff.nextHunk": "j" });
    expect(bindingCounts(custom)).toEqual({ conflicts: 2, custom: 2 });
    expect(ids({ conflicts: true }, true, custom)).toEqual(["sidebar.toggle", "panel.toggle"]);
    expect(ids({ custom: true }, true, custom)).toEqual(["panel.toggle", "diff.nextHunk"]);
    expect(ids({ custom: true, conflicts: true }, true, custom)).toEqual(["panel.toggle"]);
    expect(ids({ conflicts: true, query: "sidebar" }, true, custom)).toEqual(["sidebar.toggle"]);
    expect(bindingCounts(rows)).toEqual({ conflicts: 0, custom: 0 });
  });

  it("finds a turned-off binding by Off", () => {
    const off = bindingRows(catalog, { "sidebar.toggle": null });
    expect(ids({ query: "off" }, true, off)).toEqual(["sidebar.toggle"]);
    expect(
      rowMatchesQuery(
        off.find((row) => row.id === "sidebar.toggle")!,
        "mod+b",
        true,
      ),
    ).toBeFalsy();
  });

  it("keeps every binding when it narrows nothing", () => {
    expect(ids({})).toEqual(rows.map((row) => row.id));
    expect(ids({ query: "  " })).toEqual(rows.map((row) => row.id));
  });
});
