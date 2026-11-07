import type { ThreadId } from "@gram/contracts";

import { useLayoutStore } from "@/stores/layout";

/**
 * Opens `threadId` in a pane beside the focused one, which keeps the focus: one pane splits in two
 * with it on the right, and a split grid takes it in the pane next to the focused one. A thread
 * already in a pane stays where it is.
 */
export function openThreadBeside(threadId: ThreadId) {
  const { grid, toggleSplit, openInPane } = useLayoutStore.getState();
  if (grid.panes.includes(threadId)) return;
  if (grid.preset === "1") {
    toggleSplit(threadId);
    return;
  }
  const next = grid.focused + 1 < grid.panes.length ? grid.focused + 1 : grid.focused - 1;
  if (next >= 0) openInPane(threadId, next);
}
