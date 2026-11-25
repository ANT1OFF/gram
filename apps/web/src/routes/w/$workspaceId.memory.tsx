import { DreamId, WorkspaceId } from "@gram/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { MemoryView } from "@/orchestration/memory-view";

/** `?dream=<id>` opens that dream's review, which is where a dream thread's Review button lands. */
export interface MemorySearch {
  readonly dream?: DreamId;
}

const isDreamId = Schema.is(DreamId);

export const Route = createFileRoute("/w/$workspaceId/memory")({
  validateSearch: (search: Record<string, unknown>): MemorySearch => {
    const dream = search["dream"];
    return isDreamId(dream) ? { dream } : {};
  },
  component: MemoryPage,
});

function MemoryPage() {
  const { workspaceId } = Route.useParams();
  const { dream } = Route.useSearch();
  return <MemoryView workspaceId={WorkspaceId.make(workspaceId)} reviewing={dream} />;
}
