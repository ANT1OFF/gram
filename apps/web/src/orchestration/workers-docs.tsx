import type { WorkspaceId } from "@gram/contracts";

// The slot at the top of the panel's Workers tab for the workspace's Docs strip: the local docs its
// threads publish (`publish_doc`). It draws nothing yet: the strip (cp-artifacts) fills it, and the
// tab's groups sit under it either way.

/** The workspace's Docs strip, above the Workers tab's groups; nothing until it has one. */
export function WorkersDocs({ workspaceId: _workspaceId }: { workspaceId: WorkspaceId }) {
  return null;
}
