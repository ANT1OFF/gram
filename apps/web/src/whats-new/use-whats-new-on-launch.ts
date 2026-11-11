import { RECOMMENDED, recommendedChanges, recommendedSetupOn } from "@gram/contracts";
import { useEffect, useRef } from "react";

import { useDiagnostics } from "@/settings/use-diagnostics";
import { useSaveSettings } from "@/settings/use-save-settings";
import { useServerSettings } from "@/settings-sync/store";

import {
  loadWhatsNew,
  RECOMMENDED_MODELS_TITLE,
  recommendedModelsItem,
  whatsNewAudience,
  withHighlight,
} from "./index";
import { whatsNewOnLaunch } from "./launch";
import { useWhatsNewDialog } from "./whats-new-dialog";

/**
 * Mount once in the root layout. Once settings and the app version have loaded, shows the unseen
 * highlights (if any) and records the running version, so each update's screen appears once.
 * While the recommended setup is on, the running version's highlights end with what changed in
 * the recommended models since the table the user saw; once shown, that table is recorded as seen.
 */
export function useWhatsNewOnLaunch() {
  const settings = useServerSettings((s) => s.settings);
  const { data: info } = useDiagnostics();
  const save = useSaveSettings();
  const decided = useRef(false);

  useEffect(() => {
    if (decided.current || !settings || !info) return;
    decided.current = true;
    const lastSeen = settings.onboarding.lastSeenVersion;
    const mode = settings.agents.recommendedSetup;
    const changes = recommendedSetupOn(settings) ? recommendedChanges(mode?.seen) : [];
    loadWhatsNew()
      .then((releases) => {
        const decision = whatsNewOnLaunch(
          withHighlight(releases, info.version, recommendedModelsItem(changes)),
          lastSeen,
          info.version,
          whatsNewAudience(window.gram),
        );
        useWhatsNewDialog.setState({ launch: decision.kind === "show" ? "shown" : "quiet" });
        if (decision.kind === "none") return;
        if (decision.kind === "show") useWhatsNewDialog.getState().show(decision.releases);
        const told =
          decision.kind === "show" &&
          decision.releases.some((release) =>
            release.highlights.some((item) => item.title === RECOMMENDED_MODELS_TITLE),
          );
        return save({
          onboarding: { lastSeenVersion: info.version },
          ...(told
            ? { agents: { recommendedSetup: { enabled: true, seen: RECOMMENDED.version } } }
            : {}),
        }).catch((error: unknown) => console.error("what's new: record the version", error));
      })
      .catch((error: unknown) => {
        useWhatsNewDialog.setState({ launch: "quiet" });
        console.error("what's new: load the highlights", error);
      });
  }, [settings, info, save]);
}
