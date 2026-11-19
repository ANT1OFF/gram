import { createFileRoute } from "@tanstack/react-router";

import { HostedServersPage } from "@/settings/hosted-servers-page";

export const Route = createFileRoute("/settings/hosted-servers")({
  component: HostedServersPage,
});
