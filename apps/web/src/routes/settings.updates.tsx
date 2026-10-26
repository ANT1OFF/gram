import { createFileRoute } from "@tanstack/react-router";

import { UpdatesPage } from "@/settings/pages";

export const Route = createFileRoute("/settings/updates")({
  component: UpdatesPage,
});
