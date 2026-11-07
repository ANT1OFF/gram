import type { ThreadId, ThreadSummary } from "@gram/contracts";

import { useThreadsStore } from "@/stores/threads";

/** The sidebar's rows that open a thread, top to bottom: a workspace's line opens its orchestrator. */
const ROWS = [
  '[data-testid="overview-workspace-row"]',
  '[data-testid="overview-worker"]',
  '[data-testid="overview-solo"]',
  '[data-testid="overview-done"]',
].join(", ");

/** A row's place in the order: its thread, or for a workspace's line, `ws:` and the workspace. */
const rowKey = (row: HTMLElement): string | undefined => {
  if (row.dataset.threadId) return row.dataset.threadId;
  const workspaceId = row.closest<HTMLElement>("[data-workspace-id]")?.dataset.workspaceId;
  return workspaceId === undefined ? undefined : `ws:${workspaceId}`;
};

/** The current thread's key in the same terms: an orchestrator stands for its workspace's line. */
const currentKey = (summary: ThreadSummary | undefined): string | undefined => {
  if (summary === undefined) return undefined;
  const { thread } = summary;
  return thread.role === "orchestrator" && thread.workspaceId !== undefined
    ? `ws:${thread.workspaceId}`
    : thread.id;
};

/** Steps `delta` through `keys` from `current`, wrapping; from nowhere, the first or the last. */
export const stepIndex = (keys: readonly string[], current: string | undefined, delta: 1 | -1) => {
  if (keys.length === 0) return -1;
  const at = current === undefined ? -1 : keys.indexOf(current);
  if (at === -1) return delta === 1 ? 0 : keys.length - 1;
  return (at + delta + keys.length) % keys.length;
};

/** Visible rows, a thread listed twice (a card and its row) counted once. */
const sidebarRows = (root: ParentNode): HTMLElement[] => {
  const seen = new Set<string>();
  return [...root.querySelectorAll<HTMLElement>(ROWS)].filter((row) => {
    const key = rowKey(row);
    if (key === undefined || seen.has(key)) return false;
    if (typeof row.checkVisibility === "function" && !row.checkVisibility()) return false;
    seen.add(key);
    return true;
  });
};

/**
 * ⌘⌥] / ⌘⌥[: opens the next or previous thread in the order the sidebar lists them, as a click on
 * its row would. With the sidebar folded to its rail or hidden, the most recently active first.
 */
export function stepThread(
  delta: 1 | -1,
  currentId: ThreadId | undefined,
  open: (threadId: ThreadId) => void,
) {
  const { byId } = useThreadsStore.getState();
  const current = currentId === undefined ? undefined : byId[currentId];
  const sidebar = document.querySelector('[data-testid="overview-sidebar"]');
  const rows = sidebar ? sidebarRows(sidebar) : [];
  if (rows.length > 0) {
    const keys = rows.map((row) => rowKey(row)!);
    const next = rows[stepIndex(keys, currentKey(current), delta)];
    if (next === undefined) return;
    // A thread's row opens it; a workspace's line switches to it, as its own click does.
    if (next.dataset.threadId) open(next.dataset.threadId as ThreadId);
    else next.click();
    return;
  }
  const recent = Object.values(byId)
    .filter((summary): summary is ThreadSummary => summary !== undefined)
    .toSorted((a, b) => b.thread.lastActivityAt - a.thread.lastActivityAt)
    .map((summary) => summary.thread.id as string);
  const next = recent[stepIndex(recent, currentId, delta)];
  if (next !== undefined && next !== currentId) open(next as ThreadId);
}
