import { effectiveCheckout, type ThreadId } from "@gram/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FolderX } from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { useLayoutStore } from "@/stores/layout";
import { closeThread, useThreadsStore } from "@/stores/threads";
import { RestoreWorktreeActions } from "@/thread/restore-worktree";

/**
 * A panel's empty state when the thread's folder is missing or unreadable, with a way out: restoring
 * a worktree, or closing the thread.
 */
export function FolderMissing({ threadId, problem }: { threadId: ThreadId; problem: string }) {
  const api = useApi();
  const navigate = useNavigate();
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string>();
  const worktree = useThreadsStore((s) => {
    const thread = s.byId[threadId]?.thread;
    return thread !== undefined && effectiveCheckout(thread).kind === "worktree";
  });

  const close = async () => {
    setClosing(true);
    setError(undefined);
    try {
      await closeThread(api, threadId);
    } catch (e) {
      setError(`Couldn't close the thread: ${errorMessage(e)}`);
      setClosing(false);
      return;
    }
    const { grid, closePane } = useLayoutStore.getState();
    const index = grid.panes.indexOf(threadId);
    if (index !== -1) closePane(index);
    const next = useLayoutStore.getState().grid;
    const focused = next.panes[next.focused];
    if (focused) void navigate({ to: "/t/$threadId", params: { threadId: focused } });
    else void navigate({ to: "/" });
  };

  return (
    <div
      role="status"
      data-testid="folder-missing"
      className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground"
    >
      <FolderX aria-hidden className="size-5" />
      <p>{problem}</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {worktree && <RestoreWorktreeActions threadId={threadId} />}
        <Button size="sm" variant="outline" disabled={closing} onClick={() => void close()}>
          Close thread
        </Button>
      </div>
      {error && <p className="text-xs text-danger-text">{error}</p>}
    </div>
  );
}
