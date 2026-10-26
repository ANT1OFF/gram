import { MENU_SHORTCUT_IDS } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { catalogKeys } from "@/keyboard/catalog";

import { menuShortcuts } from "./menu-shortcuts";

describe("menuShortcuts", () => {
  it("sends each menu shortcut's effective keys, and null for one turned off", () => {
    expect(menuShortcuts({})).toMatchObject({
      "pane.close": "mod+w",
      "palette.open": "mod+k",
      "overlay.shortcutsAnywhere": "mod+/",
    });
    expect(menuShortcuts({ "pane.close": "mod+shift+x", "thread.new": null })).toMatchObject({
      "pane.close": "mod+shift+x",
      "thread.new": null,
      "settings.open": "mod+,",
    });
  });

  it("covers only shortcuts the catalog defines", () => {
    for (const id of MENU_SHORTCUT_IDS) expect(catalogKeys(id), id).toBeDefined();
  });
});
