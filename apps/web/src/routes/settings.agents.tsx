import { createFileRoute } from "@tanstack/react-router";

import { AgentsPage } from "@/settings/pages";

export const Route = createFileRoute("/settings/agents")({
  component: AgentsPage,
});
