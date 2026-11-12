import type { ThreadSummary } from "@gram/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MessagesSquare, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { formatRelative, formatStamp } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { useEmbedShell, useThreadsTitle } from "@/embed/store";
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

import { threadListings, type ThreadListing } from "./threads-model";

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
  const summaries = useThreadsStore(useShallow((s) => Object.values(s.byId)));
  const workspaces = useWorkspaces();
  const groups = useDerivedAsks((s) => s.needsYou.groups);
  const entry = newEntryOf(useTaskDraftStore((s) => s.entry));
  // An app in front of Gram may give the page and its button words of its own.
  const title = useThreadsTitle();
  const newLabel = useEmbedShell((s) => s.threadsPage.newLabel);
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
      },
      query,
    );
  }, [summaries, workspaces, groups, query]);
  const shown = listings.slice(0, SHOWN);

  return (
    <section
      data-testid="threads-page"
      aria-labelledby="threads-title"
      className="@container min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-5 py-6 @3xl:px-8 @3xl:py-7">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 id="threads-title" className="font-heading text-heading">
            {title}
          </h1>
          <span className="text-meta text-muted-foreground tabular-nums">{listings.length}</span>
          <Button
            size="sm"
            className="ms-auto"
            data-testid="threads-new"
            // Worded by the embedding app, it starts a chat; Gram's own opens the choice used last.
            onClick={() => void navigate(newEntryRoute(newLabel === undefined ? entry : "oneOff"))}
          >
            {newLabel ?? "New task"}
          </Button>
        </header>
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
        {shown.length === 0 ? (
          <EmptyState
            testId="threads-empty"
            icon={MessagesSquare}
            title={query.trim() === "" ? "No threads yet" : "No thread matches"}
            line={
              query.trim() === ""
                ? "A task you start, and each worker it hands work to, is listed here."
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
        {listings.length > shown.length && (
          <p className="text-center text-meta text-muted-foreground">
            {listings.length - shown.length} more; search to find them.
          </p>
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
  const { summary, title, place, startedBy } = listing;
  const { thread } = summary;
  const detail = useThreadsStore((s) => s.statusDetail[thread.id]);
  const display = soloDisplay(threadStatusOf(summary, detail), threadNeed(groups, thread.id));
  const where = startedBy === undefined ? place : `${place} · ${startedBy}`;
  return (
    <li>
      <button
        type="button"
        data-testid="threads-row"
        data-thread-id={thread.id}
        data-needs-you={listing.needsYou || undefined}
        aria-label={`${title}, ${display.label}, ${where}, last activity ${formatStamp(thread.lastActivityAt, now)}`}
        onClick={() => openThread(thread.id)}
        className="grid w-full grid-cols-[1fr_auto] items-center gap-x-4 gap-y-0.5 rounded-(--radius-sm) px-2.5 py-2 text-start outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 truncate text-body text-foreground">{title}</span>
        <time
          dateTime={new Date(thread.lastActivityAt).toISOString()}
          title={`Last activity ${formatStamp(thread.lastActivityAt, now)}`}
          className="text-meta text-muted-foreground tabular-nums"
        >
          {formatRelative(thread.lastActivityAt, now)}
        </time>
        <span className="flex min-w-0 items-center gap-1.5 text-meta">
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
