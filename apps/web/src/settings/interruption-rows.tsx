import { notifyAboutOf, type SettingsPatch } from "@gram/contracts";
import { useState } from "react";

import { errorMessage } from "@/api/errors";
import { useServerSettings } from "@/settings-sync/store";

import { NOTIFICATIONS_DEFAULTS, resetFor } from "./defaults";
import { OptionGroup, SettingRow, Toggle } from "./fields";
import { SettingsGroup } from "./settings-group";
import { useSaveSettings } from "./use-save-settings";

const NOTIFY_ABOUT = [
  { value: "asksAndFailures", label: "Asks and failures" },
  { value: "asks", label: "Asks only" },
] as const;

type InterruptionKey = "quietWhenIdle" | "notifyAbout";

/**
 * Settings → Notifications → Interruptions: how much Gram asks for your attention while you work
 * elsewhere. These lived under General until it moved here, where people look for them.
 */
export function InterruptionRows() {
  const settings = useServerSettings((s) => s.settings);
  const save = useSaveSettings();
  const [failed, setFailed] = useState<{ key: InterruptionKey; message: string }>();
  if (!settings) return null;

  const applyTo = (key: InterruptionKey) => (patch: SettingsPatch) => {
    setFailed(undefined);
    save(patch).catch((e: unknown) => setFailed({ key, message: errorMessage(e) }));
  };
  const errorOf = (key: InterruptionKey) => (failed?.key === key ? failed.message : undefined);
  const resetOf = (key: InterruptionKey) =>
    resetFor(settings, applyTo(key))(NOTIFICATIONS_DEFAULTS[key]);

  return (
    <SettingsGroup
      label="Interruptions"
      description="How much Gram asks for your attention while you work elsewhere."
      keywords={["attention", "focus", "do not disturb"]}
    >
      <SettingRow
        label="Notify me about"
        description="What raises a desktop notification while Gram is in the background."
        learnMore={<p>Asks always notify; the rest waits for Since you left.</p>}
        keywords={["notifications", "interrupt", "failures", "errors", "asks"]}
        onReset={resetOf("notifyAbout")}
        error={errorOf("notifyAbout")}
      >
        <OptionGroup
          label="Notify me about"
          options={NOTIFY_ABOUT}
          value={notifyAboutOf(settings)}
          onChange={(notifyAbout) =>
            applyTo("notifyAbout")({
              notifications: {
                notifyAbout: notifyAbout === "asksAndFailures" ? null : notifyAbout,
              },
            })
          }
        />
      </SettingRow>
      <Toggle
        label="Quiet when idle"
        description="After five idle minutes, switch to Quiet: only what needs you."
        keywords={["quiet", "idle", "away", "calm"]}
        checked={settings.layout?.quietWhenIdle === true}
        onReset={resetOf("quietWhenIdle")}
        error={errorOf("quietWhenIdle")}
        onChange={(quietWhenIdle) =>
          applyTo("quietWhenIdle")({ layout: { quietWhenIdle: quietWhenIdle ? true : null } })
        }
      />
    </SettingsGroup>
  );
}
