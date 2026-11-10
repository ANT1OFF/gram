import type { WorkspaceId } from "@gram/contracts";

import { DocsStrip } from "@/docs/docs-strip";

// The Docs section of the panel's Workers tab: the local docs its threads publish (`publish_doc`),
// under the worker groups and in their shape, a folding heading with its count and one line a doc.

/**
 * The workspace's latest docs under the Workers tab's groups, with "N more" into the Docs tab;
 * nothing while the workspace has none. Its fold is the tab's to keep.
 */
export function WorkersDocs({
  workspaceId,
  folded,
  onToggle,
}: {
  workspaceId: WorkspaceId;
  folded?: boolean;
  onToggle?: () => void;
}) {
  return (
    <DocsStrip
      workspaceId={workspaceId}
      {...(folded === undefined || onToggle === undefined ? {} : { fold: { folded, onToggle } })}
    />
  );
}
