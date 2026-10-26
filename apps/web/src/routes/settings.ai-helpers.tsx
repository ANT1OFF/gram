import { createFileRoute } from "@tanstack/react-router";

import { AiHelpersSection } from "@/settings/ai-helpers-section";

export const Route = createFileRoute("/settings/ai-helpers")({
  component: AiHelpersSection,
});
