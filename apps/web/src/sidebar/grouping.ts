import {
  headlineGroup,
  planHeadline,
  sidebarGroup,
  type SidebarGroup,
  type ThreadId,
  type ThreadSummary,
} from "@gram/contracts";

import { unseenAttention } from "./attention";

/** Thread sections by urgency. Flags (pinned, parked) outrank status. */
const SECTIONS = ["pinned", "needsYou", "working", "idle", "settled", "parked"] as const;
export type SidebarSection = (typeof SECTIONS)[number];

/**
 * The contract's group, moved by the plan's phase where the thread keeps a plan (a merge with work
 * left is idle, every step done is settled), and lifted to Needs you while its PR has attention the
 * user hasn't seen.
 */
const groupOf = (
  s: ThreadSummary,
  acknowledged?: Readonly<Record<string, string>> | undefined,
): SidebarGroup => {
  const status = sidebarGroup({
    status: s.status,
    completedAt: s.thread.completedAt,
    babysit: s.thread.babysit,
  });
  const headline =
    s.plan === undefined || s.plan.steps.length === 0
      ? undefined
      : planHeadline({
          thread: s.thread,
          status: s.status,
          pendingRequests: s.pendingRequests,
          git: s.git,
          plan: s.plan,
          now: Date.now(),
        });
  const group = headlineGroup(status, headline, s.thread.completedReason);
  return (group === "idle" || group === "settled") && unseenAttention(s, acknowledged) !== undefined
    ? "needsYou"
    : group;
};

/**
 * Whether a thread needs the user: its group is Needs you (a request, an error, a stopped babysit,
 * its plan's headline, or PR attention it hasn't seen), pinned or not; a parked one only for PR
 * attention unseen. The one test the sidebar surfaces by, the window title and the dock badge
 * count by, the thread's header rings by and ⌘⇧U visits by.
 */
export const needsYou = (
  s: ThreadSummary,
  acknowledged?: Readonly<Record<string, string>> | undefined,
): boolean =>
  (!s.thread.parked || unseenAttention(s, acknowledged) !== undefined) &&
  groupOf(s, acknowledged) === "needsYou";

/**
 * A worker its ledger archived whose only claim on the user is its thread's old error: nothing asks,
 * no PR attention is unseen. It needs no one, wherever a workspace's needs are counted.
 */
export const archivedErrorOnly = (s: ThreadSummary, archived: boolean): boolean =>
  archived &&
  s.status === "error" &&
  s.pendingRequests.length === 0 &&
  unseenAttention(s) === undefined;

/** Curation wins, except an archived worker's unresolved CI still needs an owner. */
export function sectionOf(s: ThreadSummary): SidebarSection {
  if (s.thread.pinned) return "pinned";
  if (s.thread.parked && unseenAttention(s) === undefined) return "parked";
  return groupOf(s);
}

const ROLLUP_ORDER: readonly SidebarGroup[] = ["needsYou", "working", "idle", "settled"];

/**
 * The most urgent status among `threads`, for a group head's roll-up glyph: needs you, then working,
 * then idle, then settled. Pinned and parked flags don't count; `undefined`
 * when there are no threads.
 */
export function rollupOf(threads: Iterable<ThreadSummary>): SidebarGroup | undefined {
  let best: number | undefined;
  for (const summary of threads) {
    const rank = ROLLUP_ORDER.indexOf(groupOf(summary));
    if (rank !== -1 && (best === undefined || rank < best)) best = rank;
  }
  return best === undefined ? undefined : ROLLUP_ORDER[best];
}

/**
 * Whether a thread's home is the Workspaces tree rather than the groups: an orchestrator, a worker
 * or a dream pass of a workspace the tree lists. A detached worker has lost its `workspaceId`, and a
 * thread of a workspace that was removed has no tree to sit in, so both stay in the groups.
 */
export const livesInTree = (
  thread: Pick<ThreadSummary["thread"], "workspaceId" | "role" | "spawnedBy">,
  workspaceIds: ReadonlySet<string>,
): boolean =>
  thread.workspaceId !== undefined &&
  workspaceIds.has(thread.workspaceId) &&
  (thread.role !== undefined || thread.spawnedBy !== undefined);

export interface SidebarSplit {
  /** Threads the groups list, in every grouping. */
  readonly listed: ThreadSummary[];
  /** Threads the Workspaces tree lists instead. */
  readonly tree: ThreadSummary[];
  /**
   * Tree threads that need the user. By status they are listed under Needs you as well, the one
   * place a thread shows twice, so attention is never folded away inside a collapsed workspace.
   */
  readonly surfaced: ThreadSummary[];
}

/**
 * Splits threads between those outside any workspace (`listed`) and the workspaces' own. With no
 * workspaces everything is `listed`.
 * `nextNeedsYou` takes every thread whatever this says, so ⌘⇧U still reaches a worker.
 */
export function splitForTree(
  summaries: Iterable<ThreadSummary>,
  workspaceIds: ReadonlySet<string>,
  archivedWorkers: ReadonlySet<string> = new Set(),
): SidebarSplit {
  const split: SidebarSplit = { listed: [], tree: [], surfaced: [] };
  for (const summary of summaries) {
    if (!livesInTree(summary.thread, workspaceIds)) {
      split.listed.push(summary);
      continue;
    }
    split.tree.push(summary);
    if (needsYou(summary) && !archivedErrorOnly(summary, archivedWorkers.has(summary.thread.id))) {
      split.surfaced.push(summary);
    }
  }
  return split;
}

/**
 * The next thread needing attention (`needsYou`) after `currentId`, in sidebar order, wrapping
 * around. Waits longest first so ⌘⇧U works through the backlog.
 */
export function nextNeedsYou(
  summaries: Iterable<ThreadSummary>,
  currentId: string | undefined,
): ThreadId | undefined {
  const needing = [...summaries]
    .filter((s) => needsYou(s))
    .toSorted((a, b) => a.thread.lastActivityAt - b.thread.lastActivityAt);
  if (needing.length === 0) return undefined;
  const index = needing.findIndex((s) => s.thread.id === currentId);
  return needing[(index + 1) % needing.length]!.thread.id;
}
