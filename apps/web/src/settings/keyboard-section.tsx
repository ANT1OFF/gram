import { Popover } from "@base-ui/react/popover";
import { AlertTriangle, Copy, FileJson, Info, RotateCcw, Search, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { useOpenInEditor, useOpensLocally } from "@/editor/use-open-in-editor";
import { applyOverrideChanges, bindingRows, unknownOverrides } from "@/keyboard/bindings";
import { useBindingsStore } from "@/keyboard/bindings-store";
import { listedShortcuts, SHORTCUT_CATALOG } from "@/keyboard/catalog";
import { formatKeys, isMac, type ShortcutGroup } from "@/keyboard/registry";
import { useSaveBindings } from "@/keyboard/use-save-bindings";
import { useServerSettings } from "@/settings-sync/store";

import { copyText } from "./copy-text";
import { KeyCaptureDialog } from "./key-capture-dialog";
import {
  bindingCounts,
  filterBindings,
  NO_BINDING_FILTER,
  type BindingFilter,
} from "./keyboard-filter";
import { SearchScope, useSettingSearch } from "./search-scope";

const GROUPS: ShortcutGroup[] = ["App", "Navigation", "Thread", "Composer", "Terminal"];

/** Settings → Keyboard: effective bindings, custom ones and clashes marked, record new keys or reset. */
export function KeyboardSection() {
  const openInEditor = useOpenInEditor();
  const local = useOpensLocally();
  const path = useBindingsStore((s) => s.path);
  const overrides = useBindingsStore((s) => s.overrides);
  const problems = useBindingsStore((s) => s.problems);
  const settings = useServerSettings((s) => s.settings);
  const { save, error } = useSaveBindings();
  const [changing, setChanging] = useState<string>();

  const [localFilter, setFilter] = useState<BindingFilter>(NO_BINDING_FILTER);
  const searchingSettings = useSettingsSearchOn();

  const rows = bindingRows(listedShortcuts(SHORTCUT_CATALOG, settings), overrides);
  const unknown = unknownOverrides(SHORTCUT_CATALOG, overrides);
  const changingRow = rows.find((row) => row.id === changing);
  const groups = GROUPS.filter((group) => rows.some((row) => row.group === group));
  const counts = bindingCounts(rows);
  // Settings search filters the rows itself; this page's own filter waits until it's cleared. A
  // chip whose count fell to none (its last clash fixed) no longer narrows anything.
  const filter: BindingFilter = searchingSettings
    ? NO_BINDING_FILTER
    : {
        ...localFilter,
        conflicts: localFilter.conflicts && counts.conflicts > 0,
        custom: localFilter.custom && counts.custom > 0,
      };
  const shown = filterBindings(rows, filter, isMac());

  const reset = (id: string) => {
    const { [id]: _removed, ...rest } = overrides;
    void save(rest);
  };

  return (
    <div data-testid="keyboard-settings" className="flex flex-col gap-4">
      <div
        data-testid="keyboard-intro"
        className="flex flex-wrap items-center gap-2 text-reading text-muted-foreground"
      >
        <span>
          Or edit them all in <code className="font-mono text-meta">keybindings.json</code>.
        </span>
        {path && local && (
          <Hint
            label={`Opens ${path}`}
            render={
              <Button
                size="sm"
                variant="outline"
                data-testid="keyboard-edit-file"
                onClick={() => void openInEditor(path)}
              />
            }
          >
            <FileJson data-icon="inline-start" />
            Edit keybindings.json
          </Hint>
        )}
        {path && <BindingsFileHelp path={path} />}
        {Object.keys(overrides).length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => void save({})}>
            <RotateCcw data-icon="inline-start" />
            Reset all
          </Button>
        )}
      </div>

      {!searchingSettings && (
        <BindingFilterBar
          filter={localFilter}
          onChange={setFilter}
          groups={groups}
          counts={counts}
        />
      )}

      {(problems.length > 0 || unknown.length > 0 || error) && (
        <ul role="alert" className="flex flex-col gap-1 text-meta text-destructive">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
          {unknown.map((id) => (
            <li key={id}>“{id}” isn't a shortcut id, so it's ignored.</li>
          ))}
          {error && <li>{error}</li>}
        </ul>
      )}

      {groups.map((group) => {
        const groupRows = shown.filter((row) => row.group === group);
        if (groupRows.length === 0) return null;
        return (
          <SearchScope key={group} as="section" label={group} aria-label={group}>
            <h3 className="mb-1.5 text-meta font-medium tracking-wide text-muted-foreground uppercase">
              {group}
            </h3>
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {groupRows.map((row) => (
                <BindingItem key={row.id} id={row.id} label={row.label}>
                  <span className="min-w-0 flex-1 truncate">{row.label}</span>
                  {row.conflicts.length > 0 && (
                    <span className="flex items-center gap-1 text-meta text-warning">
                      <AlertTriangle aria-hidden className="size-3.5" />
                      Same keys as {row.conflicts.join(", ")}
                    </span>
                  )}
                  {row.overridden && (
                    <span className="rounded-sm border border-border px-1.5 text-meta text-muted-foreground">
                      custom
                    </span>
                  )}
                  <kbd className="inline-flex h-6 min-w-7 shrink-0 items-center justify-center rounded-2xs border border-border bg-muted px-2 font-mono text-body">
                    {row.keys === undefined ? "Off" : formatKeys(row.keys)}
                  </kbd>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Change ${row.label}`}
                    onClick={() => setChanging(row.id)}
                  >
                    Change
                  </Button>
                  {row.overridden && (
                    <Button
                      size="sm"
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
        );
      })}

      {shown.length === 0 && (
        <p
          role="status"
          data-testid="keyboard-filter-empty"
          className="text-reading text-muted-foreground"
        >
          {filter.query.trim() === ""
            ? "No shortcuts match these filters."
            : `No shortcuts match “${filter.query.trim()}”.`}
        </p>
      )}

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
      className="flex min-h-11 flex-wrap items-center gap-3 px-3 py-1.5 text-reading"
    >
      {children}
    </li>
  );
}

/**
 * Whether Settings search is narrowing this page: what it would do to a setting with no words of
 * its own says so. A search that names the page shows all of it, and so does this filter.
 */
function useSettingsSearchOn(): boolean {
  const probe = useSettingSearch({ label: "" });
  return "hidden" in probe || "data-setting-match" in probe;
}

/** A filter chip: a toggle with the one selected style. */
const CHIP =
  "inline-flex h-7 items-center gap-1 rounded-md border border-border px-3 text-body text-muted-foreground outline-none hover:text-foreground focus-visible:focus-ring aria-pressed:choice-selected";

/**
 * "Search shortcuts" and the chips under it: one group or all, and only the clashing or custom
 * bindings. Esc in the field clears it before it can reach the page (Leave settings).
 */
function BindingFilterBar({
  filter,
  onChange,
  groups,
  counts,
}: {
  filter: BindingFilter;
  onChange: (filter: BindingFilter) => void;
  groups: readonly ShortcutGroup[];
  counts: { conflicts: number; custom: number };
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const set = (change: Partial<BindingFilter>) => onChange({ ...filter, ...change });
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute inset-y-0 start-2 my-auto size-3.5 text-muted-foreground"
        />
        <input
          ref={inputRef}
          type="search"
          data-testid="keyboard-search"
          aria-label="Search shortcuts"
          placeholder="Search shortcuts by name or keys"
          spellCheck={false}
          autoComplete="off"
          value={filter.query}
          onChange={(event) => set({ query: event.target.value })}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            // Cleared first; from empty it steps out, and the next Esc leaves Settings.
            if (filter.query === "") event.currentTarget.blur();
            else set({ query: "" });
          }}
          className="h-7 w-full rounded-md border border-input bg-transparent ps-7 pe-6 text-reading outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-search-cancel-button]:hidden"
        />
        {filter.query !== "" && (
          <button
            type="button"
            aria-label="Clear shortcut search"
            onClick={() => {
              set({ query: "" });
              inputRef.current?.focus();
            }}
            className="absolute inset-y-0 end-1 my-auto flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        )}
      </div>
      <div
        role="group"
        aria-label="Show shortcuts"
        data-testid="keyboard-filters"
        className="flex flex-wrap items-center gap-1"
      >
        <button
          type="button"
          aria-pressed={filter.scope === "all"}
          data-testid="keyboard-scope-all"
          className={CHIP}
          onClick={() => set({ scope: "all" })}
        >
          All
        </button>
        {groups.map((group) => (
          <button
            key={group}
            type="button"
            aria-pressed={filter.scope === group}
            data-testid={`keyboard-scope-${group.toLowerCase()}`}
            className={CHIP}
            onClick={() => set({ scope: filter.scope === group ? "all" : group })}
          >
            {group}
          </button>
        ))}
        {counts.conflicts > 0 && (
          <button
            type="button"
            aria-pressed={filter.conflicts}
            aria-label={`Conflicts, ${counts.conflicts}`}
            data-testid="keyboard-filter-conflicts"
            className={CHIP}
            onClick={() => set({ conflicts: !filter.conflicts })}
          >
            <AlertTriangle aria-hidden className="size-3.5 text-warning" />
            Conflicts
            <span className="tabular-nums">{counts.conflicts}</span>
          </button>
        )}
        {counts.custom > 0 && (
          <button
            type="button"
            aria-pressed={filter.custom}
            aria-label={`Custom, ${counts.custom}`}
            data-testid="keyboard-filter-custom"
            className={CHIP}
            onClick={() => set({ custom: !filter.custom })}
          >
            Custom
            <span className="tabular-nums">{counts.custom}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/** Where `keybindings.json` lives, behind a small ⓘ: the path to select or copy, and when it applies. */
function BindingsFileHelp({ path }: { path: string }) {
  const [copied, setCopied] = useState<string>();
  return (
    <Popover.Root onOpenChange={(open) => open || setCopied(undefined)}>
      <Hint
        label="Where keybindings.json lives"
        render={
          <Popover.Trigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Where keybindings.json lives"
                data-testid="keyboard-file-help"
              />
            }
          />
        }
      >
        <Info aria-hidden />
      </Hint>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="isolate z-50">
          <Popover.Popup
            data-testid="keyboard-file-help-popup"
            className="flex w-96 max-w-[calc(100vw-2rem)] origin-(--transform-origin) flex-col gap-2 rounded-md border border-edge bg-popover p-3 text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            <Popover.Title className="text-body-strong">keybindings.json</Popover.Title>
            <Popover.Description className="text-meta text-muted-foreground">
              Custom bindings live in this file; changes apply as soon as it's saved.
            </Popover.Description>
            <code
              data-testid="keyboard-path"
              className="rounded-xs bg-muted px-2 py-1 font-mono text-meta break-all select-text"
            >
              {path}
            </code>
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  void copyText(path).then(
                    () => setCopied("Path copied."),
                    () => setCopied("Couldn't copy; select the path instead."),
                  )
                }
              >
                <Copy data-icon="inline-start" />
                Copy path
              </Button>
              <span role="status" className="text-meta text-muted-foreground">
                {copied}
              </span>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
