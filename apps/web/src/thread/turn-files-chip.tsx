import type { ThreadId, TurnId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FileDiff } from "lucide-react";

import { useApi } from "@/api/context";
import { Hint } from "@/components/hint";
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
  const files = `${count} ${count === 1 ? "file" : "files"} changed`;
  return (
    <Hint
      label="Open this turn's changes in Diff"
      render={
        <button
          type="button"
          data-testid="turn-files-chip"
          onClick={() =>
            useLayoutStore
              .getState()
              .requestPanel({ threadId, panel: "diff", target: turnTarget(turnId) }, threadId)
          }
          // Sized to its words, so it reads as a button rather than a field across the column.
          className="group/files mt-1 inline-flex w-fit cursor-pointer items-center gap-1 self-start rounded-(--radius-sm) border border-border px-2 py-0.5 text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      }
    >
      <FileDiff aria-hidden className="size-3" />
      {files}
      <ChevronRight
        aria-hidden
        className="size-3 opacity-60 transition-transform duration-(--dur-fast) group-hover/files:translate-x-0.5 group-hover/files:opacity-100"
      />
    </Hint>
  );
}
