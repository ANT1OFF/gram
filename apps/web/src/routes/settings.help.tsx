import { createFileRoute } from "@tanstack/react-router";

import { HelpSection } from "@/settings/help-section";

export const Route = createFileRoute("/settings/help")({
  component: HelpSection,
});
