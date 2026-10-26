import { describe, expect, it } from "vitest";

import { applyOverrideChanges } from "./bindings";
import type { ShortcutDefinition } from "./catalog";

const catalog: ShortcutDefinition[] = [
  { id: "sidebar.toggle", keys: "mod+b", label: "Sidebar", group: "App" },
  { id: "panel.toggle", keys: "mod+alt+b", label: "Panel", group: "App" },
  { id: "focus.toggle", keys: "mod+shift+.", label: "Focus", group: "App" },
];

describe("applyOverrideChanges", () => {
  it("sets new keys, turns shortcuts off and drops overrides set back to their defaults", () => {
    expect(
      applyOverrideChanges(
        catalog,
        { "sidebar.toggle": "mod+shift+b", "focus.toggle": "mod+j" },
        { "sidebar.toggle": "mod+B", "panel.toggle": null, "focus.toggle": "mod+k" },
      ),
    ).toEqual({ "panel.toggle": null, "focus.toggle": "mod+k" });
  });
});
