import type { WorkspaceId } from "@gram/contracts";

// The slot at the top of the panel's Workers tab for the workspace's artifacts strip. It draws
// nothing yet: the strip (cp-artifacts) fills it, and the tab's groups sit under it either way.

/** The workspace's artifacts strip, above the Workers tab's groups; nothing until it has one. */
export function WorkersArtifacts({ workspaceId: _workspaceId }: { workspaceId: WorkspaceId }) {
  return null;
}
