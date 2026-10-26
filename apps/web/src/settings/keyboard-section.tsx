import { AlertTriangle, FileJson, RotateCcw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { useOpenInEditor, useOpensLocally } from "@/editor/use-open-in-editor";
import { applyOverrideChanges, bindingRows, unknownOverrides } from "@/keyboard/bindings";
import { useBindingsStore, type BindingOverrides } from "@/keyboard/bindings-store";
import { listedShortcuts, SHORTCUT_CATALOG } from "@/keyboard/catalog";
import { formatKeys, type ShortcutGroup } from "@/keyboard/registry";
import { useServerSettings } from "@/settings-sync/store";

import { KeyCaptureDialog } from "./key-capture-dialog";
import { SearchScope, useSettingSearch } from "./search-scope";

const GROUPS: ShortcutGroup[] = ["App", "Navigation", "Thread", "Composer", "Terminal"];

/** Settings → Keyboard: effective bindings, custom ones and clashes marked, record new keys or reset. */
export function KeyboardSection() {
  const api = useApi();
  const openInEditor = useOpenInEditor();
  const local = useOpensLocally();
  const path = useBindingsStore((s) => s.path);
  const overrides = useBindingsStore((s) => s.overrides);
  const problems = useBindingsStore((s) => s.problems);
  const settings = useServerSettings((s) => s.settings);
  const [error, setError] = useState<string>();
  const [changing, setChanging] = useState<string>();

  const rows = bindingRows(listedShortcuts(SHORTCUT_CATALOG, settings), overrides);
  const unknown = unknownOverrides(SHORTCUT_CATALOG, overrides);
  const changingRow = rows.find((row) => row.id === changing);

  const save = async (next: BindingOverrides) => {
    setError(undefined);
    try {
      useBindingsStore.getState().apply(await api.setKeybindings(next));
    } catch (e) {
      setError(`Couldn't save keybindings.json: ${errorMessage(e)}`);
    }
  };

  const reset = (id: string) => {
    const { [id]: _removed, ...rest } = overrides;
    void save(rest);
  };

  return (
    <div data-testid="keyboard-settings" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>
          Custom bindings live in <code className="font-mono text-xs">keybindings.json</code>
          {path && (
            <>
              {" "}
              (<span className="font-mono text-xs break-all">{path}</span>)
            </>
          )}
          ; changes apply as soon as the file is saved.
        </span>
        {path && local && (
          <Button size="sm" variant="outline" onClick={() => void openInEditor(path)}>
            <FileJson data-icon="inline-start" />
            Edit keybindings.json
          </Button>
        )}
        {Object.keys(overrides).length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => void save({})}>
            <RotateCcw data-icon="inline-start" />
            Reset all
          </Button>
        )}
      </div>

      {(problems.length > 0 || unknown.length > 0 || error) && (
        <ul role="alert" className="flex flex-col gap-1 text-xs text-destructive">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
          {unknown.map((id) => (
            <li key={id}>“{id}” isn't a shortcut id, so it's ignored.</li>
          ))}
          {error && <li>{error}</li>}
        </ul>
      )}

      {GROUPS.map((group) => (
        <SearchScope key={group} as="section" label={group} aria-label={group}>
          <h3 className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {group}
          </h3>
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {rows
              .filter((row) => row.group === group)
              .map((row) => (
                <BindingItem key={row.id} id={row.id} label={row.label}>
                  <span className="min-w-0 flex-1 truncate">{row.label}</span>
                  {row.conflicts.length > 0 && (
                    <span className="flex items-center gap-1 text-xs text-status-needs">
                      <AlertTriangle aria-hidden className="size-3.5" />
                      Same keys as {row.conflicts.join(", ")}
                    </span>
                  )}
                  {row.overridden && (
                    <span className="rounded-sm border border-border px-1 text-[11px] text-muted-foreground">
                      custom
                    </span>
                  )}
                  <kbd className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {row.keys === undefined ? "Off" : formatKeys(row.keys)}
                  </kbd>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`Change ${row.label}`}
                    onClick={() => setChanging(row.id)}
                  >
                    Change
                  </Button>
                  {row.overridden && (
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`Reset ${row.label} to ${formatKeys(row.defaultKeys)}`}
                      onClick={() => reset(row.id)}
                    >
                      Reset
                    </Button>
                  )}
                </BindingItem>
              ))}
          </ul>
        </SearchScope>
      ))}

      {changingRow && (
        <KeyCaptureDialog
          row={changingRow}
          rows={rows}
          onClose={() => setChanging(undefined)}
          onSave={(changes) => {
            setChanging(undefined);
            void save(applyOverrideChanges(SHORTCUT_CATALOG, overrides, changes));
          }}
        />
      )}
    </div>
  );
}

/** One shortcut's row, found in Settings search by the shortcut's name. */
function BindingItem({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const search = useSettingSearch({ label });
  return (
    <li
      {...search}
      data-testid={`binding-${id}`}
      className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-sm"
    >
      {children}
    </li>
  );
}
