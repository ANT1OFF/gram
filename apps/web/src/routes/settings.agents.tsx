import { createFileRoute } from "@tanstack/react-router";

import { AgentsPage } from "@/settings/agents-page";

export const Route = createFileRoute("/settings/agents")({
  component: AgentsPage,
});
