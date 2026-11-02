import { createFileRoute } from "@tanstack/react-router";

import { VoiceInputSection } from "@/settings/voice-input-section";

export const Route = createFileRoute("/settings/voice-input")({
  component: VoiceInputSection,
});
