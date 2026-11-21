import type { ThreadId, WorkspaceId } from "@gram/contracts";
import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";

import { useNow } from "@/lib/use-now";
import { focusWhenRendered } from "@/shell/focus-regions";
import { fitShell, useLayoutStore, type RightPanelTab } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import {
  backToWorkers,
  besideShown,
  narrowFromWorkers,
  useBesideStore,
  widenForWorkers,
} from "./beside-store";
import { boardWorkspaceFor } from "./board-model";
import { useOrchestratorLedgers, useWorkspaces } from "./use-orchestration";
import { tabCount, workersByTab } from "./workers-model";

let beforeWorkers: { open: boolean; tab: RightPanelTab; beside: boolean } | undefined;

const workersRow = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="workers-panel-row"][aria-current]') ??
  document.querySelector<HTMLElement>('[data-testid="workers-panel-row"]');

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
  widenForWorkers();
  void focusWorkers();
}

/**
 * The sidebar's "N in Workers": the pane's list, with the keys on its current row. From a worker
 * open there, that is Back: the list as it was, the worker's row current and holding the keys.
 */
export function focusWorkersPane(): void {
  const layout = useLayoutStore.getState();
  if (fitShell(layout).panel !== "none" && besideShown(useBesideStore.getState()) !== undefined) {
    backToWorkers();
    return;
  }
  showWorkersTab();
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
  if (back === undefined || !back.open) {
    narrowFromWorkers();
    return layout.togglePanel();
  }
  if (back.beside) return beside.setShown(true);
  narrowFromWorkers();
  layout.setPanelTab(back.tab);
}

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
  const count = useThreadsStore((s) =>
    tabCount(
      workersByTab(ledger, { byId: s.byId, statusDetail: s.statusDetail, now }, undefined).now,
    ),
  );
  return { workspaceId, count };
}
