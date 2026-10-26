import type { ThreadId } from "@gram/contracts";

import { useThreadsStore } from "@/stores/threads";

import { currentWindow } from "./window-identity";
import { otherWindowShowing, useWindowPlacements } from "./window-placements";

const notify = (title: string, body: string) =>
  useThreadsStore.getState().applyEvent({ type: "notify", kind: "info", title, body });

/**
 * Brings forward the window already showing `threadId`. In a browser a tab can't be focused, so it
 * says where the thread is instead. Returns whether another window shows it.
 */
export async function focusWindowShowing(threadId: ThreadId): Promise<boolean> {
  const other = otherWindowShowing(
    useWindowPlacements.getState().windows,
    threadId,
    currentWindow().id,
  );
  if (!other) return false;
  const bridge = window.gram;
  if (bridge?.focusWindow) return bridge.focusWindow(other.windowId, threadId);
  notify(`Open in ${other.name}`, "Switch to that tab to see it.");
  return true;
}

/** The address of a browser tab that names itself `name` and starts on `threadId`. */
function newTabUrl(origin: string, name: string, threadId?: ThreadId): string {
  const url = new URL("/", origin);
  url.searchParams.set("window", `tab-${Math.random().toString(36).slice(2, 10)}`);
  url.searchParams.set("name", name);
  if (threadId) url.searchParams.set("open", threadId);
  return url.toString();
}

/**
 * "Open in new window": the window already showing the thread comes forward instead of a duplicate.
 * Otherwise the desktop shell opens a window; in a browser, a new tab (only on this explicit action).
 */
export async function openInNewWindow(threadId?: ThreadId): Promise<void> {
  if (threadId && (await focusWindowShowing(threadId))) return;
  const bridge = window.gram;
  if (bridge) {
    await bridge.openWindow?.(threadId ? { threadId } : {});
    return;
  }
  const count = useWindowPlacements.getState().windows.length;
  window.open(
    newTabUrl(window.location.origin, `Window ${Math.max(2, count + 1)}`, threadId),
    "_blank",
    "noopener",
  );
}
