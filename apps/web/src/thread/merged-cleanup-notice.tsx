import { worktreeSweepOf, type ThreadId } from "@gram/contracts";
import { GitMerge } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { worktreeMissing } from "@/components/worktree-missing";
import { useServerSettings } from "@/settings-sync/store";
import { useThreadsStore } from "@/stores/threads";

import { branchDeleteLooksSafe, cleanAndPushed, mergedPrRef } from "./merged-cleanup";
import { useThreadDialogs } from "./thread-dialogs-store";

/**
 * After the thread's PR merged and settled it, offers to clean up its worktree and local branch
 * through the close dialog, or says the sweep will remove a clean, pushed one on its own. Nothing is
 * deleted from here until the dialog is confirmed.
 */
export function MergedCleanupNotice({ threadId }: { threadId: ThreadId }) {
  const summary = useThreadsStore((s) => s.byId[threadId]);
  const [dismissed, setDismissed] = useState(false);
  const settings = useServerSettings((s) => s.settings);
  const thread = summary?.thread;
  const merged = mergedPrRef(summary);
  if (
    dismissed ||
    thread === undefined ||
    merged === undefined ||
    thread.completedReason !== "prMerged" ||
    thread.checkout.kind !== "worktree" ||
    // Gone already: the folder-missing notice offers the close.
    worktreeMissing(summary?.git)
  ) {
    return null;
  }

  // The sweep removes a clean, pushed worktree on its own soon after the merge (`MERGED_GRACE_MS`).
  const automatic =
    settings !== undefined &&
    worktreeSweepOf(settings) !== undefined &&
    cleanAndPushed(summary?.git);

  return (
    <aside
      aria-label="Merged pull request cleanup"
      data-testid="merged-cleanup-notice"
      className="mx-auto flex w-full max-w-(--thread-max-width) shrink-0 items-center gap-3 px-6 py-2 text-sm"
    >
      <GitMerge aria-hidden className="size-4 shrink-0 text-merged" />
      <p className="min-w-0 flex-1">
        {automatic
          ? `#${merged.number} merged. Its worktree is removed soon.`
          : `#${merged.number} merged. Remove its worktree${thread.checkout.branch ? ` and the branch ${thread.checkout.branch}` : ""}?`}
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          useThreadDialogs.getState().open({
            kind: "close",
            threadId,
            preset: { removeWorktree: true, deleteBranch: branchDeleteLooksSafe(summary?.git) },
          })
        }
      >
        {automatic ? "Clean up now…" : "Clean up…"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
        {automatic ? "Hide" : "Not now"}
      </Button>
    </aside>
  );
}
