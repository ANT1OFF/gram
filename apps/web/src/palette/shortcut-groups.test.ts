import { describe, expect, it } from "vitest";

import { bindingRows, type BindingRow } from "@/keyboard/bindings";
import { SHORTCUT_CATALOG } from "@/keyboard/catalog";

import { groupShortcuts } from "./shortcut-groups";

const row = (
  id: string,
  group: BindingRow["group"],
  extra: Partial<BindingRow> = {},
): BindingRow => ({
  id,
  label: id,
  group,
  defaultKeys: "mod+k",
  keys: "mod+k",
  overridden: false,
  conflicts: [],
  ...extra,
});

describe("groupShortcuts", () => {
  it("groups in a fixed order and leaves disabled shortcuts out", () => {
    const sections = groupShortcuts([
      row("terminal.find", "Terminal"),
      row("composer.send", "Composer"),
      row("palette.open", "App"),
      row("secret", "App", { keys: undefined, overridden: true }),
      row("thread.nextNeedsYou", "Navigation"),
    ]);
    expect(sections.map((s) => [s.group, s.rows.map((x) => x.id)])).toEqual([
      ["App", ["palette.open"]],
      ["Navigation", ["thread.nextNeedsYou"]],
      ["Composer", ["composer.send"]],
      ["Terminal", ["terminal.find"]],
    ]);
  });

  it("folds a numbered family onto one row until one of its members is customised", () => {
    const presets = [1, 2, 3].map((n) =>
      row(`layout.preset${n}`, "Navigation", {
        defaultKeys: `ctrl+shift+${n}`,
        keys: `ctrl+shift+${n}`,
      }),
    );
    expect(groupShortcuts(presets)[0]!.rows).toEqual([
      {
        id: "layout.preset",
        label: "Layout preset 1–6",
        keys: ["ctrl+shift+1", "ctrl+shift+2", "ctrl+shift+3"],
      },
    ]);

    const customised = [
      presets[0]!,
      { ...presets[1]!, keys: undefined, overridden: true },
      presets[2]!,
    ];
    expect(groupShortcuts(customised)[0]!.rows.map((x) => [x.id, x.keys])).toEqual([
      ["layout.preset1", ["ctrl+shift+1"]],
      ["layout.preset3", ["ctrl+shift+3"]],
    ]);
  });

  it("lists every catalog group, whatever is mounted", () => {
    const sections = groupShortcuts(bindingRows(SHORTCUT_CATALOG, {}));
    expect(sections.map((s) => s.group)).toEqual([
      "App",
      "Navigation",
      "Thread",
      "Composer",
      "Terminal",
    ]);
    const ids = sections.flatMap((s) => s.rows.map((x) => x.id));
    expect(ids).toContain("terminal.find");
    expect(ids).toContain("approval.deny");
  });
});
