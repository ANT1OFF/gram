// One of the Settings pages built from several sections, apart from the page list (`pages.tsx`) so
// that the list, which the nav and every Settings route load, does not bring the sections with it.

import { useServerSettings } from "@/settings-sync/store";

import { InstallInfo } from "./diagnostics-section";
import { SettingsGroup } from "./settings-group";
import { UpdatesSection } from "./updates-section";
import { useSaveSettings } from "./use-save-settings";

/** Settings → About → Updates, wired to the persisted channel, opt-ins and version pin. */
export function UpdatesPage() {
  const updates = useServerSettings((s) => s.settings?.updates);
  const channel = updates?.channel;
  const pinnedVersion = useServerSettings((s) => s.settings?.updates.pinnedVersion);
  const saveSettings = useSaveSettings();
  return (
    <UpdatesSection
      channel={channel}
      automaticChecks={updates?.automaticChecks === true}
      onPreferencesChange={(patch) => saveSettings({ updates: patch })}
      pinnedVersion={pinnedVersion}
      onPinChange={(pin) => saveSettings({ updates: { pinnedVersion: pin } })}
    />
  );
}

const UPDATE_KEYWORDS = ["version", "release", "upgrade", "pin", "channel", "download", "restart"];

/** Settings → About: which version this is, and its updates. */
export function AboutPage() {
  return (
    <>
      <InstallInfo />
      <SettingsGroup
        label="Updates"
        card={false}
        description="Check for new releases, download them and restart into them."
        keywords={UPDATE_KEYWORDS}
      >
        <UpdatesPage />
      </SettingsGroup>
    </>
  );
}
