import type { ThreadId, WindowPlacement } from "@gram/contracts";
import { create } from "zustand";

interface WindowPlacementsState {
  /** Every window (this one included) and the threads it shows. */
  readonly windows: readonly WindowPlacement[];
  setWindows(windows: readonly WindowPlacement[]): void;
}

export const useWindowPlacements = create<WindowPlacementsState>()((set) => ({
  windows: [],
  setWindows: (windows) => set({ windows }),
}));

/** The other window showing `threadId`, if any; this window's own placement doesn't count. */
export function otherWindowShowing(
  windows: readonly WindowPlacement[],
  threadId: ThreadId,
  selfId: string,
): WindowPlacement | undefined {
  return windows.find((w) => w.windowId !== selfId && w.threadIds.includes(threadId));
}
