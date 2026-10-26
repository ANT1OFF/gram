import type { Thread, ThreadId } from "@gram/contracts";

import { useLayoutStore, type GridState } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { useViewStore } from "@/views/view-store";

import { focusPaneComposer, gridShown } from "./pane-focus";

// ⌘N, File → New Task and the desktop menu's New Task: a new task is a message. With an orchestrator on screen in the Orchestrator
// layout, they put the caret in its composer; anywhere else they open the New task draft as before.

/**
 * The pane showing an orchestrator, the focused pane first, then the others on screen. `undefined`
 * when none does; a maximized grid shows only its focused pane.
 */
export function orchestratorPane(
  grid: Pick<GridState, "panes" | "focused" | "maximized">,
  threadOf: (threadId: ThreadId) => Pick<Thread, "role"> | undefined,
): number | undefined {
  const isOrchestrator = (index: number) => {
    const id = grid.panes[index];
    return id !== null && id !== undefined && threadOf(id)?.role === "orchestrator";
  };
  if (isOrchestrator(grid.focused)) return grid.focused;
  if (grid.maximized) return undefined;
  const other = grid.panes.findIndex((_, index) => index !== grid.focused && isOrchestrator(index));
  return other === -1 ? undefined : other;
}

/**
 * Starts a new task: the orchestrator's composer when one is on screen, its draft kept and the
 * caret at its end, else `go` to the New task draft. Board over the orchestrator's chat
 * gives way to Chat. Quiet, Settings, a new-task draft or a plain thread keep the draft.
 */
export function startNewTask(go: (path: "/new-task") => void): void {
  const pane =
    !useViewStore.getState().quiet && gridShown()
      ? orchestratorPane(
          useLayoutStore.getState().grid,
          (id) => useThreadsStore.getState().byId[id]?.thread,
        )
      : undefined;
  if (pane === undefined) {
    go("/new-task");
    return;
  }
  useViewStore.getState().setView("chat");
  useLayoutStore.getState().focusPane(pane);
  focusPaneComposer(pane, { always: true });
  requestAnimationFrame(() => {
    const composer = document.activeElement;
    if (composer instanceof HTMLTextAreaElement) {
      composer.setSelectionRange(composer.value.length, composer.value.length);
    }
  });
}
