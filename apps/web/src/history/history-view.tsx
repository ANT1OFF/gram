import { Dialog } from "@base-ui/react/dialog";
import type { FinishedWorker, OrchestratorLedger, WorkspaceId } from "@gram/contracts";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  CircleCheck,
  CircleMinus,
  CircleX,
  GitMerge,
  History,
  Search,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { create } from "zustand";

import { AgentIcon, agentLabel } from "@/agents/agent-display";
import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { useAvailableAgents } from "@/composer/agent-fields";
import { keyLabel } from "@/keyboard/registry";
import { KEY_CAP } from "@/keyboard/use-shortcut-hint";
import { listIndexForKey } from "@/lib/list-keys";
import { useNow } from "@/lib/use-now";
import { returnFocusTo, useOpener } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";
import { DoneGroupingMenu } from "@/orchestration/done-grouping-menu";
import { DONE_PAGE, doneWhenLong, doneWindow } from "@/orchestration/done-model";
import { useFinishedWorkerPages } from "@/orchestration/use-finished-workers";
import { useOrchestratorLedgers, useWorkspaces } from "@/orchestration/use-orchestration";
import {
  listResumableSessions,
  resumeSession,
  sessionsQueryKey,
  useResumeModel,
  useShowResumed,
} from "@/resume/resume-sessions";
import { useOpenThread } from "@/shell/thread-switcher";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import {
  HISTORY_FILTERS,
  historyEntries,
  historyThreadId,
  historyWhen,
  OUTCOME_LABEL,
  searchHistory,
  sessionRoots,
  type HistoryEntry,
  type HistoryFilter,
  type HistoryOutcome,
  type HistorySession,
} from "./history-model";
import { HistoryPreview, previewFacts } from "./history-preview";

/** The History dialog, which its shortcut may close from inside while no other dialog lets it open. */
export const HISTORY_TEST_ID = "history";

/** The folders whose agents' past sessions History reads, the most recently used first. */
const SESSION_ROOTS = 8;
/** The most past sessions read per folder and agent. */
const SESSIONS_PER_ROOT = 25;

interface HistoryState {
  readonly open: boolean;
  /** The chip it shows; kept between opens, so it opens where it was left. */
  readonly filter: HistoryFilter;
  toggle: () => void;
  /** What its search starts on when it next opens, then let go of: `show`'s `query`. */
  readonly seed?: string | undefined;
  /** Opens it, on `filter` when given, searching `query` when given. */
  show: (filter?: HistoryFilter, query?: string) => void;
  close: () => void;
  setFilter: (filter: HistoryFilter) => void;
}

/** Whether History is open, and on which chip. */
export const useHistoryStore = create<HistoryState>()((set) => ({
  open: false,
  filter: "all",
  toggle: () => set((s) => ({ open: !s.open })),
  show: (filter, query) => set((s) => ({ open: true, filter: filter ?? s.filter, seed: query })),
  close: () => set({ open: false }),
  setFilter: (filter) => set({ filter }),
}));

export const OUTCOME_GLYPH: Readonly<Record<HistoryOutcome, { icon: LucideIcon; tone: string }>> = {
  merged: { icon: GitMerge, tone: "text-merged" },
  delivered: { icon: CircleCheck, tone: "text-success" },
  stopped: { icon: CircleMinus, tone: "text-muted-foreground" },
  failed: { icon: CircleX, tone: "text-destructive" },
  archived: { icon: Archive, tone: "text-muted-foreground" },
};
const IMPORTED_GLYPH = { icon: History, tone: "text-muted-foreground" };

const EMPTY: Readonly<Record<HistoryFilter, string>> = {
  all: "Nothing finished yet",
  workers: "No finished workers yet",
  threads: "No finished or archived threads yet",
  archived: "Nothing archived",
  imported: "No past CLI sessions to resume",
};

/**
 * History: every past chat in one list, searched by title and repo as you type and narrowed by
 * kind. A click, or ↑↓ and Return, opens a Gram thread where it is, or resumes an agent's past
 * session into a new one.
 */
export function HistoryView() {
  const open = useHistoryStore((s) => s.open);
  const close = useHistoryStore((s) => s.close);
  const opener = useOpener(open);
  const [picked, setPicked] = useState(false);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else setPicked(false);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          data-testid={HISTORY_TEST_ID}
          data-surface="overlay"
          aria-label="History"
          // A thread just opened takes focus in its pane; only a dismissal hands it back.
          finalFocus={() => (picked ? false : returnFocusTo(opener)())}
          className="fixed top-[6%] left-1/2 z-50 flex h-[86vh] w-[min(72rem,94vw)] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-edge bg-popover text-popover-foreground shadow-modal transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
        >
          {open && <HistoryBody onPicked={() => setPicked(true)} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The past sessions no thread shows, of the folders most recently worked in. */
function usePastSessions(roots: readonly string[]) {
  const api = useApi();
  const agents = useAvailableAgents();
  return useQueries({
    queries: roots.map((root) => ({
      // Under the resume list's key, so a resume anywhere makes this stale too.
      queryKey: [...sessionsQueryKey(root), agents, "history"],
      queryFn: () => listResumableSessions(api, agents, root, SESSIONS_PER_ROOT),
      retry: false,
      staleTime: 60_000,
    })),
    combine: (results) => ({
      sessions: results.flatMap((result, i) =>
        (result.data?.sessions ?? []).map((session): HistorySession => ({
          ...session,
          projectRoot: roots[i]!,
        })),
      ),
      loading: results.some((result) => result.isPending),
    }),
  });
}

function HistoryBody({ onPicked }: { onPicked: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const workspaces = useWorkspaces();
  const ids = useMemo(() => workspaces.map((state) => state.workspace.id), [workspaces]);
  const ledgers = useOrchestratorLedgers(ids);
  const { finished, horizons, loadMore, busy } = useFinishedWorkerPages(ids);
  const byId = useThreadsStore((s) => s.byId);
  const statusDetail = useThreadsStore((s) => s.statusDetail);
  const summaries = useMemo(() => Object.values(byId).flatMap((s) => (s ? [s] : [])), [byId]);
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const roots = useMemo(
    () => sessionRoots(projects, summaries, SESSION_ROOTS),
    [projects, summaries],
  );
  const past = usePastSessions(roots);
  // Minute resolution is enough for the days and the times rows show.
  const now = useNow(true, undefined, 60_000);
  const by = useLayoutStore((s) => s.doneGrouping);
  const filter = useHistoryStore((s) => s.filter);
  const setFilter = useHistoryStore((s) => s.setFilter);
  // Read, not subscribed, and let go of once it opened, so the next open starts empty.
  const [query, setQuery] = useState(() => useHistoryStore.getState().seed ?? "");
  useEffect(() => {
    if (useHistoryStore.getState().seed !== undefined)
      useHistoryStore.setState({ seed: undefined });
  }, []);
  const [active, setActive] = useState(0);
  const [limit, setLimit] = useState(DONE_PAGE);
  const [resuming, setResuming] = useState<string>();
  const [error, setError] = useState<string>();
  const openThread = useOpenThread();
  const showResumed = useShowResumed();
  const modelFor = useResumeModel();

  const entries = useMemo(
    () =>
      historyEntries({
        workspaces: workspaces.map((state) => ({
          workspaceId: state.workspace.id,
          name: state.workspace.name,
          ledger: ledgers.get(state.workspace.id),
          finished: finished.get(state.workspace.id),
        })),
        summaries,
        projects,
        sessions: past.sessions,
        facts: { byId, statusDetail, now },
      }),
    [workspaces, ledgers, finished, summaries, projects, past.sessions, byId, statusDetail, now],
  );
  const found = useMemo(() => searchHistory(entries, filter, query), [entries, filter, query]);
  // Only workers come in pages: the other chips wait on none of them.
  const paged = filter === "all" || filter === "workers";
  const shown = useMemo(
    () => doneWindow(found, by, now, paged ? horizons : new Map<WorkspaceId, number>(), limit),
    [found, by, now, paged, horizons, limit],
  );
  const waitsOn = shown.load;
  useEffect(() => {
    if (waitsOn !== undefined && !busy) loadMore(waitsOn);
  }, [waitsOn, busy, loadMore]);
  const rows = shown.groups.flatMap((group) => group.rows);
  const activeIndex = Math.min(active, rows.length - 1);
  const cursorEntry = activeIndex < 0 ? undefined : rows[activeIndex];

  const pick = (entry: HistoryEntry | undefined) => {
    if (entry === undefined || resuming !== undefined) return;
    const threadId = historyThreadId(entry);
    if (threadId !== undefined) {
      onPicked();
      useHistoryStore.getState().close();
      openThread(threadId);
      return;
    }
    const session = entry.session;
    if (session === undefined) return;
    setResuming(entry.threadId);
    setError(undefined);
    resumeSession(api, session, session.projectRoot, modelFor(session.agent))
      .then((id) => {
        void queryClient.invalidateQueries({ queryKey: sessionsQueryKey(session.projectRoot) });
        onPicked();
        useHistoryStore.getState().close();
        showResumed(id);
      })
      .catch((e: unknown) => setError(`Couldn't resume: ${errorMessage(e)}`))
      .finally(() => setResuming(undefined));
  };

  const changeFilter = (next: HistoryFilter) => {
    setFilter(next);
    setActive(0);
    setLimit(DONE_PAGE);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Enter") return;
    // Return on a chip picks the chip.
    if (event.key === "Enter" && (event.target as HTMLElement).dataset["historyFilter"]) return;
    const next = listIndexForKey(event.key, activeIndex, rows.length);
    if (next !== undefined) {
      event.preventDefault();
      setActive(next);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      pick(rows[activeIndex]);
    }
  };

  let index = -1;
  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search aria-hidden className="size-icon-row text-muted-foreground" />
        <Dialog.Title className="sr-only">History</Dialog.Title>
        <input
          autoFocus
          data-testid="history-search"
          aria-label="Search history"
          placeholder="Search history by title or repo"
          className="h-11 flex-1 bg-transparent text-reading outline-none placeholder:text-muted-foreground"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setLimit(DONE_PAGE);
          }}
        />
      </div>
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <div role="radiogroup" aria-label="Show" className="flex flex-wrap items-center gap-1">
          {HISTORY_FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={filter === id}
              data-testid="history-filter"
              data-history-filter={id}
              onClick={() => changeFilter(id)}
              className={cn(
                "h-7 rounded-(--radius-sm) px-2.5 text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:focus-ring",
                filter === id && "bg-accent font-medium text-accent-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <DoneGroupingMenu className="ml-auto" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          role="listbox"
          aria-label="History"
          tabIndex={-1}
          aria-activedescendant={activeIndex < 0 ? undefined : `history-row-${activeIndex}`}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto p-1 outline-none"
        >
          {rows.length === 0 && (
            <p
              data-testid="history-empty"
              className="px-3 py-8 text-center text-reading text-muted-foreground"
            >
              {query.trim() !== ""
                ? "No matches"
                : filter === "imported" && past.loading
                  ? "Looking for past sessions…"
                  : EMPTY[filter]}
            </p>
          )}
          {shown.groups.map((group) => (
            <Fragment key={group.key}>
              <h3
                data-testid="history-group"
                data-grouping={by}
                className="px-2 pt-2 pb-0.5 text-meta font-medium text-muted-foreground"
              >
                {group.label}
              </h3>
              {group.rows.map((entry) => {
                index++;
                const at = index;
                return (
                  <HistoryRow
                    key={entry.threadId}
                    entry={entry}
                    index={at}
                    active={at === activeIndex}
                    resuming={resuming === entry.threadId}
                    grouped={by === "orchestrator"}
                    when={historyWhen(entry.finishedAt, now)}
                    whenLong={doneWhenLong(entry.finishedAt, now)}
                    onHover={() => setActive(at)}
                    onOpen={() => pick(entry)}
                  />
                );
              })}
            </Fragment>
          ))}
          {shown.more && (
            <button
              type="button"
              data-testid="history-more"
              aria-busy={busy || undefined}
              onClick={() => setLimit((current) => current + DONE_PAGE)}
              className="mx-1 rounded-md px-2 py-1 text-left text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:focus-ring"
            >
              Show more
            </button>
          )}
        </div>
        {cursorEntry !== undefined && (
          <Preview entry={cursorEntry} now={now} ledgers={ledgers} finished={finished} />
        )}
      </div>
      {error !== undefined && (
        <p role="alert" className="border-t border-border px-3 py-1.5 text-meta text-destructive">
          {error}
        </p>
      )}
      <div
        data-testid="history-keys"
        className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-1.5 text-caption text-muted-foreground"
      >
        <span>
          <kbd className="font-sans">↑↓</kbd> move
        </span>
        <span>
          <kbd className="font-sans">{keyLabel("⏎")}</kbd> open or resume
        </span>
        <span>
          <kbd className="font-sans">esc</kbd> close
        </span>
      </div>
    </div>
  );
}

/**
 * How a row reads: its glyph and outcome word, a status, apart from what Enter does to it, an
 * action (an imported session is "imported" and resumes; everything else opens), and where it ran,
 * a workspace named for its one repo said once, whatever its case ("Gram · gram" is "Gram").
 */
const rowWords = (entry: HistoryEntry) => ({
  glyph: entry.outcome === undefined ? IMPORTED_GLYPH : OUTCOME_GLYPH[entry.outcome],
  word: entry.outcome === undefined ? "imported" : OUTCOME_LABEL[entry.outcome],
  action: entry.outcome === undefined ? "Resume" : "Open",
  full: [entry.place, entry.repo]
    .filter(
      (part, i, parts) =>
        part !== "" && (i === 0 || part.toLowerCase() !== parts[0]!.toLowerCase()),
    )
    .join(" · "),
});

function HistoryRow({
  entry,
  index,
  active,
  resuming,
  grouped,
  when,
  whenLong,
  onHover,
  onOpen,
}: {
  entry: HistoryEntry;
  index: number;
  active: boolean;
  resuming: boolean;
  /** Under its workspace's heading: the row leaves the workspace's name to it. */
  grouped: boolean;
  when: string;
  whenLong: string;
  onHover: () => void;
  onOpen: () => void;
}) {
  const { glyph, word, action, full } = rowWords(entry);
  // Under the workspace's own heading, only the repo, and nothing where the repo is the workspace.
  const where = grouped
    ? entry.repo.toLowerCase() === entry.place.toLowerCase()
      ? ""
      : entry.repo
    : full;
  return (
    <div
      id={`history-row-${index}`}
      role="option"
      aria-selected={active}
      aria-busy={resuming || undefined}
      aria-label={`${entry.title}, ${full}, ${word}, ${whenLong}${entry.agent === undefined ? "" : `, ${agentLabel(entry.agent)}`}`}
      data-testid="history-row"
      data-thread-id={entry.threadId}
      data-kind={entry.kind}
      data-outcome={entry.outcome ?? "imported"}
      data-archived={entry.archived || undefined}
      onMouseMove={onHover}
      onClick={onOpen}
      className={cn(
        "flex min-h-9 cursor-default items-center gap-2.5 rounded-md px-2 text-reading",
        active && "row-cursor",
        resuming && "opacity-60",
      )}
    >
      <glyph.icon aria-hidden className={cn("size-icon-row shrink-0", glyph.tone)} />
      <span data-testid="history-title" className="min-w-0 truncate">
        {entry.title}
      </span>
      {where !== "" && (
        <span
          data-testid="history-where"
          className="min-w-0 shrink-[4] truncate text-meta text-muted-foreground"
        >
          {where}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-3 pl-3 text-meta text-muted-foreground">
        {/* The cursor row's action, ahead of the status columns so they stay aligned. */}
        {active && (
          <span data-testid="history-action" className="flex items-center gap-1 text-foreground">
            {action}
            <kbd className={KEY_CAP}>{keyLabel("⏎")}</kbd>
          </span>
        )}
        <span className="flex items-center gap-2">
          {entry.agent !== undefined && <AgentIcon agent={entry.agent} className="size-icon-row" />}
          <span data-testid="history-outcome" className="min-w-16 capitalize">
            {word}
          </span>
          <time
            data-testid="history-time"
            dateTime={
              entry.finishedAt === undefined ? undefined : new Date(entry.finishedAt).toISOString()
            }
            title={whenLong}
            className="min-w-10 text-right tabular-nums"
          >
            {when}
          </time>
        </span>
      </span>
    </div>
  );
}

/** The cursor row's preview, from its workspace's ledger and finished workers and its thread. */
function Preview({
  entry,
  now,
  ledgers,
  finished,
}: {
  entry: HistoryEntry;
  now: number;
  ledgers: ReadonlyMap<WorkspaceId, OrchestratorLedger>;
  finished: ReadonlyMap<WorkspaceId, readonly FinishedWorker[] | undefined>;
}) {
  const startedAt = useThreadsStore((s) =>
    entry.session === undefined ? s.byId[entry.threadId]?.thread.createdAt : undefined,
  );
  const { glyph, word, action, full } = rowWords(entry);
  const facts = previewFacts(entry, {
    ledger: entry.workspaceId === undefined ? undefined : ledgers.get(entry.workspaceId),
    finished: entry.workspaceId === undefined ? undefined : finished.get(entry.workspaceId),
    startedAt,
  });
  return (
    <HistoryPreview
      entry={entry}
      facts={facts}
      glyph={glyph}
      word={word}
      when={doneWhenLong(entry.finishedAt, now)}
      where={full}
      action={action}
    />
  );
}
