import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { HISTORY_TEST_ID, useHistoryStore } from "@/history/history-view";
import { toggleInbox } from "@/inbox/inbox-store";
import { INBOX_TEST_ID } from "@/inbox/inbox-view";
import { paneMoveKeys, THREAD_STEP_KEYS } from "@/keyboard/catalog";
import { keyLabel, registerShortcut, useShortcut } from "@/keyboard/registry";
import { besideToggle, closeBeside, keepBeside } from "@/orchestration/beside-store";
import { boardWorkspaceFor } from "@/orchestration/board-model";
import { useOpenBoard } from "@/orchestration/open-board";
import { useWorkspaces } from "@/orchestration/use-orchestration";
import { toggleWorkersTab } from "@/orchestration/workers-tab";
import { useOpenSettings } from "@/settings/open-settings";
import {
  fitShell,
  GRID_PRESETS,
  splitCandidate,
  useLayoutStore,
  type FocusDirection,
} from "@/stores/layout";
import { useRouteThreadId } from "@/shell/route-params";
import { useThreadsStore } from "@/stores/threads";
import { toggleOverviewSidebar } from "@/views/shell-layout";

import { focusPanel, focusSidebar } from "./focus-regions";
import { startNewTask } from "./new-task";
import { focusPaneComposer, gridShown } from "./pane-focus";
import { stepThread } from "./step-thread";
import { useOpenThread } from "./thread-switcher";

const inNoDialogBut = (own: string): boolean => {
  const dialog = document.activeElement?.closest("[role='dialog'], [role='alertdialog']");
  return dialog === null || dialog === undefined || dialog.getAttribute("data-testid") === own;
};

const withPaneFocus = (change: () => void) => () => {
  change();
  focusPaneComposer(useLayoutStore.getState().grid.focused);
};
const FOCUS_KEYS: readonly [FocusDirection, string][] = [
  ["left", "arrowleft"],
  ["right", "arrowright"],
  ["up", "arrowup"],
  ["down", "arrowdown"],
];

/** App-wide bindings; component-scoped ones (composer, cards) register where they live. */
export function useGlobalShortcuts() {
  const navigate = useNavigate();
  const openSettings = useOpenSettings();
  const router = useRouter();
  const currentId = useRouteThreadId();

  useShortcut({
    id: "palette.open",
    keys: "mod+k",
    label: "Command palette",
    group: "App",
    allowInDialogs: true,
    run: () => {
      const { paletteOpen, openPalette, closePalette } = useLayoutStore.getState();
      if (paletteOpen) closePalette();
      else openPalette();
    },
  });

  useShortcut({
    id: "palette.actions",
    keys: "mod+shift+p",
    label: "Actions",
    group: "App",
    allowInDialogs: true,
    run: () => useLayoutStore.getState().openPalette(">"),
  });

  useShortcut({
    id: "overlay.shortcuts",
    keys: "?",
    label: "Keyboard shortcuts",
    group: "App",
    run: () => useLayoutStore.getState().setOverlayOpen(true),
  });

  useShortcut({
    id: "overlay.shortcutsAnywhere",
    keys: "mod+/",
    label: "Keyboard shortcuts, also while typing",
    group: "App",
    allowInDialogs: true,
    run: () => {
      const { overlayOpen, setOverlayOpen } = useLayoutStore.getState();
      setOverlayOpen(!overlayOpen);
    },
  });

  useShortcut({
    id: "thread.new",
    keys: "mod+n",
    label: "New task",
    group: "Navigation",
    run: () => startNewTask((to) => void navigate({ to })),
  });

  useShortcut({
    id: "settings.open",
    keys: "mod+,",
    label: "Settings",
    group: "App",
    run: openSettings,
  });

  const workspaces = useWorkspaces();
  const openBoard = useOpenBoard();
  const boardWorkspace = () =>
    boardWorkspaceFor(
      currentId === undefined ? undefined : useThreadsStore.getState().byId[currentId]?.thread,
      workspaces,
    );
  useShortcut({
    id: "orchestration.board",
    keys: "mod+shift+d",
    label: "Open board",
    group: "Navigation",
    when: () => boardWorkspace() !== undefined,
    run: () => {
      const workspaceId = boardWorkspace();
      if (workspaceId !== undefined) openBoard(workspaceId);
    },
  });

  useShortcut({
    id: "workers.open",
    keys: "mod+j",
    label: "Workers",
    group: "Navigation",
    when: () => inNoDialogBut("") && boardWorkspace() !== undefined,
    run: toggleWorkersTab,
  });

  useShortcut({
    id: "history.open",
    keys: "mod+shift+h",
    label: "History",
    group: "Navigation",
    allowInDialogs: true,
    when: () => inNoDialogBut(HISTORY_TEST_ID),
    run: () => useHistoryStore.getState().toggle(),
  });

  useShortcut({
    id: "inbox.open",
    keys: "mod+shift+i",
    label: "Inbox",
    group: "Navigation",
    allowInDialogs: true,
    when: () => inNoDialogBut(INBOX_TEST_ID),
    run: toggleInbox,
  });
  useShortcut({
    id: "view.needsYou",
    keys: "mod+alt+3",
    label: "Inbox",
    group: "Navigation",
    allowInDialogs: true,
    when: () => inNoDialogBut(INBOX_TEST_ID),
    run: toggleInbox,
  });

  const openThread = useOpenThread();
  useShortcut({
    id: "split.toggle",
    keys: "mod+\\",
    label: "Open beside / split",
    group: "Navigation",
    when: () => currentId !== undefined,
    run: () => {
      const focused = useLayoutStore.getState().grid.panes[useLayoutStore.getState().grid.focused];
      const beside = besideToggle(focused ?? undefined);
      if (beside === "close") return closeBeside();
      if (beside !== undefined && keepBeside(beside, openThread)) return;
      const { grid, toggleSplit } = useLayoutStore.getState();
      const summaries = Object.values(useThreadsStore.getState().byId);
      toggleSplit(grid.preset === "1" ? splitCandidate(summaries, grid.panes) : undefined);
    },
  });

  useShortcut({
    id: "pane.maximize",
    keys: "mod+shift+enter",
    label: "Maximize / restore pane",
    group: "Navigation",
    when: () => currentId !== undefined,
    run: () => useLayoutStore.getState().toggleMaximize(),
  });

  useShortcut({
    id: "history.back",
    keys: "mod+[",
    label: "Back",
    group: "Navigation",
    skipWhileTyping: true,
    when: () => router.history.canGoBack(),
    run: () => router.history.back(),
  });

  useShortcut({
    id: "history.forward",
    keys: "mod+]",
    label: "Forward",
    group: "Navigation",
    skipWhileTyping: true,
    run: () => router.history.forward(),
  });

  useShortcut({
    id: "pane.previous",
    keys: "mod+shift+[",
    label: "Focus previous pane",
    group: "Navigation",
    when: () => useLayoutStore.getState().grid.panes.length > 1,
    run: withPaneFocus(() => useLayoutStore.getState().cycleFocus(-1)),
  });

  useShortcut({
    id: "pane.next",
    keys: "mod+shift+]",
    label: "Focus next pane",
    group: "Navigation",
    when: () => useLayoutStore.getState().grid.panes.length > 1,
    run: withPaneFocus(() => useLayoutStore.getState().cycleFocus(1)),
  });

  useShortcut({
    id: "sidebar.toggle",
    keys: "mod+b",
    label: "Collapse / expand sidebar",
    group: "App",
    run: toggleOverviewSidebar,
  });

  useShortcut({
    id: "panel.toggle",
    keys: "mod+alt+b",
    label: "Show / hide right panel",
    group: "App",
    run: () => useLayoutStore.getState().togglePanel(),
  });

  useShortcut({
    id: "composer.focus",
    keys: "mod+l",
    label: "Focus composer",
    group: "Composer",
    when: gridShown,
    run: () => focusPaneComposer(useLayoutStore.getState().grid.focused, { always: true }),
  });

  useShortcut({
    id: "sidebar.focus",
    keys: "mod+alt+s",
    label: "Focus sidebar",
    group: "App",
    run: () => void focusSidebar(),
  });

  useShortcut({
    id: "panel.focus",
    keys: "mod+alt+p",
    label: "Focus right panel",
    group: "App",
    run: () => void focusPanel(),
  });

  useShortcut({
    id: "review.focus",
    keys: "mod+alt+f",
    label: "Focus review",
    group: "App",
    run: () => useLayoutStore.getState().toggleReviewFocus(),
  });

  useShortcut({
    id: "diff.toggle",
    keys: "mod+d",
    label: "Show / hide the diff",
    group: "App",
    when: () => currentId !== undefined,
    run: () => {
      const layout = useLayoutStore.getState();
      if (layout.panelTab === "diff" && fitShell(layout).panel !== "none") layout.togglePanel();
      else layout.revealPanel("diff", { thread: true });
    },
  });

  useShortcut({
    id: "thread.next",
    keys: THREAD_STEP_KEYS.next,
    label: "Next thread in the sidebar",
    group: "Navigation",
    run: () => stepThread(1, currentId, openThread),
  });

  useShortcut({
    id: "thread.previous",
    keys: THREAD_STEP_KEYS.previous,
    label: "Previous thread in the sidebar",
    group: "Navigation",
    run: () => stepThread(-1, currentId, openThread),
  });

  useShortcut({
    id: "focus.toggle",
    keys: "mod+shift+.",
    label: "Hide side panels",
    group: "App",
    run: () => useLayoutStore.getState().toggleFocusMode(),
  });

  useEffect(() => {
    const moveFocus = FOCUS_KEYS.map(([direction, key]) =>
      registerShortcut({
        id: `pane.move-${direction}`,
        keys: paneMoveKeys(key),
        label: `Move focus between panes (${window.gram?.platform === "linux" ? "Alt+Shift" : keyLabel("⌥")} arrows)`,
        group: "Navigation",
        hidden: direction !== "left",
        when: gridShown,
        run: withPaneFocus(() => useLayoutStore.getState().moveFocus(direction)),
      }),
    );
    const layoutPreset = GRID_PRESETS.map((preset, i) =>
      registerShortcut({
        id: `layout.preset${i + 1}`,
        keys: `ctrl+shift+${i + 1}`,
        label: "Layout presets 1–6, in the picker's order",
        group: "Navigation",
        hidden: i !== 0,
        when: gridShown,
        allowInInputs: true,
        run: () => useLayoutStore.getState().setPreset(preset),
      }),
    );
    return () => {
      for (const unregister of [...moveFocus, ...layoutPreset]) unregister();
    };
  }, []);
}
