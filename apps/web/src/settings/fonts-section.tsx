import type { SettingsPatch } from "@gram/contracts";
import { useState } from "react";

import { errorMessage } from "@/api/errors";
import { useServerSettings } from "@/settings-sync/store";

import { FONTS_DEFAULTS, resetFor } from "./defaults";
import { rowInputCls, SettingRow } from "./fields";
import { useInstalledFonts } from "./installed-fonts";
import { useSaveSettings } from "./use-save-settings";

const MONO_SIZE = { min: 8, max: 32 } as const;

type FontsKey = keyof typeof FONTS_DEFAULTS;

/**
 * Settings → Appearance → Fonts, as rows of its group's card: interface and code families over
 * Glass's own (Inter and JetBrains Mono), and the terminal size.
 */
export function FontsSection() {
  const settings = useServerSettings((s) => s.settings);
  const save = useSaveSettings();
  const suggestions = useInstalledFonts();
  const [failed, setFailed] = useState<{ key: FontsKey; message: string }>();

  if (!settings) return null;
  const fonts = settings.fonts;

  const applyTo = (key: FontsKey) => (patch: SettingsPatch) => {
    setFailed(undefined);
    save(patch).catch((e: unknown) => setFailed({ key, message: errorMessage(e) }));
  };
  const apply = (key: FontsKey, patch: NonNullable<SettingsPatch["fonts"]>) =>
    applyTo(key)({ fonts: patch });
  const errorOf = (key: FontsKey) => (failed?.key === key ? failed.message : undefined);
  const resetOf = (key: FontsKey) => resetFor(settings, applyTo(key))(FONTS_DEFAULTS[key]);
  const source = suggestions.installed
    ? "Suggestions are the fonts installed on this computer."
    : "Suggestions are common fonts; any installed font works.";

  return (
    <>
      <TextSetting
        key={`ui:${fonts.ui ?? ""}`}
        id="settings-font-ui"
        label="Interface font"
        description={`Leave empty to use Inter. ${source}`}
        value={fonts.ui}
        placeholder="Inter"
        suggestions={suggestions.ui}
        onReset={resetOf("ui")}
        error={errorOf("ui")}
        onSave={(ui) => apply("ui", { ui: ui === "" ? null : ui })}
      />
      <TextSetting
        key={`mono:${fonts.mono ?? ""}`}
        id="settings-font-mono"
        label="Code font"
        description="Used for code, paths and the terminal. Leave empty to use JetBrains Mono."
        value={fonts.mono}
        placeholder="JetBrains Mono"
        suggestions={suggestions.mono}
        onReset={resetOf("mono")}
        error={errorOf("mono")}
        onSave={(mono) => apply("mono", { mono: mono === "" ? null : mono })}
      />
      <TextSetting
        key={`size:${fonts.monoSize ?? ""}`}
        id="settings-font-mono-size"
        label="Terminal font size"
        description={`In pixels, ${MONO_SIZE.min}–${MONO_SIZE.max}. Leave empty for the default.`}
        value={fonts.monoSize === undefined ? undefined : String(fonts.monoSize)}
        placeholder="12"
        inputMode="numeric"
        onReset={resetOf("monoSize")}
        error={errorOf("monoSize")}
        onSave={(size) => {
          if (size === "") return apply("monoSize", { monoSize: null });
          const parsed = Number.parseInt(size, 10);
          if (!Number.isInteger(parsed) || parsed < MONO_SIZE.min || parsed > MONO_SIZE.max) {
            setFailed({
              key: "monoSize",
              message: `Terminal font size must be a whole number from ${MONO_SIZE.min} to ${MONO_SIZE.max}.`,
            });
            return;
          }
          apply("monoSize", { monoSize: parsed });
        }}
      />
    </>
  );
}

function TextSetting({
  id,
  label,
  description,
  value,
  placeholder,
  inputMode,
  suggestions,
  onSave,
  onReset,
  error,
}: {
  id: string;
  label: string;
  description: string;
  value: string | undefined;
  placeholder: string;
  inputMode?: "numeric";
  /** Offered as the input's datalist. */
  suggestions?: readonly string[];
  onSave: (value: string) => void;
  onReset: (() => void) | undefined;
  error: string | undefined;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const commit = () => {
    const next = draft.trim();
    if (next !== (value ?? "")) onSave(next);
  };
  const listId = `${id}-suggestions`;
  return (
    <SettingRow
      label={label}
      description={description}
      htmlFor={id}
      onReset={onReset}
      error={error}
    >
      <input
        id={id}
        className={rowInputCls}
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        {...(inputMode === undefined ? {} : { inputMode })}
        {...(suggestions === undefined ? {} : { list: listId })}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
      {suggestions !== undefined && (
        <datalist id={listId} data-testid={listId}>
          {suggestions.map((family) => (
            <option key={family} value={family} />
          ))}
        </datalist>
      )}
    </SettingRow>
  );
}
