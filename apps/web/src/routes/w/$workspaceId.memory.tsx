import type { DreamId, WorkspaceId } from "@gram/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { MemoryView } from "@/orchestration/memory-view";

/** `?dream=<id>` opens that dream's review, which is where a dream thread's Review button lands. */
export interface MemorySearch {
  readonly dream?: DreamId;
}

export const Route = createFileRoute("/w/$workspaceId/memory")({
  validateSearch: (search: Record<string, unknown>): MemorySearch =>
    typeof search["dream"] === "string" && search["dream"] !== ""
      ? { dream: search["dream"] as DreamId }
      : {},
  component: MemoryPage,
});

function MemoryPage() {
  const { workspaceId } = Route.useParams();
  const { dream } = Route.useSearch();
  return <MemoryView workspaceId={workspaceId as WorkspaceId} reviewing={dream} />;
}
