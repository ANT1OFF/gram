import type { WorkspaceId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";

import { useApi } from "@/api/context";

import { dreamWaitsForReview } from "./memory-model";

/** The Memory updates tab's mark: how many updates wait for review, else a dot while one runs. */
export function UpdateTabMark({ workspaceId }: { workspaceId: WorkspaceId }) {
  const api = useApi();
  const dreams = useQuery({
    queryKey: ["dreams", workspaceId, "list"],
    queryFn: () => api.listDreams(workspaceId),
    retry: false,
  });
  const list = dreams.data ?? [];
  const waiting = list.filter(dreamWaitsForReview).length;
  const running = list.some((dream) => dream.status === "running" || dream.status === "pending");
  if (waiting > 0) {
    return (
      <span
        data-testid="memory-tab-update-waiting"
        className="ms-1.5 inline-flex items-center gap-1 font-normal text-status-needs tabular-nums"
      >
        <span aria-hidden className="size-1.5 rounded-full bg-status-needs-mark" />
        {waiting}
        <span className="sr-only"> to review</span>
      </span>
    );
  }
  if (running) {
    return (
      <span
        aria-label="running"
        className="ms-1.5 inline-block size-1.5 rounded-full bg-status-working"
      />
    );
  }
  return null;
}
