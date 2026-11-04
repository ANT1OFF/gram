import {
  normalizeShortcut,
  scriptProblem,
  SCRIPTS_FILE,
  type ProjectId,
  type ProjectScript,
  type ScriptSuggestion,
} from "@gram/contracts";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { SHORTCUT_CATALOG } from "@/keyboard/catalog";
import { formatKeys, keysFromEvent } from "@/keyboard/registry";
import { cn } from "@/lib/utils";
import { inputCls } from "@/settings/fields";

import { useProjectScripts, useSaveProjectScripts } from "./use-project-scripts";

const LABEL = "text-xs font-medium text-muted-foreground";

const canonical = (keys: string) => {
  const normal = normalizeShortcut(keys);
  return "keys" in normal ? normal.keys : keys.toLowerCase();
};

/** The app shortcut `keys` already runs, by its label, or `undefined`. */
const appShortcutOn = (keys: string): string | undefined => {
  const wanted = canonical(keys);
  return SHORTCUT_CATALOG.find((definition) => canonical(definition.keys) === wanted)?.label;
};

/** Why `draft` can't be saved beside `others`, its key clashing with an app shortcut included. */
export const draftProblem = (
  draft: ProjectScript,
  others: readonly ProjectScript[],
): string | undefined => {
  const problem = scriptProblem(draft, others);
  if (problem !== undefined) return problem;
  if (draft.shortcut === undefined) return undefined;
  const taken = appShortcutOn(draft.shortcut);
  return taken === undefined ? undefined : `${formatKeys(draft.shortcut)} already does ${taken}.`;
};

interface Draft {
  name: string;
  command: string;
  cwd: string;
  shortcut: string | undefined;
}

const draftOf = (script?: ProjectScript): Draft => ({
  name: script?.name ?? "",
  command: script?.command ?? "",
  cwd: script?.cwd ?? "",
  shortcut: script?.shortcut,
});

const scriptOf = (draft: Draft): ProjectScript => ({
  name: draft.name.trim(),
  command: draft.command.trim(),
  ...(draft.cwd.trim() === "" ? {} : { cwd: draft.cwd.trim() }),
  ...(draft.shortcut === undefined ? {} : { shortcut: draft.shortcut }),
});

/**
 * A project's scripts to add, edit and remove, with one-click Add for what its `package.json` and
 * Makefile name. Every change saves to `.gram/scripts.json` at once; nothing here runs a script.
 */
export function ProjectScriptsEditor({ projectId }: { projectId: ProjectId }) {
  const { data, isPending, isError } = useProjectScripts(projectId);
  const { save, saving, error, reset } = useSaveProjectScripts(projectId);
  /** The script being edited by its index, or `"new"` for one being added. */
  const [editing, setEditing] = useState<number | "new">();
  const scripts = data?.scripts ?? [];

  const write = async (next: readonly ProjectScript[]) => {
    reset();
    try {
      await save(next);
      return true;
    } catch {
      return false;
    }
  };

  if (isPending) return <p className="text-xs text-muted-foreground">Loading scripts…</p>;
  if (isError || data === undefined)
    return <p className="text-xs text-danger-text">Couldn't read this project's scripts.</p>;

  const add = (suggestion: ScriptSuggestion) =>
    void write([...scripts, { name: suggestion.name, command: suggestion.command }]);

  return (
    <div data-testid="project-scripts-editor" className="flex flex-col gap-3 text-sm">
      {data.problem !== undefined && (
        <p role="alert" className="text-xs text-danger-text">
          {data.problem} Saving here replaces it.
        </p>
      )}
      {scripts.length > 0 && (
        <ul data-testid="project-scripts" className="flex flex-col divide-y divide-border">
          {scripts.map((script, index) =>
            editing === index ? (
              <li key={script.name} className="py-2">
                <ScriptForm
                  initial={script}
                  others={scripts.filter((_, at) => at !== index)}
                  saving={saving}
                  onCancel={() => setEditing(undefined)}
                  onSave={async (next) => {
                    if (await write(scripts.map((each, at) => (at === index ? next : each))))
                      setEditing(undefined);
                  }}
                />
              </li>
            ) : (
              <li
                key={script.name}
                data-testid="project-script"
                className="flex items-center gap-2 py-1.5"
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium">{script.name}</span>
                    {script.shortcut !== undefined && (
                      <kbd className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {formatKeys(script.shortcut)}
                      </kbd>
                    )}
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {script.command}
                    {script.cwd !== undefined && ` · in ${script.cwd}`}
                  </span>
                </div>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Edit ${script.name}`}
                  disabled={saving}
                  onClick={() => setEditing(index)}
                >
                  <Pencil aria-hidden />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove ${script.name}`}
                  disabled={saving}
                  onClick={() => void write(scripts.filter((_, at) => at !== index))}
                >
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ),
          )}
        </ul>
      )}
      {editing === "new" ? (
        <ScriptForm
          others={scripts}
          saving={saving}
          onCancel={() => setEditing(undefined)}
          onSave={async (next) => {
            if (await write([...scripts, next])) setEditing(undefined);
          }}
        />
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="w-fit"
          data-testid="add-project-script"
          disabled={saving}
          onClick={() => setEditing("new")}
        >
          <Plus data-icon="inline-start" />
          Add project script
        </Button>
      )}
      {error !== undefined && (
        <p role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      )}
      {data.suggestions.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className={LABEL}>Found in this project</p>
          <ul data-testid="script-suggestions" className="flex flex-col">
            {data.suggestions.map((suggestion) => (
              <li
                key={`${suggestion.source}:${suggestion.name}`}
                data-testid="script-suggestion"
                className="flex items-center gap-2 py-1"
              >
                <div className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className="truncate">{suggestion.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {suggestion.command}
                  </span>
                </div>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {suggestion.source}
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  aria-label={`Add ${suggestion.name}`}
                  disabled={saving}
                  onClick={() => add(suggestion)}
                >
                  Add
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Saved in <code className="font-mono">{SCRIPTS_FILE}</code> in the project's folder, which
        you can also edit by hand. Only your click or key runs one; agents can't.
      </p>
    </div>
  );
}

/** One script's fields; Save is offered once they would save. */
function ScriptForm({
  initial,
  others,
  saving,
  onSave,
  onCancel,
}: {
  initial?: ProjectScript;
  others: readonly ProjectScript[];
  saving: boolean;
  onSave: (script: ProjectScript) => void | Promise<void>;
  onCancel: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(() => draftOf(initial));
  const [touched, setTouched] = useState(false);
  const script = scriptOf(draft);
  const problem = draftProblem(script, others);
  const set = (patch: Partial<Draft>) => {
    setTouched(true);
    setDraft((current) => ({ ...current, ...patch }));
  };

  return (
    <form
      data-testid="project-script-form"
      className="flex flex-col gap-2 rounded-lg border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (problem === undefined) void onSave(script);
      }}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
        <label className="flex flex-col gap-1" htmlFor={`${id}-name`}>
          <span className={LABEL}>Name</span>
          <input
            id={`${id}-name`}
            className={inputCls}
            value={draft.name}
            placeholder="test"
            autoFocus
            onChange={(event) => set({ name: event.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1" htmlFor={`${id}-command`}>
          <span className={LABEL}>Command</span>
          <input
            id={`${id}-command`}
            className={cn(inputCls, "font-mono")}
            value={draft.command}
            placeholder="bun run test"
            spellCheck={false}
            onChange={(event) => set({ command: event.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1" htmlFor={`${id}-cwd`}>
          <span className={LABEL}>Folder (optional)</span>
          <input
            id={`${id}-cwd`}
            className={cn(inputCls, "font-mono")}
            value={draft.cwd}
            placeholder="apps/web"
            spellCheck={false}
            onChange={(event) => set({ cwd: event.target.value })}
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className={LABEL} id={`${id}-shortcut-label`}>
            Shortcut (optional)
          </span>
          <ShortcutInput
            labelledBy={`${id}-shortcut-label`}
            value={draft.shortcut}
            onChange={(shortcut) => set({ shortcut })}
          />
        </div>
      </div>
      {touched && problem !== undefined && (draft.name !== "" || draft.command !== "") && (
        <p className="text-xs text-danger-text">{problem}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving || problem !== undefined}>
          {initial === undefined ? "Add script" : "Save"}
        </Button>
      </div>
    </form>
  );
}

/** Records the next chord pressed while it has focus; Backspace clears it. */
function ShortcutInput({
  value,
  labelledBy,
  onChange,
}: {
  value: string | undefined;
  labelledBy: string;
  onChange: (keys: string | undefined) => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab" || event.key === "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if ((event.key === "Backspace" || event.key === "Delete") && !event.metaKey && !event.ctrlKey) {
      onChange(undefined);
      return;
    }
    const keys = keysFromEvent(event.nativeEvent);
    if (keys !== undefined) onChange(keys);
  };
  return (
    <div className="flex items-center gap-1">
      <input
        aria-labelledby={labelledBy}
        data-testid="script-shortcut-input"
        className={cn(inputCls, "font-mono")}
        readOnly
        value={value === undefined ? "" : formatKeys(value)}
        placeholder="Press keys"
        onKeyDown={onKeyDown}
      />
      {value !== undefined && (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Clear shortcut"
          onClick={() => onChange(undefined)}
        >
          <X aria-hidden />
        </Button>
      )}
    </div>
  );
}
