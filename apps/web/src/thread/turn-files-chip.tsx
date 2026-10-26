import type { ThreadId, TurnId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { FileDiff } from "lucide-react";

import { useApi } from "@/api/context";
import { turnTarget } from "@/panels/turn-diff";
import { useLayoutStore } from "@/stores/layout";

/** "N files changed" under a finished turn; opens the Diff panel at that turn. */
export function TurnFilesChip({ threadId, turnId }: { threadId: ThreadId; turnId: TurnId }) {
  const api = useApi();
  // A finished turn's checkpoints never change, so its diff is fetched once.
  const { data } = useQuery({
    queryKey: ["git.diff.turn", threadId, turnId],
    queryFn: () => api.gitDiff(threadId, { kind: "turn", turnId }),
    staleTime: Infinity,
    retry: false,
  });
  const count = data?.repo ? (data.files?.length ?? 0) : 0;
  if (count === 0) return null;
  return (
    <button
      type="button"
      data-testid="turn-files-chip"
      onClick={() =>
        useLayoutStore
          .getState()
          .requestPanel({ threadId, panel: "diff", target: turnTarget(turnId) }, threadId)
      }
      className="mt-1 inline-flex items-center gap-1 rounded-(--radius-sm) border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <FileDiff aria-hidden className="size-3" />
      {count} {count === 1 ? "file" : "files"} changed
    </button>
  );
}
