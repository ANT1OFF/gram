import {
  chimeOf,
  workspaceMuted,
  type DesktopMenuAction,
  type ThreadId,
  type ThreadSummary,
} from "@gram/contracts";
import { isTranslucentLook, PRESET_PALETTES, resolvePalette } from "@gram/themes";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { useBindingsStore } from "@/keyboard/bindings-store";
import { isMac } from "@/keyboard/registry";
import { copyText } from "@/settings/copy-text";
import { useServerSettings } from "@/settings-sync/store";
import { WHATS_NEW } from "@/whats-new";
import { useWhatsNewDialog } from "@/whats-new/whats-new-dialog";
import { ownsCiFailure, useAttentionStore } from "@/sidebar/attention";
import { needsYou, nextNeedsYou } from "@/sidebar/grouping";
import { focusPaneComposer } from "@/shell/pane-focus";
import { useReportIssueDialog } from "@/report-issue/report-issue-dialog";
import { useLayoutStore } from "@/stores/layout";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";

import { scheduleChime } from "./chime";
import { awayEventOf, interrupts } from "./interrupt-policy";
import { menuShortcuts } from "./menu-shortcuts";
import { vibrancyAttribute } from "./vibrancy";
import { watchWindowLights } from "./window-lights";
import { windowZoomStep } from "./window-zoom-keys";
import { startNewTask } from "@/shell/new-task";
import { useThreadsStore } from "@/stores/threads";
import { themeStore } from "@/theme/store";
import { systemSource } from "@/theme/system";
import { resolveMode } from "@/theme/theme";

/** A local info toast, for menu commands that finish without navigating anywhere. */
const toast = (title: string, body: string) =>
  useThreadsStore.getState().applyEvent({ type: "notify", kind: "info", title, body });

/** The badge count: the threads that need the user (`needsYou`), as the sidebar surfaces them. */
export const needsYouCount = (
  summaries: Iterable<ThreadSummary>,
  acknowledged: Readonly<Record<string, string>> = useAttentionStore.getState().acknowledged,
): number => {
  let count = 0;
  for (const s of summaries) if (needsYou(s, acknowledged)) count++;
  return count;
};

/**
 * Wires the Electron preload bridge: menu commands, the needs-you badge, native notifications while
 * the window is unfocused, and the title bar / vibrancy following the theme. A no-op in a browser,
 * where `window.gram` is absent.
 */
export function useDesktopBridge() {
  const navigate = useNavigate();
  const api = useApi();

  useEffect(() => {
    const bridge = window.gram;
    if (!bridge) return;

    const onMenu = (action: DesktopMenuAction) => {
      switch (action) {
        case "newThread":
          startNewTask((to) => void navigate({ to }));
          return;
        case "palette": {
          // The menu takes ⌘K before the renderer sees it, so the toggle lives here too.
          const { paletteOpen, openPalette, closePalette } = useLayoutStore.getState();
          if (paletteOpen) closePalette();
          else openPalette();
          return;
        }
        case "settings":
          void navigate({ to: "/settings" });
          return;
        case "closePane": {
          const { grid, closePane } = useLayoutStore.getState();
          const othersShown = grid.panes.some((id, i) => id !== null && i !== grid.focused);
          if (othersShown) {
            closePane(grid.focused);
            focusPaneComposer(useLayoutStore.getState().grid.focused, {
              always: true,
            });
          } else void navigate({ to: "/" });
          return;
        }
        case "closeThread": {
          const { grid } = useLayoutStore.getState();
          const threadId = grid.panes[grid.focused];
          if (threadId) useThreadDialogs.getState().open({ kind: "close", threadId });
          return;
        }
        case "closeAllThreads":
          useThreadDialogs.getState().open({ kind: "closeAll" });
          return;
        case "whatsNew":
          useWhatsNewDialog.getState().show(WHATS_NEW);
          return;
        case "shortcuts":
          useLayoutStore.getState().setOverlayOpen(true);
          return;
        case "openLogsFolder":
          void api
            .openLogsFolder()
            .catch((error: unknown) => toast("Couldn't open the logs folder", errorMessage(error)));
          return;
        case "copyDiagnostics":
          void api
            .diagnosticsReport()
            .then((report) => copyText(report.text))
            .then(
              () =>
                toast(
                  "Diagnostics copied",
                  "Review them before sharing: paths can include project names.",
                ),
              (error: unknown) => toast("Couldn't copy diagnostics", errorMessage(error)),
            );
          return;
        case "reportIssue": {
          const { grid } = useLayoutStore.getState();
          useReportIssueDialog.getState().show(grid.panes[grid.focused] ?? undefined);
          return;
        }
        case "newWindow":
          return;
      }
    };

    let badge = -1;
    const syncBadge = () => {
      const count = needsYouCount(Object.values(useThreadsStore.getState().byId));
      if (count === badge) return;
      badge = count;
      bridge.setBadge(count);
    };

    const unsubscribeAttention = useAttentionStore.subscribe(syncBadge);
    const unsubscribeThreads = useThreadsStore.subscribe((state, prev) => {
      if (state.byId !== prev.byId) syncBadge();
      if (state.notifications === prev.notifications || document.hasFocus()) return;
      const known = new Set(prev.notifications);
      const prefs = useServerSettings.getState().settings?.notifications;
      const notifyAbout = prefs?.notifyAbout;
      let fresh = false;
      const byId = state.byId;
      for (const n of state.notifications) {
        // Only what the interrupt policy lets through; the rest waits for "Since you left".
        if (known.has(n) || !interrupts(awayEventOf(n), notifyAbout)) continue;
        if (
          n.ciFailure !== undefined &&
          n.threadId !== undefined &&
          byId[n.threadId] !== undefined &&
          ownsCiFailure(byId[n.threadId]!, n.ciFailure)
        )
          continue;
        const workspaceId =
          n.threadId === undefined ? undefined : byId[n.threadId]?.thread.workspaceId;
        const settings = useServerSettings.getState().settings;
        if (workspaceId !== undefined && settings && workspaceMuted(settings, workspaceId))
          continue;
        fresh = true;
        if (prefs?.native === false) continue;
        bridge.notify({
          title: n.title,
          body: n.body ?? "",
          ...(n.threadId ? { threadId: n.threadId } : {}),
        });
      }
      if (fresh && prefs) scheduleChime(chimeOf(prefs));
    });

    let chrome = "";
    const syncChrome = () => {
      const state = themeStore.getState();
      const mode = resolveMode(state.mode, systemSource.get().prefersDark);
      const palette = resolvePalette(
        [...PRESET_PALETTES, ...state.customPalettes],
        state.palette,
        mode,
      );
      const key = `${palette?.id}|${mode}|${state.look}`;
      if (key === chrome) return;
      chrome = key;
      if (palette) {
        bridge.setTitleBarTheme({
          background: palette.seeds.surface,
          foreground: palette.seeds.text,
          mode,
        });
      }
      bridge.setVibrancy(isTranslucentLook(state.look));
      const vibrancy = vibrancyAttribute(
        state.look,
        true,
        window.matchMedia?.("(prefers-reduced-transparency: reduce)").matches ?? false,
      );
      if (vibrancy) document.documentElement.dataset["vibrancy"] = vibrancy;
      else delete document.documentElement.dataset["vibrancy"];
    };

    syncBadge();
    syncChrome();
    const unsubscribeTheme = themeStore.subscribe(syncChrome);
    const unsubscribeSystem = systemSource.subscribe(syncChrome);
    const offMenu = bridge.onMenu(onMenu);
    // The window's zoom keys, which the menu leaves to the renderer (see `window-zoom-keys.ts`).
    // The shortcut registry listens on `window` too and was installed first, at startup, so a
    // press the focused terminal used for its own font size arrives here already handled and is
    // left alone.
    const onZoomKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || bridge.zoom === undefined) return;
      const step = windowZoomStep(event, isMac());
      if (step === undefined) return;
      event.preventDefault();
      bridge.zoom(step);
    };
    window.addEventListener("keydown", onZoomKey);
    const offClick = bridge.onNotificationClick((threadId) => {
      const target =
        (threadId as ThreadId | null) ??
        nextNeedsYou(Object.values(useThreadsStore.getState().byId), undefined);
      if (target) void navigate({ to: "/t/$threadId", params: { threadId: target } });
    });

    return () => {
      unsubscribeAttention();
      unsubscribeThreads();
      unsubscribeTheme();
      unsubscribeSystem();
      offMenu();
      offClick();
      window.removeEventListener("keydown", onZoomKey);
    };
  }, [navigate, api]);

  // macOS's window buttons keep their room in the overview's header and the title bar.
  useEffect(() => {
    const bridge = window.gram;
    if (!bridge) return;
    return watchWindowLights(bridge);
  }, []);

  // The menu's accelerators follow keybindings.json, like the renderer's shortcuts.
  useEffect(() => {
    const bridge = window.gram;
    if (!bridge?.setMenuShortcuts) return;
    const sync = () =>
      bridge.setMenuShortcuts?.(menuShortcuts(useBindingsStore.getState().overrides));
    sync();
    return useBindingsStore.subscribe(sync);
  }, []);
}
