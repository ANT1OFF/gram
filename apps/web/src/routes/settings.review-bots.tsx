import { createFileRoute } from "@tanstack/react-router";

import { ReviewBotsSection } from "@/settings/review-bots-section";

export const Route = createFileRoute("/settings/review-bots")({
  component: ReviewBotsSection,
});
