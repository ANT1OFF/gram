import { EMPTY_TRAY_MENU, type ThreadId, type TrayAction, type WorkspaceId } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { checkAwayAction } from "@/orchestration/ask-actions";
import { holdAnswer } from "@/orchestration/ask-answer";
import { useOpenThread, useWorkspaceAsks } from "@/orchestration/ask-stack";
import { useAskStackStore } from "@/orchestration/ask-stack-store";
import { allWorkspacesPaused, setAllWorkspacesPaused } from "@/orchestration/pause-workspace";
import { useWorkspaces } from "@/orchestration/use-orchestration";
import { useThreadsStore } from "@/stores/threads";
import { useQuietStrip } from "@/views/quiet-view";
import { useViewStore } from "@/views/view-store";

import { shownIn, trayMenuOf, type BuiltTrayMenu } from "./menu-bar-model";

// The menu bar's (tray's) asks and workspaces. The window
// sends its menu to the shell whenever the asks change; what the user picks comes back here and is
// answered through the stack's own path, and only the very ask that was shown.

const toast = (title: string, body: string) =>
  useThreadsStore.getState().applyEvent({ type: "notify", kind: "info", title, body });

/** Whether the shell keeps the tray (on macOS, the menu bar item), following changes. */
function useTrayOn(): boolean {
  const keep = window.gram?.keepInTray;
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (keep === undefined) return;
    let live = true;
    let changed = false;
    const unsubscribe = keep.onChange((value) => {
      changed = true;
      setOn(value);
    });
    void keep.get().then((value) => {
      if (live && !changed) setOn(value);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [keep]);
  return on;
}

/** Sends the menu and answers its picks; only while the tray is on, so off it costs nothing. */
function MenuBarAsks() {
  const all = useWorkspaceAsks();
  const strip = useQuietStrip(all);
  const api = useApi();
  const queryClient = useQueryClient();
  const openThread = useOpenThread();
  /**
   * The last two menus sent, newest last: a pick from a menu opened just before an update still
   * finds what it showed, and only that (`shownIn`, `trayAskToken`).
   */
  const sent = useRef<BuiltTrayMenu[]>([]);

  const states = useWorkspaces();
  const built = trayMenuOf(
    all,
    strip,
    states.length === 0 ? undefined : allWorkspacesPaused(states),
  );
  const text = useRef("");
  useEffect(() => {
    // A new object with the same menu sends nothing.
    const next = JSON.stringify(built.menu);
    if (next === text.current) return;
    text.current = next;
    sent.current = [...sent.current.slice(-1), built];
    window.gram?.tray?.show(built.menu);
  });
  // Off, or this window gone: nothing of it is left in the menu.
  useEffect(() => () => window.gram?.tray?.show(EMPTY_TRAY_MENU), []);

  const openWorkspace = async (workspaceId: WorkspaceId, orchestrator: ThreadId | undefined) => {
    useViewStore.getState().setQuiet(false);
    openThread(orchestrator ?? (await api.openOrchestrator({ workspaceId })).id);
  };

  const onAction = useEffectEvent((action: TrayAction) => {
    if (action.kind === "asks") {
      // The rest, one at a time.
      useViewStore.getState().setQuiet(true);
      return;
    }
    if (action.kind === "pauseAll") {
      // Quiet's own Pause all, doing what the item said.
      void setAllWorkspacesPaused(api, queryClient, states, action.paused);
      return;
    }
    if (action.kind === "workspace") {
      const workspace = shownIn(sent.current, "workspaces", action.id);
      if (workspace !== undefined) {
        void openWorkspace(workspace.workspaceId, workspace.orchestratorThreadId);
      }
      return;
    }
    const shown = shownIn(sent.current, "asks", action.id);
    if (shown === undefined) {
      if (action.kind === "answer") {
        toast("Nothing sent", "That ask changed or was answered. Open Gram to see it.");
      }
      return;
    }
    if (action.kind === "open") {
      if (shown.openThreadId === undefined) return;
      // The stack shows that ask on top, as a notification's Open does.
      useAskStackStore.getState().focus(shown.askKey);
      useViewStore.getState().setQuiet(false);
      return openThread(shown.openThreadId);
    }
    const allow = checkAwayAction(all, shown);
    // Only the very ask that was shown, still waiting: anything else sends nothing.
    if (allow === undefined) {
      toast("Nothing sent", "That ask changed or was answered. Open Gram to see it.");
      return;
    }
    holdAnswer(api, allow.ask, allow.done, allow.action, (workspaceId) => {
      void queryClient.invalidateQueries({ queryKey: ["memory", workspaceId] });
    });
  });
  useEffect(() => window.gram?.tray?.onAction((action) => onAction(action)), []);

  return null;
}

/** The menu bar's asks, mounted in the desktop shell once; nothing in a browser or with it off. */
export function MenuBar() {
  const on = useTrayOn();
  return on && window.gram?.tray !== undefined ? <MenuBarAsks /> : null;
}
