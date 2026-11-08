import type { ThreadId, WorkspaceId } from "@gram/contracts";
import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";

import { useNow } from "@/lib/use-now";
import { focusWhenRendered } from "@/shell/focus-regions";
import { fitShell, useLayoutStore, type RightPanelTab } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { besideShown, useBesideStore } from "./beside-store";
import { boardWorkspaceFor } from "./board-model";
import { useOrchestratorLedgers, useWorkspaces } from "./use-orchestration";
import { tabCount, workersByTab } from "./workers-model";

// The one way to every worker of a workspace: the right panel's Workers tab. ⌘J, the palette's
// Workers, the title bar's "…" and the status strip's "running" all open it here, so there is one
// worker list, not a dialog beside the panel.

/** Where the panel was before ⌘J showed Workers, so the same keys put it back. */
let beforeWorkers: { open: boolean; tab: RightPanelTab; beside: boolean } | undefined;

/** The Workers tab's current row, else its first: where ⌘J puts the keys. */
const workersRow = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="workers-panel-row"][aria-current="page"]') ??
  document.querySelector<HTMLElement>('[data-testid="workers-panel-row"]');

/** The keys on a row once the tab has drawn its rows (its ledger may still load), else its tab. */
async function focusWorkers(): Promise<void> {
  if (await focusWhenRendered(workersRow, 60)) return;
  await focusWhenRendered(() =>
    document.querySelector<HTMLElement>(
      '[data-testid="right-panel"] [role="tab"][aria-selected="true"]',
    ),
  );
}

/** Shows the right panel on its Workers tab, however it fits, with the keys on its rows. */
export function showWorkersTab(): void {
  const layout = useLayoutStore.getState();
  const beside = useBesideStore.getState();
  const open = fitShell(layout).panel !== "none";
  const besideOn = besideShown(beside) !== undefined;
  if (!(open && layout.panelTab === "workers" && !besideOn)) {
    beforeWorkers = { open, tab: layout.panelTab, beside: besideOn };
  }
  beside.setShown(false);
  layout.revealPanel("workers");
  void focusWorkers();
}

/**
 * ⌘J: shows the Workers tab; on it already, puts the panel back as it was before (its tab, the
 * worker beside the chat, or hidden).
 */
export function toggleWorkersTab(): void {
  const layout = useLayoutStore.getState();
  const beside = useBesideStore.getState();
  const onWorkers =
    fitShell(layout).panel !== "none" &&
    layout.panelTab === "workers" &&
    besideShown(beside) === undefined;
  if (!onWorkers) return showWorkersTab();
  const back = beforeWorkers;
  beforeWorkers = undefined;
  if (back === undefined || !back.open) return layout.togglePanel();
  if (back.beside) return beside.setShown(true);
  layout.setPanelTab(back.tab);
}

/** The workspace the Workers tab is about: the route's, else the open thread's. */
function useListWorkspace(): WorkspaceId | undefined {
  const workspaces = useWorkspaces();
  const threadId = useParams({ strict: false }).threadId as ThreadId | undefined;
  const routeWorkspace = useParams({ strict: false }).workspaceId as WorkspaceId | undefined;
  const thread = useThreadsStore((s) =>
    threadId === undefined ? undefined : s.byId[threadId]?.thread,
  );
  if (routeWorkspace !== undefined && workspaces.some((w) => w.workspace.id === routeWorkspace))
    return routeWorkspace;
  return boardWorkspaceFor(thread, workspaces);
}

/**
 * The workspace ⌘J shows, and how many of its workers are on now: what the title bar's "…" says
 * beside Workers, its way into the tab.
 */
export function useWorkersNow(): { workspaceId: WorkspaceId | undefined; count: number } {
  const workspaceId = useListWorkspace();
  const workspaces = useWorkspaces();
  const ids = useMemo(() => workspaces.map((state) => state.workspace.id), [workspaces]);
  const ledgers = useOrchestratorLedgers(ids);
  const ledger = workspaceId === undefined ? undefined : ledgers.get(workspaceId);
  const now = useNow(true, undefined, 60_000);
  // Only the count: the threads' every change leaves it alone, and so leaves the title bar still.
  const count = useThreadsStore((s) =>
    tabCount(
      workersByTab(ledger, { byId: s.byId, statusDetail: s.statusDetail, now }, undefined).now,
    ),
  );
  return { workspaceId, count };
}
