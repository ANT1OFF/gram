import type {
  AgentKind,
  AgentSessionSummary,
  FinishedWorker,
  OrchestratorLedger,
  Project,
  ThreadId,
  ThreadSummary,
  WorkspaceId,
} from "@gram/contracts";

import { dateTimeFormat } from "@/lib/intl";
import {
  latestDoneFirst,
  SOLO_OWNER,
  type DoneEntry,
  type DoneOwner,
} from "@/orchestration/done-model";
import {
  clockTime,
  DONE_DAYS,
  daysBefore,
  searchRows,
  startOfDay,
  workersByTab,
  type WorkerLiveFacts,
  type WorkerRow,
} from "@/orchestration/workers-model";
import type { DoneGrouping } from "@/stores/layout";
import { threadDisplayTitle } from "@/thread/thread-title";
import { soloDone } from "@/views/solo-threads";

// History: every past chat in one list. Finished workers (live ledgers and those closed with their
// worktree), orchestrators and one-off threads marked done or archived, and the agents' own past
// sessions Gram never ran, which open by resuming. Pure, so the list filters, groups and pages the
// way Done did and is tested without a browser.

/** What a row is: a workspace's worker, an orchestrator, a one-off thread or a CLI session. */
export type HistoryKind = "worker" | "orchestrator" | "thread" | "imported";

/** How a past chat ended. An imported session has none: Gram never saw it end. */
export type HistoryOutcome = "merged" | "delivered" | "stopped" | "failed" | "archived";

/** The chips over the list, in their order. */
export type HistoryFilter = "all" | "workers" | "threads" | "archived" | "imported";

export const HISTORY_FILTERS: readonly { readonly id: HistoryFilter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "workers", label: "Workers" },
  { id: "threads", label: "Threads" },
  { id: "archived", label: "Archived" },
  { id: "imported", label: "Imported" },
];

/** Each outcome's word, as the row says it. */
export const OUTCOME_LABEL: Readonly<Record<HistoryOutcome, string>> = {
  merged: "merged",
  delivered: "delivered",
  stopped: "stopped",
  failed: "failed",
  archived: "archived",
};

/** Where an imported session's group goes by orchestrator: apart from Gram's own chats. */
export const IMPORTED_OWNER: DoneOwner = { key: "imported", label: "Imported sessions" };

/** A past session an agent keeps for a folder, with the folder and the agent. */
export interface HistorySession extends AgentSessionSummary {
  readonly agent: AgentKind;
  readonly projectRoot: string;
}

/** One row of History. */
export interface HistoryEntry extends DoneEntry {
  /** Unique across kinds: the thread's id, or `session:<agent>:<id>` for an imported session. */
  readonly threadId: string;
  readonly kind: HistoryKind;
  readonly title: string;
  /** The workspace it ran in, or `Solo threads`, or `Imported sessions`. */
  readonly place: string;
  /** The repo or folder it worked in, by its short name; empty when nothing says. */
  readonly repo: string;
  readonly outcome: HistoryOutcome | undefined;
  /** The agent that ran it, where it is known. */
  readonly agent: AgentKind | undefined;
  /** Archived by the user (parked) or by its orchestrator. */
  readonly archived: boolean;
  /** Closed with its worktree: it opens read-only. */
  readonly cleanedUp?: true | undefined;
  /** For an imported session: what resuming it needs. */
  readonly session?: HistorySession | undefined;
}

/** One workspace's facts for History, as Done read them. */
export interface HistoryWorkspace {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly ledger: Pick<OrchestratorLedger, "features"> | undefined;
  readonly finished: readonly FinishedWorker[] | undefined;
}

export interface HistorySources {
  readonly workspaces: readonly HistoryWorkspace[];
  /** Every thread summary the client holds. */
  readonly summaries: readonly ThreadSummary[];
  readonly projects: readonly Pick<Project, "id" | "name" | "root">[];
  /** Past sessions no Gram thread shows, from every listed folder. */
  readonly sessions: readonly HistorySession[];
  readonly facts: WorkerLiveFacts;
}

const lastSegment = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/**
 * How a finished worker's row ended. Archived only when that is all it came to: an orchestrator
 * archives its merged workers as a matter of course, and those still read merged.
 */
const workerOutcome = (
  row: WorkerRow,
  summary: ThreadSummary | undefined,
  finished: FinishedWorker | undefined,
): HistoryOutcome => {
  if (row.glyph === "merged") return "merged";
  if (row.cleanedUp === true) {
    const delivered =
      finished?.completedReason !== undefined || finished?.lastReport?.state === "done";
    return delivered ? "delivered" : "stopped";
  }
  if (row.glyph === "archived" || summary?.thread.parked === true) return "archived";
  return "delivered";
};

/** A workspace's finished workers, as ⌘J's Done listed them (`workersByTab`). */
const workerEntries = (source: HistoryWorkspace, facts: WorkerLiveFacts): HistoryEntry[] => {
  const tabs = workersByTab(source.ledger, facts, source.finished ?? []);
  const finished = new Map(source.finished?.map((worker) => [worker.threadId, worker] as const));
  const owner: DoneOwner = { key: source.workspaceId, label: source.name };
  return tabs.done.flatMap((feature) =>
    feature.rows.map((row): HistoryEntry => {
      const summary = facts.byId[row.threadId];
      const closed = row.cleanedUp === true ? finished.get(row.threadId) : undefined;
      const outcome = workerOutcome(row, summary, closed);
      return {
        threadId: row.threadId,
        kind: "worker",
        title: row.title,
        place: source.name,
        repo: row.repo,
        outcome,
        agent: summary?.thread.model.agent ?? closed?.agent,
        archived: outcome === "archived",
        finishedAt: row.finishedAt,
        owner,
        workspaceId: source.workspaceId,
        ...(row.cleanedUp === true ? { cleanedUp: true as const } : {}),
      };
    }),
  );
};

/**
 * How a thread outside the ledgers ended: merged, marked done, or stopped on an error; one archived
 * with none of those is just archived. Archived or not, the Archived chip goes by its flag.
 */
const threadOutcome = (summary: ThreadSummary): HistoryOutcome => {
  const { thread } = summary;
  if (thread.completedReason === "prMerged") return "merged";
  if (thread.completedAt !== undefined) return "delivered";
  if (summary.status === "error" || thread.lastError !== undefined) return "failed";
  return thread.parked ? "archived" : "stopped";
};

/**
 * The threads no ledger row covers that are over: archived (parked) or marked done, workers among
 * them, orchestrators and one-off threads. Dreams are memory upkeep, not chats, and stay out.
 */
const threadEntries = (
  sources: HistorySources,
  covered: ReadonlySet<string>,
  names: ReadonlyMap<string, string>,
): HistoryEntry[] => {
  const projects = new Map(sources.projects.map((project) => [project.id, project.name] as const));
  return sources.summaries.flatMap((summary): HistoryEntry[] => {
    const { thread } = summary;
    if (covered.has(thread.id) || thread.role === "dream") return [];
    if (!thread.parked && !soloDone(summary)) return [];
    const kind: HistoryKind =
      thread.role === "orchestrator"
        ? "orchestrator"
        : thread.spawnedBy !== undefined && thread.workspaceId !== undefined
          ? "worker"
          : "thread";
    const workspace = thread.workspaceId === undefined ? undefined : names.get(thread.workspaceId);
    const owner: DoneOwner =
      kind !== "thread" && workspace !== undefined && thread.workspaceId !== undefined
        ? { key: thread.workspaceId, label: workspace }
        : SOLO_OWNER;
    const at = thread.parked
      ? (thread.parkedAt ?? thread.lastActivityAt)
      : (thread.completedAt ?? thread.lastActivityAt);
    return [
      {
        threadId: thread.id,
        kind,
        title: threadDisplayTitle(thread),
        place: owner.label,
        repo:
          projects.get(thread.projectId) ??
          lastSegment(thread.checkout.repoRoot ?? thread.checkout.path),
        outcome: threadOutcome(summary),
        agent: thread.model.agent,
        archived: thread.parked,
        finishedAt: at,
        owner,
      },
    ];
  });
};

/** A past CLI session as a row: resumable, by its folder's name. */
const sessionEntry = (
  session: HistorySession,
  projects: ReadonlyMap<string, string>,
): HistoryEntry => ({
  threadId: `session:${session.agent}:${session.agentSessionId}`,
  kind: "imported",
  title: session.title,
  place: IMPORTED_OWNER.label,
  repo: projects.get(session.projectRoot) ?? lastSegment(session.projectRoot),
  outcome: undefined,
  agent: session.agent,
  archived: false,
  finishedAt: session.updatedAt,
  owner: IMPORTED_OWNER,
  session,
});

/**
 * Every past chat, latest first: each workspace's finished workers, the archived and done threads
 * outside the ledgers, and the past sessions no Gram thread shows.
 */
export const historyEntries = (sources: HistorySources): HistoryEntry[] => {
  const names = new Map(sources.workspaces.map((w) => [w.workspaceId as string, w.name] as const));
  const workers = sources.workspaces.flatMap((source) => workerEntries(source, sources.facts));
  // A ledger's worker is its row's to list, finished or not: a live one is not history yet.
  const covered = new Set<string>([
    ...workers.map((entry) => entry.threadId),
    ...sources.workspaces.flatMap(
      (source) => source.ledger?.features.flatMap((f) => f.workers.map((w) => w.threadId)) ?? [],
    ),
  ]);
  const byRoot = new Map(sources.projects.map((project) => [project.root, project.name] as const));
  return [
    ...workers,
    ...threadEntries(sources, covered, names),
    ...sources.sessions
      .filter((session) => session.threadId === undefined)
      .map((session) => sessionEntry(session, byRoot)),
  ].toSorted(latestDoneFirst);
};

/** Whether `entry` is under `filter`'s chip. */
export const inFilter = (entry: HistoryEntry, filter: HistoryFilter): boolean => {
  switch (filter) {
    case "all":
      return true;
    case "workers":
      return entry.kind === "worker";
    case "threads":
      return entry.kind === "thread" || entry.kind === "orchestrator";
    case "archived":
      return entry.archived;
    case "imported":
      return entry.kind === "imported";
  }
};

/** How many rows each chip has, before the search. */
export const filterCounts = (
  entries: readonly HistoryEntry[],
): Readonly<Record<HistoryFilter, number>> => {
  const counts: Record<HistoryFilter, number> = {
    all: 0,
    workers: 0,
    threads: 0,
    archived: 0,
    imported: 0,
  };
  for (const entry of entries) {
    for (const { id } of HISTORY_FILTERS) if (inFilter(entry, id)) counts[id] += 1;
  }
  return counts;
};

/** The rows under `filter` whose title, repo or place has every word of `query`. */
export const searchHistory = (
  entries: readonly HistoryEntry[],
  filter: HistoryFilter,
  query: string,
): HistoryEntry[] =>
  searchRows(
    entries
      .filter((entry) => inFilter(entry, filter))
      .map((entry) => ({ entry, title: entry.title, feature: entry.place, repo: entry.repo })),
    query,
  ).map(({ entry }) => entry);

/**
 * A row's time, 24-hour, where its heading says the rest: on its clock alone under a day heading
 * (by date, the last `DONE_DAYS` days) and for today by orchestrator, else its date and clock
 * (`30 Oct 14:12`), with the year when it isn't this year's.
 */
export const historyWhen = (at: number | undefined, by: DoneGrouping, now: number): string => {
  if (at === undefined) return "";
  const recent = by === "date" ? at >= daysBefore(now, DONE_DAYS - 1) : at >= startOfDay(now);
  if (recent) return clockTime(at);
  const year = new Date(at).getFullYear() !== new Date(now).getFullYear();
  const date = dateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    ...(year ? { year: "numeric" } : {}),
  }).format(new Date(at));
  return `${date} ${clockTime(at)}`;
};

/** The project roots whose past sessions History lists: most recently used first, at most `max`. */
export const sessionRoots = (
  projects: readonly Pick<Project, "id" | "root">[],
  summaries: readonly ThreadSummary[],
  max: number,
): string[] => {
  const latest = new Map<string, number>();
  for (const { thread } of summaries) {
    const at = latest.get(thread.projectId) ?? 0;
    if (thread.lastActivityAt > at) latest.set(thread.projectId, thread.lastActivityAt);
  }
  return projects
    .toSorted((a, b) => (latest.get(b.id) ?? 0) - (latest.get(a.id) ?? 0))
    .slice(0, max)
    .map((project) => project.root);
};

/** The thread a row opens, when it is one of Gram's own. */
export const historyThreadId = (entry: HistoryEntry): ThreadId | undefined =>
  entry.kind === "imported" ? undefined : (entry.threadId as ThreadId);

/** How many finished chats the sidebar's Done lists before Open History takes over. */
export const RECENT_DONE = 5;

/** A finished chat as the sidebar's Done has it: one muted line. */
export interface RecentDone {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly outcome: HistoryOutcome | undefined;
  readonly place: string;
  readonly finishedAt: number | undefined;
}

/**
 * The `max` most recently finished Gram chats, latest first: History's rows without the CLI
 * sessions, which only History reads, and none a click couldn't open.
 */
export const recentDone = (
  sources: Omit<HistorySources, "sessions">,
  max: number = RECENT_DONE,
): RecentDone[] =>
  historyEntries({ ...sources, sessions: [] })
    .flatMap((entry): RecentDone[] => {
      const threadId = historyThreadId(entry);
      return threadId === undefined
        ? []
        : [
            {
              threadId,
              title: entry.title,
              outcome: entry.outcome,
              place: entry.place,
              finishedAt: entry.finishedAt,
            },
          ];
    })
    .slice(0, max);

/** A Done row's time: its 24-hour clock today, else its day (`3 Nov`), with the year if not this one's. */
export const recentWhen = (at: number | undefined, now: number): string => {
  if (at === undefined) return "";
  if (at >= startOfDay(now)) return clockTime(at);
  const year = new Date(at).getFullYear() !== new Date(now).getFullYear();
  return dateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    ...(year ? { year: "numeric" } : {}),
  }).format(new Date(at));
};
