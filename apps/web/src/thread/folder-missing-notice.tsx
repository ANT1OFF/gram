import { effectiveCheckout, type ThreadId } from "@gram/contracts";
import { FolderX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { worktreeMissing } from "@/components/worktree-missing";
import { useThreadsStore } from "@/stores/threads";

import { RestoreWorktreeActions } from "./restore-worktree";
import { useThreadDialogs } from "./thread-dialogs-store";

/**
 * Above the composer while the thread's folder is gone: its agent was stopped and a send is
 * refused, so this says why, and offers to restore a worktree or close the thread.
 */
export function FolderMissingNotice({ threadId }: { threadId: ThreadId }) {
  const summary = useThreadsStore((s) => s.byId[threadId]);
  if (summary === undefined || !worktreeMissing(summary.git)) return null;
  // The git state is the followed worktree's when the agent moved into one.
  const checkout = effectiveCheckout(summary.thread);
  const branch = summary.git?.branch ?? checkout.branch;
  const what = checkout.kind === "worktree" ? "worktree" : "folder";
  return (
    <aside
      aria-label="Folder missing"
      data-testid="folder-missing-notice"
      className="mx-auto flex w-full max-w-(--thread-max-width) shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-6 py-2 text-sm"
    >
      <FolderX aria-hidden className="size-4 shrink-0 text-warning-text" />
      <p className="min-w-0 flex-1">
        This thread's {what} was deleted outside Gram, so its agent can't run.{" "}
        <span className="text-muted-foreground">
          {checkout.kind === "worktree"
            ? `Uncommitted work in it is lost; commits on ${branch ?? "its branch"} are kept in the repository.`
            : "Anything in it that wasn't pushed is lost."}
        </span>
      </p>
      {checkout.kind === "worktree" && <RestoreWorktreeActions threadId={threadId} />}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => useThreadDialogs.getState().open({ kind: "close", threadId })}
      >
        Close thread…
      </Button>
    </aside>
  );
}
