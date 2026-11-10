import { create } from "zustand";

import { fitShell, useLayoutStore } from "@/stores/layout";

import type { OpenCommand } from "./command-view-model";

// Which command the right panel's Command tab shows, opened from its line above the composer. Each
// window keeps its own, in memory only: a reload or another machine starts without one.

interface CommandViewState {
  /** The command the Command tab shows. */
  readonly open: OpenCommand | undefined;
  /** The right panel shows the Command tab, rather than another tab with the command kept in reach. */
  readonly shown: boolean;
  show: (open: OpenCommand) => void;
  setShown: (shown: boolean) => void;
  close: () => void;
}

export const useCommandViewStore = create<CommandViewState>()((set) => ({
  open: undefined,
  shown: false,
  show: (open) => set({ open, shown: true }),
  setShown: (shown) => set((s) => (s.shown === shown ? s : { shown })),
  close: () => set({ open: undefined, shown: false }),
}));

/** The same command as `open`, by its task or its tool call. */
export const sameCommand = (a: OpenCommand | undefined, b: OpenCommand): boolean =>
  a !== undefined &&
  a.threadId === b.threadId &&
  ((a.taskId !== undefined && a.taskId === b.taskId) ||
    (a.toolCallId !== undefined && a.toolCallId === b.toolCallId));

/**
 * Shows `open` in the right panel's Command tab, showing the panel however it fits. A command
 * already shown there is put away again, as a second click on its line does.
 */
export function toggleCommandView(open: OpenCommand) {
  const state = useCommandViewStore.getState();
  if (state.shown && sameCommand(state.open, open)) {
    state.close();
    return;
  }
  state.show(open);
  const layout = useLayoutStore.getState();
  // A review in focus would cover the chat whose command this is.
  if (layout.reviewFocus) layout.setReviewFocus(false);
  if (fitShell(layout).panel === "none") layout.revealPanel(undefined, { thread: true });
}
