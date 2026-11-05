import type { BindingRow } from "@/keyboard/bindings";
import { formatKeys, isLoneModifier, parseKeys, type ShortcutGroup } from "@/keyboard/registry";

/** What Settings → Keyboard's own search and chips narrow the bindings to. */
export interface BindingFilter {
  /** Words or keys typed in "Search shortcuts". */
  readonly query: string;
  /** One group, or every group. */
  readonly scope: ShortcutGroup | "all";
  /** Only bindings that share their keys with another. */
  readonly conflicts: boolean;
  /** Only bindings `keybindings.json` changes. */
  readonly custom: boolean;
}

export const NO_BINDING_FILTER: BindingFilter = {
  query: "",
  scope: "all",
  conflicts: false,
  custom: false,
};

/** How many bindings clash and how many are custom, for the chips' counts. */
export function bindingCounts(rows: readonly BindingRow[]): { conflicts: number; custom: number } {
  return {
    conflicts: rows.filter((row) => row.conflicts.length > 0).length,
    custom: rows.filter((row) => row.overridden).length,
  };
}

interface QueryChord {
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly key: string | undefined;
}

const MODIFIER_WORDS: Readonly<Record<string, "mod" | "ctrl" | "alt" | "shift">> = {
  mod: "mod",
  cmd: "mod",
  command: "mod",
  meta: "mod",
  super: "mod",
  win: "mod",
  "⌘": "mod",
  ctrl: "ctrl",
  control: "ctrl",
  "⌃": "ctrl",
  alt: "alt",
  opt: "alt",
  option: "alt",
  "⌥": "alt",
  shift: "shift",
  "⇧": "shift",
};

/** Keys a binding names with a word, which `formatKeys` shows as a glyph or a word. */
const NAMED_KEYS = [
  "escape",
  "enter",
  "space",
  "tab",
  "backspace",
  "delete",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "home",
  "end",
  "pageup",
  "pagedown",
] as const;

const KEY_WORDS: Readonly<Record<string, string>> = Object.fromEntries([
  ...NAMED_KEYS.flatMap((key) => [
    [key, key],
    [formatKeys(key, true).toLowerCase(), key],
    [formatKeys(key, false).toLowerCase(), key],
  ]),
  ["esc", "escape"],
  ["return", "enter"],
  ["↵", "enter"],
  ["up", "arrowup"],
  ["down", "arrowdown"],
  ["left", "arrowleft"],
  ["right", "arrowright"],
]);

/**
 * The query read as keys, such as `⌘K`, `cmd k`, `mod+k`, `Ctrl+Shift+P` or `k`; `undefined` when
 * it has a word that is neither a modifier nor a key. Off macOS, Ctrl and ⌘ are one key there, as
 * `formatKeys` shows them.
 */
export function parseQueryChord(query: string, mac: boolean): QueryChord | undefined {
  const tokens = query
    .toLowerCase()
    .replace(/[⌘⌃⌥⇧]/g, (glyph) => ` ${glyph} `)
    .split(/[\s+]+/)
    .filter(Boolean);
  if (tokens.length === 0) return undefined;
  const chord = { mod: false, ctrl: false, alt: false, shift: false };
  let key: string | undefined;
  for (const token of tokens) {
    const modifier = MODIFIER_WORDS[token];
    if (modifier !== undefined) {
      chord[!mac && modifier === "ctrl" ? "mod" : modifier] = true;
      continue;
    }
    const named = KEY_WORDS[token] ?? (/^f\d{1,2}$/.test(token) ? token : undefined);
    const next = named ?? (token.length === 1 ? token : undefined);
    if (next === undefined || key !== undefined) return undefined;
    key = next;
  }
  return { ...chord, key };
}

/**
 * Whether a binding's keys answer a chord typed in search: every modifier typed is held, and the
 * key, if one was typed, is the binding's key. So `k` finds ⌘K and `⌘` every ⌘ binding.
 */
function chordMatches(keys: string, query: QueryChord, mac: boolean): boolean {
  if (isLoneModifier(keys)) return false;
  const chord = parseKeys(keys);
  const mod = mac ? chord.mod : chord.mod || chord.ctrl;
  const ctrl = mac && chord.ctrl;
  if (query.mod && !mod) return false;
  if (query.ctrl && !ctrl) return false;
  if (query.alt && !chord.alt) return false;
  if (query.shift && !chord.shift) return false;
  return query.key === undefined || query.key === chord.key;
}

/** The words a binding is found by: its name, its group and its keys as shown, both ways. */
function rowText(row: BindingRow, mac: boolean): string {
  const keys = row.keys === undefined ? "off" : `${formatKeys(row.keys, mac)} ${row.keys}`;
  return `${row.label}\n${row.group}\n${keys}`.toLowerCase();
}

/**
 * Whether `row` answers the search: every word in its name, group or keys, in any order and
 * ignoring case; or the whole query read as keys matching its binding.
 */
export function rowMatchesQuery(row: BindingRow, query: string, mac: boolean): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = rowText(row, mac);
  if (words.every((word) => text.includes(word))) return true;
  const chord = parseQueryChord(query, mac);
  return chord !== undefined && row.keys !== undefined && chordMatches(row.keys, chord, mac);
}

/** The bindings the filter keeps, in their order. */
export function filterBindings(
  rows: readonly BindingRow[],
  filter: BindingFilter,
  mac: boolean,
): BindingRow[] {
  return rows.filter(
    (row) =>
      (filter.scope === "all" || row.group === filter.scope) &&
      (!filter.conflicts || row.conflicts.length > 0) &&
      (!filter.custom || row.overridden) &&
      rowMatchesQuery(row, filter.query, mac),
  );
}
