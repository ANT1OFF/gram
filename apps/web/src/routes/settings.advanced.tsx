import { createFileRoute } from "@tanstack/react-router";

import { AdvancedPage } from "@/settings/pages";

export const Route = createFileRoute("/settings/advanced")({
  component: AdvancedPage,
});
