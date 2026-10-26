import type { ThreadId } from "@gram/contracts";
import { useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { registerShortcut, useShortcut } from "@/keyboard/registry";
import { besideToggle, closeBeside, keepBeside } from "@/orchestration/beside-store";
import { boardWorkspaceFor } from "@/orchestration/board-model";
import { useOpenBoard } from "@/orchestration/open-board";
import { useWorkspaces } from "@/orchestration/use-orchestration";
import { useWorkersListStore, WORKERS_LIST_TEST_ID } from "@/orchestration/workers-list";
import { GRID_PRESETS, splitCandidate, useLayoutStore, type FocusDirection } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { toggleOverviewSidebar } from "@/views/shell-layout";

import { focusOverviewWorkers, focusPanel, focusSidebar } from "./focus-regions";
import { startNewTask } from "./new-task";
import { focusPaneComposer, gridShown } from "./pane-focus";
import { useOpenThread } from "./thread-switcher";

/** Focus is in no dialog, or in the one with test id `own`: a toggle that may close itself. */
const inNoDialogBut = (own: string): boolean => {
  const dialog = document.activeElement?.closest("[role='dialog'], [role='alertdialog']");
  return dialog === null || dialog === undefined || dialog.getAttribute("data-testid") === own;
};

/** Runs a pane-focus change, then moves real focus into the pane the layout now counts as focused. */
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
  const router = useRouter();
  const params = useParams({ strict: false });
  const currentId = params.threadId as ThreadId | undefined;

  useShortcut({
    id: "palette.open",
    keys: "mod+k",
    label: "Command palette",
    group: "App",
    // The palette is a dialog itself, so its toggle has to work from inside one.
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
    // Toggles, so the overlay (a dialog) closes with the same keys.
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
    run: () => void navigate({ to: "/settings" }),
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

  // Every worker of the workspace, two steps from anywhere: ⌘J, then the worker. In the
  // Orchestrator layout with the overview open, its worker rows are where ⌘J lands.
  useShortcut({
    id: "workers.open",
    keys: "mod+j",
    label: "Workers",
    group: "Navigation",
    // Toggles, so the list (a dialog) closes with the same keys; no other dialog lets it open.
    allowInDialogs: true,
    when: () =>
      inNoDialogBut(WORKERS_LIST_TEST_ID) &&
      (useWorkersListStore.getState().open || boardWorkspace() !== undefined),
    // With the overview open, a jump into its workers; else, or with none there, the list.
    run: () => {
      if (useWorkersListStore.getState().open) return useWorkersListStore.getState().toggle();
      void focusOverviewWorkers().then((focused) => {
        if (!focused) useWorkersListStore.getState().toggle();
      });
    },
  });

  const openThread = useOpenThread();
  // A worker's key first: undock the one beside the chat, keep the focused worker beside its
  // orchestrator, or bring the last one back beside it. Otherwise the grid splits or unsplits.
  useShortcut({
    id: "split.toggle",
    keys: "mod+\\",
    label: "Keep beside / split",
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

  // The window's own history, as a browser's ⌘[ and ⌘]. A text field keeps them (some indent
  // with them), and Back never leaves the app.
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
    id: "focus.toggle",
    keys: "mod+shift+.",
    label: "Focus mode",
    group: "App",
    run: () => useLayoutStore.getState().toggleFocusMode(),
  });

  useEffect(() => {
    const moveFocus = FOCUS_KEYS.map(([direction, key]) =>
      registerShortcut({
        id: `pane.move-${direction}`,
        keys: `mod+alt+${key}`,
        label: "Move focus between panes (⌥ arrows)",
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
        // Ctrl+Shift+digit types nothing, so a focused composer shouldn't swallow it.
        allowInInputs: true,
        run: () => useLayoutStore.getState().setPreset(preset),
      }),
    );
    return () => {
      for (const unregister of [...moveFocus, ...layoutPreset]) unregister();
    };
  }, []);
}
