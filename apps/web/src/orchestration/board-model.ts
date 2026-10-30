import {
  DEFAULT_PR_WAKE_EVENTS,
  featureState,
  liveWorkerState,
  prWakeWhen,
  type FeatureGroupLedgerEntry,
  type FeatureLedgerEntry,
  type FeatureStage,
  type PendingWake,
  type Thread,
  type ThreadStatus,
  type ThreadSummary,
  type UsageSummary,
  type WorkerLedgerEntry,
  type WorkerState,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";

import { contextPercent } from "@/thread/context-usage";

// Pure derivations for the orchestration board: which column a worker stands in, what a feature's
// row holds, and which workspace's board a thread opens. No React, so it is tested without a browser.

/** Shared by the production board callbacks and card presentation. */
export const liveWorkerEntry = (
  worker: WorkerLedgerEntry,
  summary: Pick<ThreadSummary, "status" | "pendingRequests"> | undefined,
): WorkerLedgerEntry => ({
  ...worker,
  state: liveWorkerState(
    worker,
    summary === undefined
      ? undefined
      : { status: summary.status, pendingRequestCount: summary.pendingRequests.length },
  ),
  status: summary?.status ?? worker.status,
  pendingRequests:
    summary === undefined
      ? worker.pendingRequests
      : summary.pendingRequests.map((request) => {
          const recorded = worker.pendingRequests.find(
            (pending) => pending.requestId === request.id,
          );
          return {
            ...recorded,
            requestId: request.id,
            kind: request.kind,
            ageMin: recorded?.ageMin ?? 0,
          };
        }),
});

/** A worker's title: its thread's live one, else the ledger's, for every list that names one. */
export const workerTitle = (
  worker: Pick<WorkerLedgerEntry, "title">,
  summary: { readonly thread: Pick<Thread, "title"> } | undefined,
): string => summary?.thread.title ?? worker.title;

/**
 * A group's state from its members' by the ledger's own rule (`featureState`): parked work doesn't
 * count while anything is live, and a state this build doesn't know comes first. `undefined` for
 * no members at all.
 */
export const leastAdvanced = (states: readonly WorkerState[]): WorkerState | undefined =>
  states.length === 0 ? undefined : featureState(states);

/** What `sectionsOf` needs of a feature, which both a board row and a ledger entry are. */
interface Groupable {
  readonly feature: string;
  readonly group?: string | undefined;
  readonly state: WorkerState;
}

/** Several features run as one effort: the band over their rows, with the stage of the whole. */
interface FeatureSection<T> {
  readonly group: string;
  readonly state: WorkerState;
  readonly stage: FeatureStage | undefined;
  readonly rows: readonly T[];
}

export interface FeatureSections<T> {
  /** In the ledger's order, each with its features in the order they joined. */
  readonly groups: readonly FeatureSection<T>[];
  /** Features in no group, after the groups, exactly as they show with no groups at all. */
  readonly ungrouped: readonly T[];
}

/**
 * Features dealt into their groups, for the board's bands and the digest's ledger. The ledger's
 * `groups` give the order, the stage and the state; a feature naming a group the ledger doesn't list
 * still gets a band, so nothing is dropped while the two disagree for a moment. A listed group none
 * of whose features has a worker yet has no rows and so no band.
 */
export const sectionsOf = <T extends Groupable>(
  rows: readonly T[],
  groups: readonly FeatureGroupLedgerEntry[] = [],
): FeatureSections<T> => {
  const listed = new Map(groups.map((entry) => [entry.group, entry] as const));
  const names = [
    ...listed.keys(),
    ...rows.flatMap((row) => (row.group === undefined || listed.has(row.group) ? [] : [row.group])),
  ];
  return {
    groups: [...new Set(names)].flatMap((group) => {
      const entry = listed.get(group);
      const order = entry?.features ?? [];
      const rank = (row: T) => {
        const index = order.indexOf(row.feature);
        return index < 0 ? order.length : index;
      };
      const members = rows
        .filter((row) => row.group === group)
        .toSorted((a, b) => rank(a) - rank(b));
      const state = entry?.state ?? leastAdvanced(members.map((row) => row.state));
      return state === undefined || members.length === 0
        ? []
        : [{ group, state, stage: entry?.stage, rows: members }];
    }),
    ungrouped: rows.filter((row) => row.group === undefined),
  };
};

const baseName = (path: string): string =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() ?? path;

/**
 * The repos a worker across repos works in, its own first; `undefined`
 * for a worker in one. The ledger names them; until it arrives the thread's extra worktrees do, by
 * their repo's folder.
 */
export const workerRepoNames = (
  thread: Pick<Thread, "checkout" | "extraCheckouts">,
  entry: Pick<WorkerLedgerEntry, "project" | "alsoIn"> | undefined,
): { readonly primary: string; readonly others: readonly string[] } | undefined => {
  if (entry?.alsoIn !== undefined && entry.alsoIn.length > 0) {
    return { primary: entry.project, others: entry.alsoIn.map((repo) => repo.project) };
  }
  const extras = thread.extraCheckouts ?? [];
  if (extras.length === 0) return undefined;
  return {
    primary: entry?.project ?? baseName(thread.checkout.repoRoot ?? thread.checkout.path),
    others: extras.map((checkout) => baseName(checkout.repoRoot ?? checkout.path)),
  };
};

export const workerCount = (features: readonly FeatureLedgerEntry[]): number =>
  features.reduce((sum, feature) => sum + feature.workers.length, 0);

export const reportLine = (summary: string, max = 140): string => {
  const line = summary.replaceAll(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};

/**
 * When a wake fires, in a hint's words: "Wakes at 14:30", or for one on another PR "Wakes when
 * #645 merges or gets a new push, else at Fri 14:30".
 */
export const wakeWhenText = (
  wake: Pick<PendingWake, "at" | "onPr" | "on">,
  time: (at: number) => string,
): string =>
  wake.onPr === undefined
    ? `Wakes at ${time(wake.at)}`
    : `Wakes when ${prWakeWhen(wake.onPr, wake.on ?? DEFAULT_PR_WAKE_EVENTS)}, else at ${time(wake.at)}`;

/**
 * From this much of its context window on, an orchestrator is offered a fresh session:
 * the usage bar's warning, and the server's context note.
 */
const FRESH_SESSION_CONTEXT_PCT = 90;

/**
 * The orchestrator's context fill (`contextPercent`, the usage bar's own) when it is worth a fresh
 * session, else `undefined`, read from the usage the thread already reports.
 */
export const freshSessionPct = (
  usage: Pick<UsageSummary, "contextTokens" | "contextWindow"> | undefined,
): number | undefined => {
  const pct = usage === undefined ? undefined : contextPercent(usage);
  return pct !== undefined && pct >= FRESH_SESSION_CONTEXT_PCT ? pct : undefined;
};

/** What a handoff in flight is known by: the session it is leaving, and when it was asked for. */
export interface HandoffMark {
  readonly fromSession: string | undefined;
  readonly startedAt: number;
}

/** A handoff that hasn't shown its new session after this long is no longer claimed to be running. */
export const HANDOFF_GIVE_UP_MS = 10 * 60_000;

/**
 * Whether the orchestrator is still between sessions: it is until its thread carries another
 * `agentSessionId` than the one it had when the handoff was asked for.
 */
export const handoffRunning = (
  mark: HandoffMark | undefined,
  thread: Pick<Thread, "agentSessionId"> | undefined,
  now: number,
): boolean =>
  mark !== undefined &&
  thread !== undefined &&
  thread.agentSessionId === mark.fromSession &&
  now - mark.startedAt < HANDOFF_GIVE_UP_MS;

/**
 * What Tidy up asks of the orchestrator: a message like one the user could have typed, queued
 * behind whatever it is doing. The role prompt's housekeeping section says what each part means.
 */
export const TIDY_UP_MESSAGE =
  "Please tidy up this workspace now: archive the workers whose work is merged or delivered and " +
  "that wait on nothing, put features in the right groups, bring stages and plans in line with " +
  "the ledger, close questions that were settled elsewhere, and bring your memory up to date " +
  "(the pending work, decisions, anything stale). Then tell me in a few lines what you changed.";

/**
 * Why Tidy up can't be sent, or `undefined` when it can: it is a message to the orchestrator, so
 * there has to be one whose thread can still take it.
 */
export const tidyUpBlocked = (
  orchestrator: { readonly status: ThreadStatus } | undefined,
): string | undefined => {
  if (orchestrator === undefined) return "No orchestrator yet: open it first";
  if (orchestrator.status === "ended") return "The orchestrator thread has ended";
  return undefined;
};

/**
 * The workspace whose board a thread opens: its own when it is an orchestrator, a worker or a dream
 * pass of a listed workspace, else the first workspace. `undefined` while there is none.
 */
export const boardWorkspaceFor = (
  thread: Pick<Thread, "workspaceId"> | undefined,
  workspaces: readonly WorkspaceState[],
): WorkspaceId | undefined => {
  const own = workspaces.find((state) => state.workspace.id === thread?.workspaceId);
  return (own ?? workspaces[0])?.workspace.id;
};
