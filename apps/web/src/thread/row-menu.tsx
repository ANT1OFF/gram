import type { ThreadId } from "@gram/contracts";
import { GitMerge } from "lucide-react";
import type { DragEvent, KeyboardEvent, ReactNode } from "react";

import { ContextMenuItem } from "@/components/ui/context-menu";
import { useOrchestratorLedger } from "@/orchestration/use-orchestration";
import { THREAD_DRAG_TYPE } from "@/shell/drag";
import { useThreadsStore } from "@/stores/threads";

import { branchDeleteLooksSafe, mergedPrRef } from "./merged-cleanup";
import { ReleaseContextMenuItem, ThreadContextMenuItems } from "./thread-action-items";
import { useThreadDialogs } from "./thread-dialogs-store";

// The context menu of a row that stands for one thread (the overview's workers and solo threads),
// and what makes such a row a drag source for the grid's panes.

/** Opens a row's context menu at `anchor`, as a right-click there would. */
function openRowMenu(anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  anchor.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.bottom,
    }),
  );
}

/** Shift+F10 or the menu key on a row: its context menu, as a right-click there. */
export const rowMenuKeys = (event: KeyboardEvent<HTMLElement>) => {
  if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
    event.preventDefault();
    openRowMenu(event.currentTarget);
  }
};

/** A row's drag, onto a grid pane, which opens the thread there. */
export const threadDragProps = (threadId: ThreadId) => ({
  draggable: true,
  onDragStart: (event: DragEvent<HTMLElement>) => {
    event.dataTransfer.setData(THREAD_DRAG_TYPE, threadId);
    event.dataTransfer.effectAllowed = "move";
  },
});

/**
 * A row's context menu: the row's own group, then the thread's verbs and More…. What the menu cap
 * test measures.
 */
export function RowMenuItems({
  threadId,
  menuItems,
}: {
  threadId: ThreadId;
  menuItems?: ReactNode;
}) {
  return (
    <>
      {menuItems}
      <ThreadContextMenuItems threadId={threadId} separated={menuItems !== undefined} />
    </>
  );
}

/**
 * A worker row's own group, before its thread verbs: Hand back while the user holds it, and Clean
 * up once its PR merged. Its board and orchestrator are a click away in More….
 */
export function WorkerMenuItems({
  threadId,
  held,
  cleanable,
}: {
  threadId: ThreadId;
  held: boolean;
  cleanable: boolean;
}) {
  return (
    <>
      {held && <ReleaseContextMenuItem threadId={threadId} />}
      {cleanable && (
        <ContextMenuItem
          onClick={() =>
            useThreadDialogs.getState().open({
              kind: "close",
              threadId,
              preset: {
                removeWorktree: true,
                // The row's summary may be behind on git it doesn't list by.
                deleteBranch: branchDeleteLooksSafe(useThreadsStore.getState().byId[threadId]?.git),
              },
            })
          }
        >
          <GitMerge aria-hidden className="size-3.5" />
          Clean up worktree…
        </ContextMenuItem>
      )}
    </>
  );
}

/** A worker's whole row menu: whether the user holds it from its workspace's ledger, read on open. */
export function WorkerRowMenuItems({ threadId }: { threadId: ThreadId }) {
  const summary = useThreadsStore((s) => s.byId[threadId]);
  const { data: ledger } = useOrchestratorLedger(summary?.thread.workspaceId);
  const held =
    ledger?.features
      .flatMap((feature) => feature.workers)
      .some((worker) => worker.threadId === threadId && worker.userIntervened === true) ?? false;
  // What the thread's own merged notice offers, for a worker nobody opens again once it merged.
  const cleanable =
    summary !== undefined &&
    summary.thread.checkout.kind === "worktree" &&
    mergedPrRef(summary) !== undefined;
  return (
    <RowMenuItems
      threadId={threadId}
      menuItems={
        held || cleanable ? (
          <WorkerMenuItems threadId={threadId} held={held} cleanable={cleanable} />
        ) : undefined
      }
    />
  );
}
