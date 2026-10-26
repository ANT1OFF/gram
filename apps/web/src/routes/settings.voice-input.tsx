import { voiceInputOn } from "@gram/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { useServerSettings } from "@/settings-sync/store";
import { VoiceInputSection } from "@/settings/voice-input-section";

/**
 * Experimental until 0.9: with voice input off the page isn't listed, and a link to it opens
 * Diagnostics, whose Experimental group has the switch.
 */
export const Route = createFileRoute("/settings/voice-input")({
  beforeLoad: () => {
    const { settings } = useServerSettings.getState();
    if (settings !== undefined && !voiceInputOn(settings)) {
      throw redirect({ to: "/settings/diagnostics", replace: true });
    }
  },
  component: VoiceInputSection,
});
