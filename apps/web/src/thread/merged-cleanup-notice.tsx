import { worktreeSweepOf, type ThreadId, type ThreadSummary } from "@gram/contracts";
import { GitMerge } from "lucide-react";
import { create } from "zustand";

import { Button } from "@/components/ui/button";
import { worktreeMissing } from "@/components/worktree-missing";
import { useServerSettings } from "@/settings-sync/store";
import { useThreadsStore } from "@/stores/threads";

import { branchDeleteLooksSafe, cleanAndPushed, mergedPrRef } from "./merged-cleanup";
import { prRowOf, stripLayout } from "./pr-strip-model";
import { useThreadDialogs } from "./thread-dialogs-store";

/** Threads whose merged-cleanup offer was dismissed, until the app reloads. */
export const useCleanupDismissed = create<{
  ids: readonly string[];
  dismiss(threadId: ThreadId): void;
}>()((set) => ({
  ids: [],
  dismiss: (threadId) => set((s) => (s.ids.includes(threadId) ? s : { ids: [...s.ids, threadId] })),
}));

/** The cleanup a merged thread's worktree is offered, as the PR strip's row and the notice show it. */
export interface MergedCleanup {
  number: number;
  /** The sweep removes the worktree on its own soon after the merge (`MERGED_GRACE_MS`). */
  automatic: boolean;
  /** What the offer says, as one sentence. */
  status: string;
  /** "Clean up now…" or "Clean up…": the close dialog, preset to remove the worktree. */
  actionLabel: string;
  dismissLabel: string;
  open(): void;
  dismiss(): void;
  /** The PR strip's own row is this PR, so the offer rides on it instead of a notice of its own. */
  onStrip: boolean;
}

/**
 * After the thread's PR merged and settled it, the offer to clean up its worktree and local branch
 * through the close dialog, or the word that the sweep will remove a clean, pushed one on its own.
 * Nothing is deleted until the dialog is confirmed.
 */
export function useMergedCleanup(threadId: ThreadId): MergedCleanup | undefined {
  const summary = useThreadsStore((s) => s.byId[threadId]);
  const dismissed = useCleanupDismissed((s) => s.ids.includes(threadId));
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
    return undefined;
  }

  const automatic =
    settings !== undefined &&
    worktreeSweepOf(settings) !== undefined &&
    cleanAndPushed(summary?.git);
  const { branch } = thread.checkout;
  return {
    number: merged.number,
    automatic,
    status: automatic
      ? `#${merged.number} merged. Its worktree is removed soon.`
      : `#${merged.number} merged. Remove its worktree${branch ? ` and the branch ${branch}` : ""}?`,
    actionLabel: automatic ? "Clean up now…" : "Clean up…",
    dismissLabel: automatic ? "Hide" : "Not now",
    open: () =>
      useThreadDialogs.getState().open({
        kind: "close",
        threadId,
        preset: { removeWorktree: true, deleteBranch: branchDeleteLooksSafe(summary?.git) },
      }),
    dismiss: () => useCleanupDismissed.getState().dismiss(threadId),
    onStrip: stripShowsPr(summary, merged),
  };
}

/** Whether the PR strip draws `pr` as the thread's own row: it is that PR and isn't hidden. */
function stripShowsPr(
  summary: ThreadSummary | undefined,
  pr: { repo: string; number: number },
): boolean {
  const row = prRowOf(summary?.thread.boundPr, summary?.git);
  if (row === undefined || row.number !== pr.number || row.fullRepo !== pr.repo) return false;
  return stripLayout(row, [], summary?.thread.hiddenPrs).visible.length > 0;
}

/**
 * The cleanup offer on its own, for when the PR strip doesn't show the merged PR (its row is
 * hidden); otherwise the strip's row carries it, so the PR shows once.
 */
export function MergedCleanupNotice({ threadId }: { threadId: ThreadId }) {
  const cleanup = useMergedCleanup(threadId);
  if (cleanup === undefined || cleanup.onStrip) return null;
  return (
    <aside
      aria-label="Merged pull request cleanup"
      data-testid="merged-cleanup-notice"
      className="mx-auto flex w-full max-w-(--thread-max-width) shrink-0 items-center gap-3 px-6 py-2 text-sm"
    >
      <GitMerge aria-hidden className="size-4 shrink-0 text-merged" />
      <p className="min-w-0 flex-1">{cleanup.status}</p>
      <Button size="sm" variant="outline" onClick={cleanup.open}>
        {cleanup.actionLabel}
      </Button>
      <Button size="sm" variant="ghost" onClick={cleanup.dismiss}>
        {cleanup.dismissLabel}
      </Button>
    </aside>
  );
}
