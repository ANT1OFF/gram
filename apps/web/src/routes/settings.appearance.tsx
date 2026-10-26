import { createFileRoute } from "@tanstack/react-router";

import { AppearanceSettings } from "@/settings/appearance-section";

export const Route = createFileRoute("/settings/appearance")({
  component: AppearanceSettings,
});
