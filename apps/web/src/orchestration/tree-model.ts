import {
  FINISHED_STATES,
  mergedAndDone,
  threadPrBadges,
  type OrchestratorLedger,
  type ThreadId,
  type ThreadSummary,
  type WorkerLedgerEntry,
  type WorkerState,
  type Workspace,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";

import { unseenAttention } from "@/sidebar/attention";
import { inTurn } from "@/thread/orchestration-model";
import { archivedErrorOnly, rollupOf } from "@/sidebar/grouping";
import { threadStatusOf } from "@/sidebar/status";

import { liveWorkerEntry } from "./board-model";
import { workerWait } from "./wait-model";

// A workspace's threads as a tree, built from the threads the app already holds: an orchestrator,
// the features it spawned workers for, and the workers under each. The ledger only adds each
// feature's derived state, so the tree is live without waiting on a fetch.

export interface TreeFeature {
  readonly feature: string;
  /** In spawn order, so a row never jumps when a sibling gets busy. */
  readonly workers: readonly ThreadSummary[];
  /** The ledger's roll-up (its least advanced worker's state); absent until the ledger arrives. */
  readonly state?: WorkerState | undefined;
}

export interface WorkspaceTree {
  readonly workspace: Workspace;
  /** The thread holding the orchestrator slot, while it is open. */
  readonly orchestrator?: ThreadSummary | undefined;
  /** Every feature, in spawn order. */
  readonly features: readonly TreeFeature[];
  /** Every worker's ledger row by its thread; none until the ledger arrives. */
  readonly entries: ReadonlyMap<ThreadId, WorkerLedgerEntry>;
  /** Threads of the workspace that are neither: a dream pass. */
  readonly others: readonly ThreadSummary[];
}

const bySpawnOrder = (a: ThreadSummary, b: ThreadSummary) =>
  a.thread.createdAt - b.thread.createdAt || a.thread.id.localeCompare(b.thread.id);

/**
 * A workspace's orchestrator among `threads`: the thread holding its slot, else one of its threads
 * with the orchestrator's role (a slot not yet written back). The one rule the tree, the sidebar's
 * line and the pause read it by.
 */
export const orchestratorOf = (
  threads: Iterable<ThreadSummary | undefined>,
  workspace: Pick<WorkspaceState["workspace"], "id" | "orchestratorThreadId">,
): ThreadSummary | undefined => {
  let byRole: ThreadSummary | undefined;
  for (const s of threads) {
    if (s === undefined || s.thread.workspaceId !== workspace.id) continue;
    if (s.thread.id === workspace.orchestratorThreadId) return s;
    if (byRole === undefined && s.thread.role === "orchestrator") byRole = s;
  }
  return byRole;
};

/** One tree per workspace, in the order they were made; `threads` are the ones that live in a tree. */
export const workspaceTrees = (
  workspaces: readonly WorkspaceState[],
  threads: readonly ThreadSummary[],
  ledgers: ReadonlyMap<WorkspaceId, OrchestratorLedger> = new Map(),
): WorkspaceTree[] =>
  workspaces.map(({ workspace }) => {
    const own = threads.filter((s) => s.thread.workspaceId === workspace.id).toSorted(bySpawnOrder);
    const orchestrator = orchestratorOf(own, workspace);
    const ledger = ledgers.get(workspace.id);
    const states = new Map((ledger?.features ?? []).map((f) => [f.feature, f.state] as const));
    const features = new Map<string, ThreadSummary[]>();
    const others: ThreadSummary[] = [];
    for (const summary of own) {
      if (summary === orchestrator) continue;
      const feature =
        summary.thread.role === undefined ? summary.thread.spawnedBy?.feature : undefined;
      if (feature === undefined) others.push(summary);
      else features.set(feature, [...(features.get(feature) ?? []), summary]);
    }
    return {
      workspace,
      ...(orchestrator === undefined ? {} : { orchestrator }),
      features: [...features].map(([feature, workers]) => ({
        feature,
        workers,
        ...(states.has(feature) ? { state: states.get(feature) } : {}),
      })),
      entries: new Map(
        (ledger?.features ?? []).flatMap((f) => f.workers.map((w) => [w.threadId, w] as const)),
      ),
      others,
    };
  });

/** Nothing about these threads is running or waits on the user, so none of them needs to be seen. */
const quiet = (threads: readonly ThreadSummary[]) => {
  const rollup = rollupOf(threads);
  return rollup !== "needsYou" && rollup !== "working";
};

/**
 * Without the ledger: archived, or merged with nothing left (`mergedAndDone`). A followed PR whose
 * badge hasn't landed counts as open, so a worker across repos is never finished while one of its
 * PRs may still be in review.
 */
const workerFinished = ({ thread, git }: ThreadSummary) =>
  thread.parked || mergedAndDone(thread, threadPrBadges(thread, git));

/**
 * A feature whose work is over, so it no longer holds its workspace in review: every worker merged,
 * delivered or archived, by the ledger once it has arrived, and none of them running or asking
 * anything. A worker that only reported done stays out, since the orchestrator may still act on
 * its report.
 */
export const featureFinished = (
  feature: TreeFeature,
  entries?: ReadonlyMap<ThreadId, WorkerLedgerEntry>,
): boolean =>
  feature.workers.length > 0 &&
  feature.workers.every((summary) => {
    if (summary.pendingRequests.length > 0) return false;
    const entry = entries?.get(summary.thread.id);
    if (entry === undefined) {
      return (
        quiet([summary]) &&
        (feature.state === undefined ? workerFinished(summary) : FINISHED_STATES.has(feature.state))
      );
    }
    const live = liveWorkerEntry(entry, summary);
    return (
      FINISHED_STATES.has(live.state) && workerWait(live, live.state, live.status).bucket === "done"
    );
  });

/** Whether the workspace is parked: its orchestrator's thread is, which pauses the workspace too. */
const treeParked = (tree: WorkspaceTree): boolean => tree.orchestrator?.thread.parked === true;

/** Every thread a tree lists: the orchestrator, then the rest. */
export const treeThreads = (tree: WorkspaceTree): ThreadSummary[] => [
  ...(tree.orchestrator === undefined ? [] : [tree.orchestrator]),
  ...tree.others,
  ...tree.features.flatMap((feature) => feature.workers),
];

/**
 * Whether a thread is doing something, as its own row would show it: a turn starting or running, a
 * subagent still at work, or work left running under it. `detail` is the live status line, which
 * the snapshot's `activity` lags behind.
 */
export const threadWorking = (summary: ThreadSummary, detail?: string | undefined): boolean => {
  if (summary.status === "starting") return true;
  const shown = threadStatusOf(summary, detail);
  return shown.working || shown.running !== undefined;
};

/** How many of a tree's threads are working, the orchestrator's own included. */
export const workingCount = (
  tree: WorkspaceTree,
  details: Readonly<Record<string, string | undefined>> = {},
): number => treeThreads(tree).filter((s) => threadWorking(s, details[s.thread.id])).length;

/**
 * A workspace's workers working now, the orchestrator aside, latest first: what a pause leaves
 * running, since it stops only the orchestrator waking and dispatching.
 */
export const workingWorkerThreads = (
  byId: Readonly<Record<string, ThreadSummary | undefined>>,
  details: Readonly<Record<string, string | undefined>>,
  workspaceId: string,
): ThreadSummary[] =>
  Object.values(byId)
    .filter(
      (s): s is ThreadSummary =>
        s !== undefined && s.thread.workspaceId === workspaceId && workerWorking(s, details),
    )
    .toSorted((a, b) => b.thread.lastActivityAt - a.thread.lastActivityAt);

/**
 * A worker as `workspaceTrees` counts one, working now: no role of its own, and a feature it was
 * spawned for. A dream reading the workspace's memory isn't one.
 */
const workerWorking = (
  s: ThreadSummary,
  details: Readonly<Record<string, string | undefined>>,
): boolean =>
  s.thread.role === undefined &&
  s.thread.spawnedBy?.feature !== undefined &&
  threadWorking(s, details[s.thread.id]);

/**
 * How many of a workspace's workers are mid-turn (`inTurn`): what a pause lets finish its step, as
 * its confirm, the Board's paused line and the orchestrator's banner count, and as each paused
 * worker's row marks "stopping".
 */
export const midTurnWorkers = (
  byId: Readonly<Record<string, ThreadSummary | undefined>>,
  workspaceId: string,
): number =>
  Object.values(byId).filter(
    (s) =>
      s !== undefined &&
      s.thread.workspaceId === workspaceId &&
      s.thread.role === undefined &&
      s.thread.spawnedBy?.feature !== undefined &&
      inTurn(s.status),
  ).length;

/** The title an orchestrator is opened under, `Orchestrator · <workspace>`. */
const OPENED_TITLE = "Orchestrator · ";

/**
 * An orchestrator's title as its tree row shows it: the workspace's name, which the row's glyph
 * already says is an orchestrator's, unless the thread was renamed to something else. Renaming the
 * workspace leaves the title it was opened under, so that title is read for the name only when the
 * workspace's own isn't known, as with workspaces turned off or not yet loaded.
 */
export const orchestratorRowTitle = (
  title: string,
  workspaceName: string = title.slice(OPENED_TITLE.length),
): string => (title.startsWith(OPENED_TITLE) ? workspaceName : title);

/** Where a workspace stands when the sidebar arranges by status, most urgent first. */
const WORKSPACE_STATUSES = ["needsYou", "working", "inReview", "idle", "parked"] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

/** Whether a thread's own PR, or one it follows beside it, is still open. */
const hasOpenPr = (git: ThreadSummary["git"]): boolean =>
  git?.pr?.state === "OPEN" || (git?.extraPrs ?? []).some((pr) => pr.state === "OPEN");

const IN_REVIEW: ReadonlySet<WorkerState> = new Set<WorkerState>(["inReview", "readyToMerge"]);

/**
 * A workspace's status: parked when its orchestrator is, else needs you while anything under it
 * waits on the user (a request, an open question, a red build), working while any of its threads
 * works, in review while a feature still going has a PR open or is in review by the ledger, and idle
 * otherwise.
 */
export const workspaceStatus = (
  tree: WorkspaceTree,
  { questions = 0, working = 0 }: { readonly questions?: number; readonly working?: number } = {},
): WorkspaceStatus => {
  if (treeParked(tree)) return "parked";
  // Archived CI still needs an owner; other parked work stays set aside.
  const live = treeThreads(tree).filter(
    (s) => !s.thread.parked || unseenAttention(s) !== undefined,
  );
  const waiting = live.some((s) => s.pendingRequests.length > 0);
  const actionable = live.filter(
    (summary) =>
      !archivedErrorOnly(summary, tree.entries.get(summary.thread.id)?.state === "archived"),
  );
  if (waiting || questions > 0 || rollupOf(actionable) === "needsYou") return "needsYou";
  if (working > 0) return "working";
  // The ledger's roll-up is the least advanced worker's state, so a feature one of whose workers
  // still builds reads as working while another's PR is open: the PRs count on their own.
  const reviewing = tree.features.some(
    (feature) =>
      !featureFinished(feature, tree.entries) &&
      ((feature.state !== undefined && IN_REVIEW.has(feature.state)) ||
        feature.workers.some((worker) => hasOpenPr(worker.git))),
  );
  return reviewing ? "inReview" : "idle";
};
