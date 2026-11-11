import { embeddingOn, type LogLevel, type SettingsPatch } from "@gram/contracts";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { ToolChecks } from "@/launch-checks/tool-checks";
import { useServerSettings } from "@/settings-sync/store";

import { copyText } from "./copy-text";
import { DIAGNOSTICS_DEFAULTS, resetFor } from "./defaults";
import { OptionGroup, SettingRow, Toggle } from "./fields";
import { SettingsGroup } from "./settings-group";
import { useDiagnostics, useFeature } from "./use-diagnostics";
import { useSaveSettings } from "./use-save-settings";

const LOG_LEVELS: readonly { value: LogLevel; label: string }[] = [
  { value: "error", label: "error" },
  { value: "warn", label: "warn" },
  { value: "info", label: "info" },
  { value: "debug", label: "debug" },
  { value: "trace", label: "trace" },
];

/**
 * Settings → About: which version of Gram this is, and on what. Diagnostics has the paths, and
 * "Copy diagnostics" both.
 */
export function InstallInfo() {
  const { data: info } = useDiagnostics();
  if (!info) return null;
  return (
    <SettingsGroup
      label="This version"
      description="Which version of Gram this is, and what it runs on."
      keywords={["about", "build"]}
    >
      <InfoRow label="Version" value={info.version} />
      <InfoRow label="Platform" value={`${info.platform} ${info.arch}`} />
    </SettingsGroup>
  );
}

/** Settings → About → Diagnostics: paths, log level, the logs folder and "Copy diagnostics". */
export function DiagnosticsSection() {
  const api = useApi();
  const settings = useServerSettings((s) => s.settings);
  const save = useSaveSettings();
  const { data: info } = useDiagnostics();
  const logsFolder = useFeature("openLogsFolder");
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [levelError, setLevelError] = useState<string>();
  const [hostedError, setHostedError] = useState<string>();

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
        <SettingsGroup
          label="Data"
          description="Where Gram keeps its data and its log. About has the version."
        >
          <InfoRow label="Data folder" value={info.dataDir} />
          {info.logFile && <InfoRow label="Log file" value={info.logFile} />}
        </SettingsGroup>
      )}
      <ToolChecks />
      <SettingsGroup
        label="Logs"
        description="What Gram writes down while it runs, for troubleshooting."
      >
        <SettingRow
          label="Log level"
          description="How much goes into the log files. Use debug or trace to troubleshoot."
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
              <p role="status" className="text-meta text-muted-foreground">
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
        label="Hosting"
        description="For a Gram that runs as a service for other people, not on your own computer."
      >
        <Toggle
          label="Hosted features"
          description="Run this Gram as a service behind another one. Leave it off on your own computer."
          keywords={["embedding", "hosted", "self-hosted", "headless", "control plane", "server"]}
          checked={settings !== undefined && embeddingOn(settings)}
          disabled={!settings}
          disabledReason="Loading settings…"
          error={hostedError}
          onChange={(embedding) => {
            setHostedError(undefined);
            save({ experimental: { embedding } }).catch((e: unknown) =>
              setHostedError(errorMessage(e)),
            );
          }}
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
      <span className="text-right font-mono text-meta break-all">{value}</span>
    </div>
  );
}
