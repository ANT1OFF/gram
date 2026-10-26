import { createFileRoute } from "@tanstack/react-router";

import { WorkspacesSettings } from "@/settings/workspace-settings";

export const Route = createFileRoute("/settings/workspaces")({
  component: WorkspacesSettings,
});
