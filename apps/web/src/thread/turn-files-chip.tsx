import type { ThreadId, TurnId, TurnUndoData } from "@gram/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FileDiff, Undo2 } from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import { undoTurnErrorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { formatClockTime } from "@/lib/time";
import { turnTarget } from "@/panels/turn-diff";
import { useLayoutStore } from "@/stores/layout";

const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

/**
 * The card under a finished turn that changed files: how many, which opens the Diff panel at that
 * turn, and Undo, which puts those files back as they were before it. Undo asks once, then the
 * server refuses with a reason while the agent works, once a later turn or the user changed one
 * of the files, or once the edits are committed; View changes stays for each. `undo` is the
 * transcript's receipt when this turn's edits were already undone.
 */
export function TurnFilesChip({
  threadId,
  turnId,
  undo,
}: {
  threadId: ThreadId;
  turnId: TurnId;
  undo?: TurnUndoData | undefined;
}) {
  const api = useApi();
  // A finished turn's checkpoints never change, so its diff is fetched once.
  const { data } = useQuery({
    queryKey: ["git.diff.turn", threadId, turnId],
    queryFn: () => api.gitDiff(threadId, { kind: "turn", turnId }),
    staleTime: Infinity,
    retry: false,
  });
  const [confirming, setConfirming] = useState(false);
  const undoing = useMutation({
    mutationFn: () => api.undoTurn(threadId, turnId),
    onSettled: () => setConfirming(false),
  });
  const changed = data?.repo ? (data.files ?? []) : [];
  const count = changed.length;
  if (count === 0) return null;
  const additions = changed.reduce((sum, file) => sum + file.additions, 0);
  const deletions = changed.reduce((sum, file) => sum + file.deletions, 0);
  const undone = undo ?? undoing.data;
  const refused = undoing.isError ? undoTurnErrorMessage(undoing.error) : undefined;
  const viewChanges = () =>
    useLayoutStore
      .getState()
      .requestPanel({ threadId, panel: "diff", target: turnTarget(turnId) }, threadId);

  return (
    <div
      data-testid="turn-files-card"
      data-undone={undone === undefined ? undefined : "true"}
      className="mt-2 flex w-full flex-col self-stretch gap-1 rounded-(--radius-md) border border-border px-3 py-2"
    >
      <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1">
        <Hint
          label="Open this turn's changes in Diff"
          render={
            <button
              type="button"
              data-testid="turn-files-chip"
              onClick={viewChanges}
              className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-(--radius-xs) text-sm font-medium outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          }
        >
          <FileDiff aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          {files(count)} changed
        </Hint>
        <span
          className="font-mono text-xs tabular-nums"
          aria-label={`${additions} lines added, ${deletions} removed`}
        >
          <span className="text-success">+{additions.toLocaleString()}</span>{" "}
          <span className="text-destructive">−{deletions.toLocaleString()}</span>
        </span>
        <span className="ml-auto flex items-center gap-1">
          {undone !== undefined ? (
            <span
              data-testid="turn-undone"
              className="inline-flex items-center gap-1 px-2 text-xs text-muted-foreground"
            >
              <Undo2 aria-hidden className="size-3.5" />
              {undone.failed === undefined ? "Undone" : "Undo failed"} at{" "}
              {formatClockTime(undone.at)}
            </span>
          ) : confirming ? (
            <>
              <span className="px-1 text-xs text-muted-foreground">
                Put back {files(count)} as before this turn?
              </span>
              <Button
                size="sm"
                variant="outline"
                data-testid="turn-undo-confirm"
                disabled={undoing.isPending}
                onClick={() => undoing.mutate()}
              >
                {undoing.isPending ? "Undoing…" : "Undo edits"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={undoing.isPending}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              data-testid="turn-undo"
              onClick={() => {
                undoing.reset();
                setConfirming(true);
              }}
            >
              Undo
              <Undo2 aria-hidden data-icon="inline-end" />
            </Button>
          )}
          {!confirming && (
            <Button
              size="sm"
              variant="outline"
              data-testid="turn-view-changes"
              onClick={viewChanges}
            >
              View changes
            </Button>
          )}
        </span>
      </div>
      {refused !== undefined && (
        <p role="status" data-testid="turn-undo-refused" className="text-xs text-muted-foreground">
          {refused}
        </p>
      )}
    </div>
  );
}
