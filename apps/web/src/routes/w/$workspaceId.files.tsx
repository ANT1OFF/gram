import type { WorkspaceId } from "@gram/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { OutputsView } from "@/orchestration/outputs-view";

export const Route = createFileRoute("/w/$workspaceId/files")({
  component: FilesPage,
});

function FilesPage() {
  const { workspaceId } = Route.useParams();
  return <OutputsView workspaceId={workspaceId as WorkspaceId} />;
}
