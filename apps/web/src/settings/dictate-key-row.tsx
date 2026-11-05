import { AlertTriangle } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { applyOverrideChanges, bindingRows } from "@/keyboard/bindings";
import { useBindingsStore } from "@/keyboard/bindings-store";
import { SHORTCUT_CATALOG } from "@/keyboard/catalog";
import { formatKeys, isLoneModifier, isMac } from "@/keyboard/registry";
import { useSaveBindings } from "@/keyboard/use-save-bindings";

import { SettingRow } from "./fields";
import { KeyCaptureDialog, loneModifierCaveat } from "./key-capture-dialog";

const ID = "composer.dictate";

/** What the key does, which depends on whether it is a modifier held alone or a chord. */
export function dictateKeyHelp(keys: string | undefined): string {
  if (keys === undefined) return "Off: dictate with the composer's mic button.";
  return isLoneModifier(keys)
    ? "Hold it anywhere in Gram while you talk, or double-tap it to keep listening."
    : "In a composer, tap it to start and stop, or hold it while you talk.";
}

/**
 * Voice → the push-to-talk key: dictation's binding in `keybindings.json`, the same one Settings →
 * Keyboard changes, recorded with the same dialog.
 */
export function DictateKeyRow({ mac = isMac() }: { mac?: boolean }) {
  const overrides = useBindingsStore((s) => s.overrides);
  const { save, error } = useSaveBindings();
  const [changing, setChanging] = useState(false);
  const rows = bindingRows(SHORTCUT_CATALOG, overrides);
  const row = rows.find((each) => each.id === ID);
  if (row === undefined) return null;
  const caveat = row.keys === undefined ? undefined : loneModifierCaveat(row.keys, mac);
  const warnings = [
    ...(row.conflicts.length > 0 ? [`Same keys as ${row.conflicts.join(", ")}.`] : []),
    ...(caveat === undefined ? [] : [caveat]),
  ];

  return (
    <SettingRow
      label="Push-to-talk key"
      description={dictateKeyHelp(row.keys)}
      keywords={["hotkey", "shortcut", "key", "hold", "push to talk", "keybinding"]}
      onReset={
        row.overridden
          ? () => {
              const { [ID]: _removed, ...rest } = overrides;
              void save(rest);
            }
          : undefined
      }
      error={error}
      detail={
        warnings.length > 0 && (
          <ul data-testid="dictate-key-warnings" className="flex flex-col gap-1">
            {warnings.map((warning) => (
              <li key={warning} className="flex items-start gap-1.5 text-meta text-warning">
                <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                {warning}
              </li>
            ))}
          </ul>
        )
      }
    >
      <kbd
        data-testid="dictate-key"
        className="rounded-2xs border border-border bg-muted px-1.5 py-0.5 font-mono text-meta"
      >
        {row.keys === undefined ? "Off" : formatKeys(row.keys, mac)}
      </kbd>
      <Button size="sm" variant="outline" onClick={() => setChanging(true)}>
        Change…
      </Button>
      {changing && (
        <KeyCaptureDialog
          row={row}
          rows={rows}
          mac={mac}
          onClose={() => setChanging(false)}
          onSave={(changes) => {
            setChanging(false);
            void save(applyOverrideChanges(SHORTCUT_CATALOG, overrides, changes));
          }}
        />
      )}
    </SettingRow>
  );
}
