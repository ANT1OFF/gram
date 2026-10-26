import type { ThreadId } from "@gram/contracts";

import { focusWindowShowing } from "./open-in-new-window";
import { currentWindow } from "./window-identity";
import { otherWindowShowing, useWindowPlacements } from "./window-placements";

/**
 * Brings forward the desktop window already showing `threadId` and returns true, so the caller opens
 * nothing here. A browser tab can't be focused, so there it returns false and the thread opens here.
 */
export function focusOtherWindow(threadId: ThreadId): boolean {
  if (!window.gram?.focusWindow) return false;
  const windows = useWindowPlacements.getState().windows;
  if (!otherWindowShowing(windows, threadId, currentWindow().id)) return false;
  void focusWindowShowing(threadId);
  return true;
}
