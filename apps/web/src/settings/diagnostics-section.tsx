import type { LogLevel, SettingsPatch } from "@gram/contracts";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { ToolChecks } from "@/launch-checks/tool-checks";
import { useServerSettings } from "@/settings-sync/store";

import { copyText } from "./copy-text";
import { DIAGNOSTICS_DEFAULTS, resetFor } from "./defaults";
import { OptionGroup, SettingRow } from "./fields";
import { SettingsGroup } from "./settings-group";
import { useDiagnostics, useFeature } from "./use-diagnostics";
import { useSaveSettings } from "./use-save-settings";
import { VoiceInputSwitch } from "./voice-input-section";

const LOG_LEVELS: readonly { value: LogLevel; label: string }[] = [
  { value: "error", label: "error" },
  { value: "warn", label: "warn" },
  { value: "info", label: "info" },
  { value: "debug", label: "debug" },
  { value: "trace", label: "trace" },
];

/** Settings → Diagnostics: version and paths, log level, the logs folder and "Copy diagnostics". */
export function DiagnosticsSection() {
  const api = useApi();
  const settings = useServerSettings((s) => s.settings);
  const save = useSaveSettings();
  const { data: info } = useDiagnostics();
  const logsFolder = useFeature("openLogsFolder");
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [levelError, setLevelError] = useState<string>();

  const saveLevel = (patch: SettingsPatch) => {
    setLevelError(undefined);
    save(patch).catch((e: unknown) => setLevelError(errorMessage(e)));
  };

  const run = async (action: () => Promise<string | undefined>) => {
    setStatus(undefined);
    setError(undefined);
    try {
      setStatus(await action());
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex flex-col gap-6" data-testid="diagnostics">
      {info && (
        <SettingsGroup label="This install">
          <InfoRow label="Version" value={info.version} />
          <InfoRow label="Platform" value={`${info.platform} ${info.arch}`} />
          <InfoRow label="Data folder" value={info.dataDir} />
          {info.logFile && <InfoRow label="Log file" value={info.logFile} />}
        </SettingsGroup>
      )}
      <ToolChecks />
      <SettingsGroup label="Logs">
        <SettingRow
          label="Log level"
          description="How much goes into the log files. Use debug or trace while troubleshooting."
          disabledReason={settings ? undefined : "Loading settings…"}
          onReset={settings && resetFor(settings, saveLevel)(DIAGNOSTICS_DEFAULTS.logLevel)}
          error={levelError}
        >
          <OptionGroup
            label="Log level"
            options={LOG_LEVELS}
            value={settings?.logLevel}
            disabled={!settings}
            onChange={(logLevel) => saveLevel({ logLevel })}
          />
        </SettingRow>
        <SettingRow
          label="Copy diagnostics"
          description="Versions, paths, settings and recent logs, keys removed. Paths may name projects: review before sharing."
          error={error}
          detail={
            status && (
              <p role="status" className="text-xs text-muted-foreground">
                {status}
              </p>
            )
          }
        >
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void run(async () => {
                const report = await api.diagnosticsReport();
                await copyText(report.text);
                return "Diagnostics copied to the clipboard.";
              })
            }
          >
            Copy diagnostics
          </Button>
          {logsFolder && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void run(async () => {
                  await api.openLogsFolder();
                  return undefined;
                })
              }
            >
              Open logs folder
            </Button>
          )}
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup
        label="Experimental"
        description="Features still being tried out. Each may change or go away."
      >
        <VoiceInputSwitch
          label="Voice input"
          description="Dictate into the composer, recognised on this computer by a 662 MB speech model."
        />
      </SettingsGroup>
    </div>
  );
}

/** A fact about this install: its name, and the value in mono on the right. */
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-8">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-mono text-xs break-all">{value}</span>
    </div>
  );
}
