import type { SettingsPatch } from "@gram/contracts";
import { useState } from "react";

import { errorMessage } from "@/api/errors";
import { useServerSettings } from "@/settings-sync/store";

import { CustomShellField } from "./custom-shell-field";
import { resetFor, TERMINAL_DEFAULTS } from "./defaults";
import { OptionGroup, SettingRow } from "./fields";
import { SettingsGroup } from "./settings-group";
import { useSaveSettings } from "./use-save-settings";

/** `terminal.shell` profiles; the server maps each to its executable. */
const WINDOWS_SHELLS = [
  { value: "powershell", label: "Windows PowerShell" },
  { value: "pwsh", label: "PowerShell 7" },
  { value: "cmd", label: "Command Prompt" },
  { value: "git-bash", label: "Git Bash" },
] as const;

const isShellProfile = (shell: string): shell is (typeof WINDOWS_SHELLS)[number]["value"] =>
  WINDOWS_SHELLS.some((profile) => profile.value === shell);

/** Settings → Terminal: the shell the Terminal tab starts, a profile or a checked custom path. */
export function TerminalSection() {
  const settings = useServerSettings((s) => s.settings);
  const save = useSaveSettings();
  const [error, setError] = useState<string>();

  if (!settings) return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  const shell = settings.terminal.shell ?? "powershell";

  const apply = (patch: SettingsPatch) => {
    setError(undefined);
    save(patch).catch((e: unknown) => setError(errorMessage(e)));
  };

  return (
    <SettingsGroup label="Shell" testId="terminal-settings">
      <SettingRow
        label="Windows terminal shell"
        description="The shell the Terminal tab starts: a profile, or another shell's name or path."
        onReset={resetFor(settings, apply)(TERMINAL_DEFAULTS.shell)}
        error={error}
        detail={
          <CustomShellField
            // No key: saving a custom shell must not remount the field and drop its status line.
            value={isShellProfile(shell) ? undefined : shell}
            onSave={(custom) => apply({ terminal: { shell: custom } })}
          />
        }
      >
        <OptionGroup
          label="Windows terminal shell"
          options={WINDOWS_SHELLS}
          value={isShellProfile(shell) ? shell : undefined}
          onChange={(profile) => apply({ terminal: { shell: profile } })}
        />
      </SettingRow>
    </SettingsGroup>
  );
}
