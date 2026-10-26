import { effectiveKeys, type BindingOverrides } from "./bindings-store";
import { catalogKeys, type ShortcutDefinition } from "./catalog";
import { formatKeys, matches, parseKeys } from "./registry";

/** A shortcut's effective keys for hints and menus, from its catalog default; empty when turned off. */
export function shortcutHint(id: string, overrides?: BindingOverrides): string {
  const keys = effectiveKeys(id, catalogKeys(id) ?? "", overrides);
  return keys ? formatKeys(keys) : "";
}

/**
 * Whether `event` is the chord `id` is bound to right now, for an element that answers a shortcut
 * itself. A text area does for a binding without ⌘/Ctrl, which the registry keeps away from fields:
 * opening every field to it instead would let a Send rebound to a letter fire from a find bar.
 */
export function shortcutPressed(id: string, event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  const keys = effectiveKeys(id, catalogKeys(id) ?? "");
  return keys !== undefined && keys !== "" && matches(keys, event);
}

/** Order-independent, so `shift+mod+K` and `mod+shift+k` compare equal. */
export function normaliseKeys(keys: string): string {
  const chord = parseKeys(keys);
  return [
    chord.mod && "mod",
    chord.ctrl && "ctrl",
    chord.alt && "alt",
    chord.shift && "shift",
    chord.key,
  ]
    .filter(Boolean)
    .join("+");
}

export interface BindingRow {
  id: string;
  label: string;
  group: ShortcutDefinition["group"];
  defaultKeys: string;
  /** `undefined` when disabled. */
  keys: string | undefined;
  overridden: boolean;
  /** Labels of other shortcuts on the same keys, when at least one of the pair is overridden. */
  conflicts: string[];
}

/**
 * The catalog with the overrides applied. Clashes between defaults are deliberate (they're scoped,
 * e.g. Send and Create thread), so only a clash involving an override is reported.
 */
export function bindingRows(
  catalog: readonly ShortcutDefinition[],
  overrides: BindingOverrides,
): BindingRow[] {
  const rows: BindingRow[] = catalog.map((definition) => ({
    id: definition.id,
    label: definition.label,
    group: definition.group,
    defaultKeys: definition.keys,
    keys: effectiveKeys(definition.id, definition.keys, overrides),
    overridden: Object.hasOwn(overrides, definition.id),
    conflicts: [],
  }));
  for (const row of rows) {
    if (row.keys === undefined) continue;
    const keys = normaliseKeys(row.keys);
    row.conflicts = rows
      .filter(
        (other) =>
          other !== row &&
          other.keys !== undefined &&
          (other.overridden || row.overridden) &&
          normaliseKeys(other.keys) === keys,
      )
      .map((other) => other.label);
  }
  return rows;
}

/** Override ids that match no shortcut, e.g. a typo in `keybindings.json`. */
export const unknownOverrides = (
  catalog: readonly ShortcutDefinition[],
  overrides: BindingOverrides,
): string[] => Object.keys(overrides).filter((id) => !catalog.some((d) => d.id === id));

/**
 * `overrides` with `changes` applied (keys, or `null` for off). A shortcut set back to its default
 * keys drops its override, so the file only holds real customisations.
 */
export function applyOverrideChanges(
  catalog: readonly ShortcutDefinition[],
  overrides: BindingOverrides,
  changes: BindingOverrides,
): BindingOverrides {
  const next = new Map(Object.entries(overrides));
  for (const [id, keys] of Object.entries(changes)) {
    const definition = catalog.find((d) => d.id === id);
    if (keys !== null && definition && normaliseKeys(keys) === normaliseKeys(definition.keys)) {
      next.delete(id);
    } else {
      next.set(id, keys);
    }
  }
  return Object.fromEntries(next);
}
