import type { ThreadSummary } from "@gram/contracts";

import { orchestratorRowTitle } from "@/orchestration/tree-model";
import { threadDisplayTitle } from "@/thread/thread-title";

/** One thread as the Threads page lists it. */
export interface ThreadListing {
  readonly summary: ThreadSummary;
  readonly title: string;
  /** Its workspace's name, or "Solo" for a thread in none. */
  readonly place: string;
  /** What started it, where that is known: an orchestrator, a routine. */
  readonly startedBy: string | undefined;
  /** It asks you something, or the Inbox lists it: such threads come first. */
  readonly needsYou: boolean;
}

/** The words for a thread's kind, each Gram's own when left out (an embedding app may give its own). */
export interface ThreadKindWords {
  readonly solo?: string | undefined;
  readonly orchestrator?: string | undefined;
  readonly worker?: string | undefined;
}

export interface ThreadsSources {
  readonly summaries: Iterable<ThreadSummary>;
  /** Each workspace's name, by its id. */
  readonly workspaceNames: ReadonlyMap<string, string>;
  /** Which threads need you, as the Inbox counts them. */
  readonly needsYou: (summary: ThreadSummary) => boolean;
  /** How a thread's kind is worded. */
  readonly kinds?: ThreadKindWords | undefined;
}

const titleOf = (summary: ThreadSummary): string =>
  summary.thread.role === "orchestrator"
    ? orchestratorRowTitle(summary.thread.title)
    : threadDisplayTitle(summary.thread) || "New thread";

/** What started a thread, in words, or undefined where nothing did but you. */
export const startedByOf = (
  summary: ThreadSummary,
  titles: ReadonlyMap<string, string>,
  kinds: ThreadKindWords = {},
): string | undefined => {
  const { thread } = summary;
  if (thread.role === "orchestrator") return kinds.orchestrator ?? "Orchestrator";
  const by = thread.spawnedBy;
  if (by === undefined) return undefined;
  if (by.routine !== undefined) return `Routine: ${by.routine.name}`;
  const parent = titles.get(by.threadId);
  const worker = kinds.worker ?? "Worker";
  return parent === undefined ? worker : `${worker} of ${parent}`;
};

/**
 * Where a row says its thread is: its place, then what started it. A starter that already names the
 * place ("Worker of api" in api), or an orchestrator titled as its workspace, says it once.
 */
export const whereOf = ({
  title,
  place,
  startedBy,
}: Pick<ThreadListing, "title" | "place" | "startedBy">): string =>
  startedBy === undefined
    ? place
    : startedBy.endsWith(` of ${place}`) || title === place
      ? startedBy
      : `${place} · ${startedBy}`;

/**
 * Every thread there is, archived ones aside (History has those): those that need you first, then
 * the latest active first, each with its place and what started it. `query` keeps those whose
 * title, place or starter has it, any case.
 */
export const threadListings = (sources: ThreadsSources, query = ""): ThreadListing[] => {
  const all = [...sources.summaries].filter((summary) => !summary.thread.parked);
  const titles = new Map(all.map((summary) => [summary.thread.id as string, titleOf(summary)]));
  const wanted = query.trim().toLowerCase();
  return all
    .map((summary): ThreadListing => {
      const workspaceId = summary.thread.workspaceId;
      return {
        summary,
        title: titles.get(summary.thread.id) ?? titleOf(summary),
        place:
          workspaceId === undefined
            ? (sources.kinds?.solo ?? "Solo")
            : (sources.workspaceNames.get(workspaceId) ?? "Workspace"),
        startedBy: startedByOf(summary, titles, sources.kinds),
        needsYou: sources.needsYou(summary),
      };
    })
    .filter(
      (listing) =>
        wanted === "" ||
        [listing.title, listing.place, listing.startedBy ?? ""].some((words) =>
          words.toLowerCase().includes(wanted),
        ),
    )
    .toSorted(
      (a, b) =>
        Number(b.needsYou) - Number(a.needsYou) ||
        b.summary.thread.lastActivityAt - a.summary.thread.lastActivityAt,
    );
};

/** What the Threads page narrows to: every thread, those that need you, or those at work now. */
export type ThreadsFilter = "all" | "needsYou" | "running";

export const THREADS_FILTERS: readonly { readonly value: ThreadsFilter; readonly label: string }[] =
  [
    { value: "all", label: "All" },
    { value: "needsYou", label: "Needs you" },
    { value: "running", label: "Running" },
  ];

const atWork = (listing: ThreadListing): boolean =>
  listing.summary.status === "running" || listing.summary.status === "starting";

/** Whether `filter` keeps `listing`. A thread that needs you is not also counted as at work. */
export const inThreadsFilter = (listing: ThreadListing, filter: ThreadsFilter): boolean =>
  filter === "all" ||
  (filter === "needsYou" ? listing.needsYou : !listing.needsYou && atWork(listing));

/** How many of `listings` each filter keeps, for the count beside its name. */
export const threadsFilterCounts = (
  listings: readonly ThreadListing[],
): Readonly<Record<ThreadsFilter, number>> => ({
  all: listings.length,
  needsYou: listings.filter((listing) => inThreadsFilter(listing, "needsYou")).length,
  running: listings.filter((listing) => inThreadsFilter(listing, "running")).length,
});
