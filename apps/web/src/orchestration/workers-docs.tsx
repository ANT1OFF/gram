import type { WorkspaceId } from "@gram/contracts";

import { DocsStrip } from "@/docs/docs-strip";

// The slot at the top of the panel's Workers tab for the workspace's Docs strip: the local docs its
// threads publish (`publish_doc`). The tab's groups sit under it either way.

/**
 * The workspace's latest docs above the Workers tab's groups, with View all into the Docs tab;
 * nothing while the workspace has none.
 */
export function WorkersDocs({ workspaceId }: { workspaceId: WorkspaceId }) {
  return <DocsStrip workspaceId={workspaceId} />;
}
