import { useState } from "react";

import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useServerSettings } from "@/settings-sync/store";

import { OPTION_GROUP, rowInputCls, SettingRow } from "./fields";
import { useSaveSettings } from "./use-save-settings";

const PRESETS = [
  { command: "code", label: "VS Code" },
  { command: "cursor", label: "Cursor" },
  { command: "zed", label: "Zed" },
  { command: "idea", label: "IntelliJ IDEA" },
] as const;

/** Settings → General: which editor "Open in editor" launches, as rows of its group's card. */
export function EditorSection() {
  const saveSettings = useSaveSettings();
  const saved = useServerSettings((s) => s.settings?.editor.command);
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const value = draft ?? saved ?? "";

  const save = async (command: string) => {
    setError(undefined);
    try {
      const trimmed = command.trim();
      await saveSettings({ editor: { command: trimmed === "" ? null : trimmed } });
      setDraft(undefined);
    } catch (e) {
      setError(`Couldn't save the editor: ${errorMessage(e)}`);
    }
  };

  const onReset =
    saved === undefined
      ? undefined
      : () => {
          setDraft(undefined);
          void save("");
        };

  return (
    <>
      <SettingRow label="Editor" description="A preset, or your own command below.">
        <div className={OPTION_GROUP}>
          {PRESETS.map((preset) => (
            <Button
              key={preset.command}
              size="sm"
              variant={value.split(/\s+/)[0] === preset.command ? "secondary" : "ghost"}
              onClick={() => void save(preset.command)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
      </SettingRow>
      <SettingRow
        label="Command"
        description="A preset, or a template with {path} and {line}."
        htmlFor="settings-editor-command"
        onReset={onReset}
        error={error}
      >
        <input
          id="settings-editor-command"
          aria-label="Editor command"
          className={cn(rowInputCls, "font-mono")}
          placeholder="code"
          value={value}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft !== undefined && draft !== (saved ?? "")) void save(draft);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save(value);
          }}
        />
      </SettingRow>
    </>
  );
}
