import type { RestoreWorktreeResult, ThreadId } from "@gram/contracts";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { useThreadsStore } from "@/stores/threads";

const SOURCE_TEXT: Record<Extract<RestoreWorktreeResult, { _tag: "restored" }>["source"], string> =
  {
    local: "its local branch",
    origin: "origin's copy of the branch",
    pr: "its pull request's head",
  };

/** The toast for a restore that went through; it says plainly what didn't come back. */
const restoredText = (result: Extract<RestoreWorktreeResult, { _tag: "restored" }>) =>
  `Restored ${result.branch} from ${SOURCE_TEXT[result.source]}. Work that wasn't committed couldn't be recovered.`;

/** Why a branch gone everywhere can or can't come back. */
const branchGoneText = (result: Extract<RestoreWorktreeResult, { _tag: "branchGone" }>) =>
  result.pr === undefined
    ? `${result.branch} is gone from the repository and from origin, and there is no pull request to recreate it from, so the worktree can't be restored.`
    : `${result.branch} is gone from the repository and from origin. It can be recreated from #${result.pr.number}'s head.`;

/**
 * "Restore worktree" for a thread whose worktree was deleted outside Gram, and, when its
 * branch is gone everywhere, the offer to recreate it from its PR's head.
 */
export function RestoreWorktreeActions({ threadId }: { threadId: ThreadId }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState<Extract<RestoreWorktreeResult, { _tag: "branchGone" }>>();
  const [error, setError] = useState<string>();

  const restore = async (fromPr: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.restoreWorktree(threadId, fromPr);
      if (result._tag === "branchGone") setGone(result);
      else {
        setGone(undefined);
        useThreadsStore
          .getState()
          .applyEvent({ type: "notify", kind: "done", title: restoredText(result), threadId });
      }
    } catch (e) {
      setError(`Couldn't restore the worktree: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {gone === undefined ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void restore(false)}>
          Restore worktree
        </Button>
      ) : (
        gone.pr !== undefined && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void restore(true)}>
            Recreate from #{gone.pr.number}
          </Button>
        )
      )}
      {(gone !== undefined || error !== undefined) && (
        <p data-testid="restore-worktree-problem" className="basis-full text-xs text-danger-text">
          {error ?? branchGoneText(gone!)}
        </p>
      )}
    </>
  );
}
