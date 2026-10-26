import type { WorkspaceId } from "@gram/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceSettingsPage } from "@/settings/workspace-page";

/** One workspace's settings, under Settings → Workspaces without nesting in its list. */
export const Route = createFileRoute("/settings/workspaces_/$workspaceId")({
  component: WorkspaceSettingsRoute,
});

function WorkspaceSettingsRoute() {
  const { workspaceId } = Route.useParams();
  return <WorkspaceSettingsPage workspaceId={workspaceId as WorkspaceId} />;
}
