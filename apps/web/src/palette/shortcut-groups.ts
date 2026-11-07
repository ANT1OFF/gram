import type { BindingRow } from "@/keyboard/bindings";
import type { ShortcutGroup } from "@/keyboard/registry";

const GROUP_ORDER: ShortcutGroup[] = ["App", "Navigation", "Thread", "Composer", "Terminal"];

/** Numbered shortcut families the overlay lists on one row. */
const FAMILIES = [
  { prefix: "pane.move-", label: "Move focus between panes" },
  { prefix: "layout.preset", label: "Layout preset 1–6" },
] as const;

interface ShortcutRow {
  id: string;
  label: string;
  /** One chord, or each member's chord for a family. */
  keys: readonly string[];
}

export interface ShortcutSection {
  group: ShortcutGroup;
  rows: ShortcutRow[];
}

/**
 * The catalog as the `?` overlay lists it, with the user's bindings applied: grouped in a fixed
 * order and disabled shortcuts left out. A numbered family (panes 1–6, pane moves, layout presets)
 * shares one row while none of its members is customised, and otherwise lists them one by one.
 */
export function groupShortcuts(bindings: readonly BindingRow[]): ShortcutSection[] {
  const byGroup = new Map<ShortcutGroup, ShortcutRow[]>();
  const add = (group: ShortcutGroup, row: ShortcutRow) =>
    byGroup.set(group, [...(byGroup.get(group) ?? []), row]);
  const folded = new Set<string>();

  for (const binding of bindings) {
    if (binding.keys === undefined || folded.has(binding.id)) continue;
    const family = FAMILIES.find((f) => binding.id.startsWith(f.prefix));
    const members = family ? bindings.filter((b) => b.id.startsWith(family.prefix)) : [];
    if (family && members.every((member) => !member.overridden)) {
      for (const member of members) folded.add(member.id);
      add(binding.group, {
        id: family.prefix,
        label: family.label,
        keys: members.map((member) => member.defaultKeys),
      });
      continue;
    }
    add(binding.group, { id: binding.id, label: binding.label, keys: [binding.keys] });
  }

  return GROUP_ORDER.flatMap((group) => {
    const rows = byGroup.get(group);
    return rows ? [{ group, rows }] : [];
  });
}

/** Words a chord answers to beyond its glyphs: `cmd k`, `option ]`, `ctrl shift tab`. */
const keyWords = (keys: string): string =>
  keys
    .toLowerCase()
    .replace(/\bmod\b/g, "mod cmd command ctrl control")
    .replace(/\balt\b/g, "alt opt option")
    .replace(/\barrow(up|down|left|right)\b/g, "arrow $1")
    .replaceAll("+", " ");

/**
 * The sections whose rows match every word of `query` in their label, their group's name or their
 * keys, as written (`⌘K`, `Ctrl+K`) or in words (`cmd k`). Empty sections drop out.
 */
export function filterShortcuts(
  sections: readonly ShortcutSection[],
  query: string,
  format: (keys: string) => string,
): ShortcutSection[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...sections];
  return sections.flatMap((section) => {
    const rows = section.rows.filter((row) => {
      const text = [row.label, section.group, ...row.keys.map(format), ...row.keys.map(keyWords)]
        .join(" ")
        .toLowerCase();
      return terms.every((term) => text.includes(term));
    });
    return rows.length === 0 ? [] : [{ ...section, rows }];
  });
}
