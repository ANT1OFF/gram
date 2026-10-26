import type { ThreadId } from "@gram/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useApi } from "@/api/context";
import { isNotImplemented } from "@/api/errors";
import { currentWindow } from "@/desktop/window-identity";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { gridLayout, restoreGrid } from "./mapping";
import { useServerSettings } from "./store";

const PERSIST_DEBOUNCE_MS = 500;

/**
 * Restores the saved pane grid once per launch and saves changes.
 * The primary window keeps its grid in `Settings.layout.grid`; another desktop window keeps its own
 * in the shell, restored with the window; another browser tab starts empty and saves nothing.
 */
export function useGridSync() {
  const api = useApi();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const params = useParams({ strict: false });
  const routeThread = params.threadId as ThreadId | undefined;
  const settings = useServerSettings((s) => s.settings);
  const ready = useThreadsStore((s) => s.ready);
  const grid = useLayoutStore((s) => s.grid);
  const restored = useRef(false);
  const persisted = useRef<string | undefined>(undefined);
  const { primary } = currentWindow();

  useEffect(() => {
    if (restored.current || !ready) return;
    const apply = (saved: ReturnType<typeof restoreGrid>) => {
      const { grid: current, setGrid, openThread } = useLayoutStore.getState();
      // A layout picked while settings were loading wins over the saved one.
      if (!saved || current.preset !== "1") return;
      setGrid(saved);
      if (routeThread) {
        openThread(routeThread);
        return;
      }
      const focused = saved.panes[saved.focused];
      if (pathname === "/" && focused)
        void navigate({ to: "/t/$threadId", params: { threadId: focused } });
    };
    const exists = (id: ThreadId) => id in useThreadsStore.getState().byId;

    if (!primary) {
      restored.current = true;
      void window.gram?.windowLayout?.().then((layout) => {
        persisted.current = layout ? JSON.stringify(layout) : undefined;
        apply(layout ? restoreGrid({ grid: layout }, exists) : undefined);
      });
      return;
    }
    if (!settings) return;
    restored.current = true;
    const layout = settings.layout;
    persisted.current = layout?.grid ? JSON.stringify(layout.grid) : undefined;
    apply(restoreGrid(layout, exists));
  }, [settings, ready, routeThread, pathname, navigate, primary]);

  useEffect(() => {
    if (!restored.current) return;
    const layout = gridLayout(grid);
    const key = JSON.stringify(layout);
    if (key === persisted.current) return;
    const timer = setTimeout(() => {
      persisted.current = key;
      if (!primary) {
        window.gram?.setWindowLayout?.(layout);
        return;
      }
      api.updateSettings({ layout: { grid: layout } }).catch((error: unknown) => {
        if (!isNotImplemented(error)) console.error("settings sync: save grid", error);
      });
    }, PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [api, grid, primary]);
}
