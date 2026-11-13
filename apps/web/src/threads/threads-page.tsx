import type { ThreadSummary } from "@gram/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MessagesSquare, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { formatRelative, formatStamp } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { useEmbedPageTitle } from "@/embed/slots";
import { useEmbedShell, useThreadsTitle } from "@/embed/store";
import { usePhone } from "@/lib/use-phone";
import { newEntryOf } from "@/orchestration/new-entry-menu";
import { newEntryRoute } from "@/orchestration/new-entry";
import { threadNeed } from "@/orchestration/needs-you-items";
import { useDerivedAsks } from "@/orchestration/needs-you-store";
import { soloDisplay } from "@/orchestration/overview-model";
import { useTaskDraftStore } from "@/orchestration/task-draft-store";
import { useWorkspaces } from "@/orchestration/use-orchestration";
import { useOpenThread } from "@/shell/thread-switcher";
import { threadStatusOf } from "@/sidebar/status";
import { useThreadsStore } from "@/stores/threads";

import {
  inThreadsFilter,
  whereOf,
  THREADS_FILTERS,
  threadListings,
  threadsFilterCounts,
  type ThreadListing,
  type ThreadsFilter,
} from "./threads-model";
import { WorkspacesList } from "./workspaces-view";

/**
 * Which list the page shows where an embedding app turned the workspaces' list on: kept while the
 * window lives, so coming back from a thread finds the list that led to it.
 */
const useThreadsView = create<{ view: "workspaces" | "threads" }>()(() => ({
  view: "workspaces",
}));

/** Rows drawn at most: a search finds the rest. */
const SHOWN = 300;

/**
 * Every thread, as one page in the conversation's place: those that need you first, then the latest
 * active, each with its state as the sidebar says it, its place, what started it and when it last
 * did anything. Search narrows it; New task starts one. The way to a thread for a sidebar that
 * leaves the thread list out, and a list of all of them for anyone.
 */
export function ThreadsPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ThreadsFilter>("all");
  const summaries = useThreadsStore(useShallow((s) => Object.values(s.byId)));
  const workspaces = useWorkspaces();
  const groups = useDerivedAsks((s) => s.needsYou.groups);
  const entry = newEntryOf(useTaskDraftStore((s) => s.entry));
  // An app in front of Gram may give the page and its button words of its own.
  const title = useThreadsTitle();
  const newLabel = useEmbedShell((s) => s.threadsPage.newLabel);
  const kinds = useEmbedShell((s) => s.threadsPage.kinds);
  const elsewhere = useEmbedShell((s) => s.threadsPage.elsewhere);
  const places = useEmbedShell((s) => s.threadsPage.places);
  // The same app may have the page open on its workspaces, with the threads one click away.
  const workspaceWords = useEmbedShell((s) => s.threadsPage.workspaces);
  const view = useThreadsView((s) => s.view);
  const onWorkspaces = workspaceWords !== undefined && view === "workspaces";
  const listings = useMemo(() => {
    const workspaceNames = new Map(
      workspaces.map((state) => [state.workspace.id as string, state.workspace.name]),
    );
    const needing = new Set(
      groups.flatMap((group) => group.items.map((item) => item.threadId as string)),
    );
    return threadListings(
      {
        summaries: summaries.filter((summary): summary is ThreadSummary => summary !== undefined),
        workspaceNames,
        needsYou: (summary) =>
          needing.has(summary.thread.id) ||
          summary.status === "needsApproval" ||
          summary.status === "needsInput" ||
          summary.pendingRequests.length > 0,
        kinds,
        elsewhere: elsewhere === undefined ? undefined : new Set(elsewhere),
        placeOf: (threadId) => places?.find((place) => place.ids.includes(threadId))?.name,
      },
      query,
    );
  }, [summaries, workspaces, groups, query, kinds, elsewhere, places]);
  const counts = useMemo(() => threadsFilterCounts(listings), [listings]);
  // A filter whose last thread left it would show an empty list with nothing to say why: every
  // thread again.
  const picked = counts[filter] === 0 ? "all" : filter;
  const kept = useMemo(
    () => listings.filter((listing) => inThreadsFilter(listing, picked)),
    [listings, picked],
  );
  const shown = kept.slice(0, SHOWN);

  // Where the title bar names the page (a phone's, or an embedding app's) that is the page's top
  // heading: this one is the next level down, and on a phone it is not drawn a second time.
  const phone = usePhone();
  const barTitled = useEmbedPageTitle() !== undefined;
  const Heading = phone || barTitled ? "h2" : "h1";
  // With no thread at all there is nothing to count or to search: the page says what goes here.
  const none = listings.length === 0 && query.trim() === "";
  const outside = useMemo(() => {
    const solo = listings.filter((listing) => listing.summary.thread.workspaceId === undefined);
    return {
      total: solo.length,
      running: solo.filter((listing) => inThreadsFilter(listing, "running")).length,
    };
  }, [listings]);
  return (
    <section
      data-testid="threads-page"
      aria-labelledby="threads-title"
      className="@container min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-5 py-6 @3xl:px-8 @3xl:py-7">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Heading
            id="threads-title"
            className={cn("font-heading text-heading", phone && "sr-only")}
          >
            {title}
          </Heading>
          {workspaceWords !== undefined && (
            <div
              role="radiogroup"
              aria-label="List"
              data-testid="threads-view"
              className="flex items-center rounded-lg border border-border p-0.5"
            >
              {(
                [
                  ["workspaces", workspaceWords.plural, workspaces.length],
                  ["threads", "Threads", listings.length],
                ] as const
              ).map(([value, label, count]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={view === value}
                  data-view={value}
                  onClick={() => useThreadsView.setState({ view: value })}
                  className="flex h-6 items-center gap-1.5 rounded-md px-2.5 text-meta text-muted-foreground outline-none transition-colors duration-(--dur-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-checked:bg-secondary aria-checked:text-foreground phone:h-9"
                >
                  {label}
                  <span className="tabular-nums opacity-70">{count}</span>
                </button>
              ))}
            </div>
          )}
          {!none && workspaceWords === undefined && (
            <span className="text-meta text-muted-foreground tabular-nums">
              {/* Without the title beside it, the count says what it counts. */}
              {phone
                ? `${listings.length} ${listings.length === 1 ? "thread" : "threads"}`
                : listings.length}
            </span>
          )}
          {/* A phone's row holds the two lists and one button: on the list of threads that is the
              thread's, and making a workspace is on the workspaces' own list, a tap away. */}
          {workspaceWords !== undefined && (onWorkspaces || !phone) && (
            <Button
              size="sm"
              variant="outline"
              className="ms-auto"
              data-testid="threads-new-workspace"
              onClick={() => void navigate(newEntryRoute("workspace"))}
            >
              New {workspaceWords.noun.toLowerCase()}
            </Button>
          )}
          <Button
            size="sm"
            className={cn((workspaceWords === undefined || (phone && !onWorkspaces)) && "ms-auto")}
            data-testid="threads-new"
            // Worded by the embedding app, it starts a chat; Gram's own opens the choice used last.
            onClick={() => void navigate(newEntryRoute(newLabel === undefined ? entry : "oneOff"))}
          >
            {newLabel ?? "New task"}
          </Button>
        </header>
        {onWorkspaces ? (
          <WorkspacesList
            workspaces={workspaces}
            words={workspaceWords}
            outside={outside}
            solo={kinds?.solo}
            onShowThreads={() => useThreadsView.setState({ view: "threads" })}
          />
        ) : (
          <>
            {!none && (
              <label className="relative flex items-center">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute left-2.5 size-icon-row text-muted-foreground"
                />
                <input
                  type="search"
                  data-testid="threads-search"
                  aria-label="Search threads"
                  placeholder="Search threads"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-9 w-full rounded-lg border border-input bg-transparent pr-2.5 pl-8 text-reading outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
              </label>
            )}
            {listings.length > 0 && (
              <div
                role="radiogroup"
                aria-label="Show"
                data-testid="threads-filter"
                className="flex flex-wrap items-center gap-1.5"
              >
                {THREADS_FILTERS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={picked === value}
                    disabled={counts[value] === 0}
                    data-filter={value}
                    onClick={() => setFilter(value)}
                    className="flex h-7 items-center gap-1.5 rounded-full border border-border px-3 text-meta text-muted-foreground outline-none transition-colors duration-(--dur-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-checked:border-transparent aria-checked:bg-secondary aria-checked:text-foreground phone:h-9"
                  >
                    {label}
                    <span className="tabular-nums opacity-70">{counts[value]}</span>
                  </button>
                ))}
              </div>
            )}
            {shown.length === 0 ? (
              <EmptyState
                testId="threads-empty"
                icon={MessagesSquare}
                title={query.trim() === "" ? "No threads yet" : "No thread matches"}
                line={
                  query.trim() === ""
                    ? "Start a task and it is listed here, with every worker an orchestrator hands work to."
                    : "Try other words: a title, a workspace, or what started it."
                }
              />
            ) : (
              <ul data-testid="threads-list" className="flex flex-col gap-px">
                {shown.map((listing) => (
                  <ThreadRow key={listing.summary.thread.id} listing={listing} groups={groups} />
                ))}
              </ul>
            )}
            {kept.length > shown.length && (
              <p className="text-center text-meta text-muted-foreground">
                {kept.length - shown.length} more; search to find them.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function ThreadRow({
  listing,
  groups,
}: {
  listing: ThreadListing;
  groups: Parameters<typeof threadNeed>[0];
}) {
  const openThread = useOpenThread();
  const now = useNow(true, undefined, 60_000);
  const { summary, title, place, startedBy, sentFrom } = listing;
  const { thread } = summary;
  const detail = useThreadsStore((s) => s.statusDetail[thread.id]);
  const display = soloDisplay(threadStatusOf(summary, detail), threadNeed(groups, thread.id));
  const where = whereOf({ title, place, startedBy, sentFrom });
  return (
    <li>
      <button
        type="button"
        data-testid="threads-row"
        data-thread-id={thread.id}
        data-needs-you={listing.needsYou || undefined}
        aria-label={`${title}, ${display.label}, ${where}, last activity ${formatStamp(thread.lastActivityAt, now)}`}
        onClick={() => openThread(thread.id)}
        className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-2.5 gap-y-0.5 rounded-(--radius-sm) px-2.5 py-2 text-start outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* The state's dot, as the sidebar and the Board mark a thread: the words under the
            title say it, the dot lets a long list be read down its edge. */}
        <span
          aria-hidden
          data-testid="threads-row-dot"
          data-working={display.working || undefined}
          className={cn(
            "size-2 shrink-0 rounded-full bg-current",
            display.tone === "text-status-needs" ? "text-status-needs-mark" : display.tone,
            display.working && "gram-working",
          )}
        />
        <span className="min-w-0 truncate text-body text-foreground">{title}</span>
        <time
          dateTime={new Date(thread.lastActivityAt).toISOString()}
          title={`Last activity ${formatStamp(thread.lastActivityAt, now)}`}
          className="ms-1.5 text-meta text-muted-foreground tabular-nums"
        >
          {formatRelative(thread.lastActivityAt, now)}
        </time>
        <span className="col-start-2 flex min-w-0 items-center gap-1.5 text-meta">
          <span
            data-testid="threads-row-state"
            className={cn("shrink-0", display.tone, display.working && "gram-working")}
          >
            {display.label}
          </span>
          <span aria-hidden className="text-muted-foreground">
            ·
          </span>
          <span className="min-w-0 truncate text-muted-foreground">{where}</span>
        </span>
      </button>
    </li>
  );
}
