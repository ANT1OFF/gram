import { describe, expect, it } from "vitest";

import { bindingRows, normaliseKeys, shortcutHint, unknownOverrides } from "./bindings";
import { effectiveKeys } from "./bindings-store";
import type { ShortcutDefinition } from "./catalog";
import { formatKeys } from "./registry";

const catalog: ShortcutDefinition[] = [
  { id: "sidebar.toggle", keys: "mod+b", label: "Sidebar", group: "App" },
  { id: "panel.toggle", keys: "mod+alt+b", label: "Panel", group: "App" },
  { id: "composer.send", keys: "mod+enter", label: "Send", group: "Composer" },
  { id: "draft.create", keys: "mod+enter", label: "Create", group: "Composer" },
];

describe("effective bindings", () => {
  it("prefers an override, and null disables the shortcut", () => {
    expect(effectiveKeys("sidebar.toggle", "mod+b", {})).toBe("mod+b");
    expect(effectiveKeys("sidebar.toggle", "mod+b", { "sidebar.toggle": "mod+shift+b" })).toBe(
      "mod+shift+b",
    );
    expect(effectiveKeys("sidebar.toggle", "mod+b", { "sidebar.toggle": null })).toBeUndefined();
    expect(shortcutHint("sidebar.toggle", { "sidebar.toggle": null })).toBe("");
    expect(shortcutHint("sidebar.toggle", {})).toBe(formatKeys("mod+b"));
    expect(shortcutHint("sidebar.toggle", { "sidebar.toggle": "mod+shift+b" })).toBe(
      formatKeys("mod+shift+b"),
    );
    expect(shortcutHint("not.a.shortcut", {})).toBe("");
  });

  it("normalises modifier order", () => {
    expect(normaliseKeys("shift+mod+K")).toBe(normaliseKeys("mod+shift+k"));
  });
});

describe("bindingRows", () => {
  it("marks overrides and reports clashes that involve one", () => {
    const rows = bindingRows(catalog, { "panel.toggle": "mod+b" });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId["panel.toggle"]).toMatchObject({
      keys: "mod+b",
      overridden: true,
      conflicts: ["Sidebar"],
    });
    expect(byId["sidebar.toggle"]?.conflicts).toEqual(["Panel"]);
    // Scoped defaults sharing keys aren't a conflict.
    expect(byId["composer.send"]?.conflicts).toEqual([]);
  });

  it("names override ids that match no shortcut", () => {
    expect(unknownOverrides(catalog, { "sidebar.toggel": "mod+b", "panel.toggle": null })).toEqual([
      "sidebar.toggel",
    ]);
  });
});
