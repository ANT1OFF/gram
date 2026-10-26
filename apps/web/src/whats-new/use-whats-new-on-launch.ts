import { useEffect, useRef } from "react";

import { useDiagnostics } from "@/settings/use-diagnostics";
import { useSaveSettings } from "@/settings/use-save-settings";
import { useServerSettings } from "@/settings-sync/store";

import { WHATS_NEW, whatsNewAudience } from "./index";
import { whatsNewOnLaunch } from "./launch";
import { useWhatsNewDialog } from "./whats-new-dialog";

/**
 * Mount once in the root layout. Once settings and the app version have loaded, shows the unseen
 * highlights (if any) and records the running version, so each update's screen appears once.
 */
export function useWhatsNewOnLaunch() {
  const settings = useServerSettings((s) => s.settings);
  const { data: info } = useDiagnostics();
  const save = useSaveSettings();
  const decided = useRef(false);

  useEffect(() => {
    if (decided.current || !settings || !info) return;
    decided.current = true;
    const decision = whatsNewOnLaunch(
      WHATS_NEW,
      settings.onboarding.lastSeenVersion,
      info.version,
      whatsNewAudience(window.gram),
    );
    useWhatsNewDialog.setState({ launch: decision.kind === "show" ? "shown" : "quiet" });
    if (decision.kind === "none") return;
    if (decision.kind === "show") useWhatsNewDialog.getState().show(decision.releases);
    save({ onboarding: { lastSeenVersion: info.version } }).catch((error: unknown) =>
      console.error("what's new: record the version", error),
    );
  }, [settings, info, save]);
}
