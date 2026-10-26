import type { ThreadId } from "@gram/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useApi } from "@/api/context";
import { isNotImplemented } from "@/api/errors";
import { useShortcut } from "@/keyboard/registry";
import { useLayoutStore } from "@/stores/layout";

import { openInNewWindow } from "./open-in-new-window";
import { currentWindow } from "./window-identity";
import { useWindowPlacements } from "./window-placements";

const focusedThreadId = (): ThreadId | undefined => {
  const { grid } = useLayoutStore.getState();
  return grid.panes[grid.focused] ?? undefined;
};

const shownThreads = (): ThreadId[] => [
  ...new Set(useLayoutStore.getState().grid.panes.filter((id): id is ThreadId => id !== null)),
];

/**
 * Mount once per window: registers the window with the server, reports the threads its panes show,
 * keeps every window's placement for the markers, and opens threads handed to it by another window.
 * The closed-thread stack and Ctrl+Tab order stay per window.
 */
export function useWindowPlacementsSync() {
  const api = useApi();
  const navigate = useNavigate();

  useEffect(() => {
    const self = currentWindow();
    const abort = new AbortController();
    let reported: string | undefined;
    let reportedThreads: string | undefined;
    const report = (force: boolean) => {
      const threadIds = shownThreads();
      const visible = document.visibilityState !== "hidden";
      const focused = visible && document.hasFocus();
      const focusedThread = focusedThreadId() ?? null;
      const key = `${threadIds.join(",")}|${visible}|${focused}|${focusedThread}`;
      if (!force && key === reported) return;
      reported = key;
      reportedThreads = threadIds.join(",");
      api
        .reportWindow(self.id, threadIds, {
          visible,
          focused,
          focusedThreadId: focusedThread,
        })
        .catch((error: unknown) => {
          if (!isNotImplemented(error)) console.error("windows: report", error);
        });
    };
    const unsubscribe = useLayoutStore.subscribe(() => report(false));
    // A minimised or backgrounded window is one the server needn't poll GitHub for.
    const onPresence = () => report(false);
    document.addEventListener("visibilitychange", onPresence);
    window.addEventListener("focus", onPresence);
    window.addEventListener("blur", onPresence);
    void (async () => {
      try {
        const watch = api.watchWindows({ windowId: self.id, name: self.name }, abort.signal);
        for await (const placements of watch) {
          useWindowPlacements.getState().setWindows(placements.windows);
          // A fresh registration (or a reconnect) starts with no threads: report them again.
          const mine = placements.windows.find((w) => w.windowId === self.id);
          if (mine && mine.threadIds.join(",") !== reportedThreads) report(true);
        }
      } catch (error) {
        if (!abort.signal.aborted && !isNotImplemented(error))
          console.error("windows: watch", error);
      }
    })();
    return () => {
      abort.abort();
      unsubscribe();
      document.removeEventListener("visibilitychange", onPresence);
      window.removeEventListener("focus", onPresence);
      window.removeEventListener("blur", onPresence);
    };
  }, [api]);

  useEffect(() => {
    const open = (threadId: string) => {
      useLayoutStore.getState().openThread(threadId as ThreadId);
      void navigate({ to: "/t/$threadId", params: { threadId } });
    };
    const initial = currentWindow().initialThreadId;
    if (initial) open(initial);
    return window.gram?.onOpenThread?.(open);
  }, [navigate]);

  useShortcut({
    id: "window.openThread",
    keys: "mod+shift+o",
    label: "Open thread in new window",
    group: "Navigation",
    when: () => focusedThreadId() !== undefined,
    run: () => {
      const threadId = focusedThreadId();
      if (threadId) void openInNewWindow(threadId);
    },
  });

  // The desktop menu owns ⌘⇧N there.
  useShortcut({
    id: "window.new",
    keys: "mod+shift+n",
    label: "New window",
    group: "App",
    when: () => !window.gram,
    run: () => void openInNewWindow(),
  });
}
