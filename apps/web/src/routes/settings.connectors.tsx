import { createFileRoute } from "@tanstack/react-router";

import { ConnectorsSettings } from "@/settings/connectors-section";

export const Route = createFileRoute("/settings/connectors")({
  component: ConnectorsSettings,
});
