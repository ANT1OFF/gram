import { createFileRoute } from "@tanstack/react-router";

import { UsageSettingsPage } from "@/usage/usage-settings-page";

export const Route = createFileRoute("/settings/usage")({
  component: UsageSettingsPage,
});
