import { createFileRoute } from "@tanstack/react-router";

import { GatewaysSettings } from "@/settings/gateways-section";

export const Route = createFileRoute("/settings/gateways")({
  component: GatewaysSettings,
});
