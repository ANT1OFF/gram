import { Dialog } from "@base-ui/react/dialog";
import type { ThreadId, WorkspaceId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import {
  Archive,
  CircleAlert,
  CircleCheck,
  CircleDot,
  GitMerge,
  Hand,
  Hourglass,
  Search,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { create } from "zustand";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { listIndexForKey } from "@/lib/list-keys";
import { useNow } from "@/lib/use-now";
import { returnFocusTo, useOpener } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";
import { GlideText, PresenceItem, PresenceList, Spinner, Swap } from "@/motion";
import { useOpenThread } from "@/shell/thread-switcher";
import { useThreadsStore } from "@/stores/threads";

import { askKeysByThread } from "./ask-model";
import { useWorkspaceAsks } from "./ask-stack";
import { keepBeside } from "./beside-store";
import { boardWorkspaceFor } from "./board-model";
import { useOrchestratorLedgers, useWorkspaces } from "./use-orchestration";
import { useWorkspaceStatuses } from "./use-workspace-statuses";
import {
  searchWorkers,
  tabCount,
  WORKERS_TABS,
  workersByTab,
  type WorkerGlyph,
  type WorkerRow,
  type WorkersTab,
} from "./workers-model";

/** The list's dialog, which ⌘J may close from inside while no other dialog lets it open. */
export const WORKERS_LIST_TEST_ID = "workers-list";

/** How long a worker opened from the list keeps its name's glide id, so only that open glides. */
const GLIDE_MS = 800;

interface WorkersListState {
  readonly open: boolean;
  /** The section it opened on, scrolled to with its first row active; the top without one. */
  readonly section: WorkersTab | undefined;
  /** The worker just opened from the list, whose name glides into its header. */
  readonly gliding: ThreadId | undefined;
  toggle: () => void;
  /** Opens it on `section`. */
  show: (section: WorkersTab) => void;
  close: () => void;
  opened: (threadId: ThreadId) => void;
}

let glideTimer: ReturnType<typeof setTimeout> | undefined;

/** Whether ⌘J's list is open, and the worker whose name glides out of it. */
export const useWorkersListStore = create<WorkersListState>()((set) => ({
  open: false,
  section: undefined,
  gliding: undefined,
  toggle: () => set((s) => ({ open: !s.open, section: undefined })),
  show: (section) => set({ open: true, section }),
  close: () => set({ open: false }),
  opened: (threadId) => {
    clearTimeout(glideTimer);
    set({ open: false, gliding: threadId });
    glideTimer = setTimeout(() => set({ gliding: undefined }), GLIDE_MS);
  },
}));

/** The id a worker's name glides by between the list and the worker view's crumbs. */
export const workerGlideId = (threadId: ThreadId) => `worker-name-${threadId}`;

const GLYPHS: Readonly<Record<WorkerGlyph, { icon: LucideIcon; tone: string; label: string }>> = {
  working: { icon: Spinner, tone: "text-status-working", label: "Working" },
  waiting: { icon: Hourglass, tone: "text-status-working", label: "Waiting on checks" },
  needsYou: { icon: CircleAlert, tone: "text-status-needs", label: "Needs you" },
  error: { icon: CircleAlert, tone: "text-destructive", label: "Error" },
  idle: { icon: CircleDot, tone: "text-status-idle", label: "Idle" },
  merged: { icon: GitMerge, tone: "text-merged", label: "Merged" },
  delivered: { icon: CircleCheck, tone: "text-muted-foreground", label: "Done" },
  archived: { icon: Archive, tone: "text-muted-foreground", label: "Archived" },
};

const EMPTY = "No workers yet";

/** The workspace the list is about: the open thread's, else the first one. */
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
 * The title bar's way into ⌘J: the workers of the workspace in front of you, with how many are on
 * now. Shown only where a workspace is, as ⌘J is.
 */
export function WorkersButton({ className }: { className?: string }) {
  const workspaceId = useListWorkspace();
  const workspaces = useWorkspaces();
  const ids = useMemo(() => workspaces.map((state) => state.workspace.id), [workspaces]);
  const ledgers = useOrchestratorLedgers(ids);
  const ledger = workspaceId === undefined ? undefined : ledgers.get(workspaceId);
  const now = useNow(true, undefined, 60_000);
  // Only the count: the threads' every change leaves it alone, and so leaves the title bar still.
  const count = useThreadsStore((s) =>
    tabCount(
      workersByTab(ledger, { byId: s.byId, statusDetail: s.statusDetail, now }, undefined).now,
    ),
  );
  const open = useWorkersListStore((s) => s.open);
  const hint = useShortcutHint("workers.open");
  if (workspaceId === undefined) return null;
  const label = count === 0 ? "Workers" : `Workers, ${count} now`;
  return (
    <Button
      variant="ghost"
      size="xs"
      data-testid="workers-button"
      aria-label={label}
      aria-pressed={open}
      title={withHint(label, hint)}
      className={cn("text-muted-foreground aria-pressed:text-foreground", className)}
      onClick={() => useWorkersListStore.getState().toggle()}
    >
      <Users aria-hidden />
      {count > 0 && <span className="tabular-nums">{count}</span>}
    </Button>
  );
}

/** The workers closed with their worktree, which the ledger no longer has. */
const useFinishedWorkers = (workspaceId: WorkspaceId | undefined) => {
  const api = useApi();
  return useQuery({
    queryKey: ["finishedWorkers", workspaceId ?? ""],
    queryFn: () => api.finishedWorkers(workspaceId!),
    enabled: workspaceId !== undefined,
    retry: false,
    staleTime: 30_000,
  }).data;
};

/**
 * ⌘J: every worker of the workspace in front of you, in Now, Done today and Earlier, grouped by
 * feature. One click, or ↑↓ and Return, opens a worker in the focused pane; opening it never
 * touches the worker.
 */
export function WorkersList() {
  const open = useWorkersListStore((s) => s.open);
  const close = useWorkersListStore((s) => s.close);
  const opener = useOpener(open);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          data-testid={WORKERS_LIST_TEST_ID}
          data-surface="overlay"
          aria-label="Workers"
          finalFocus={() => {
            // A worker just opened takes focus in its pane; only a dismissal hands it back.
            if (useWorkersListStore.getState().gliding !== undefined) return false;
            return returnFocusTo(opener)();
          }}
          className="fixed top-[12%] left-1/2 z-50 flex max-h-[70vh] w-[min(38rem,92vw)] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
        >
          {open && <WorkersBody />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function WorkersBody() {
  const workspaceId = useListWorkspace();
  const summaries = useThreadsStore((s) => s.byId);
  const statusDetail = useThreadsStore((s) => s.statusDetail);
  const threads = useMemo(() => Object.values(summaries), [summaries]);
  const { trees, ledgers } = useWorkspaceStatuses(threads);
  const tree = trees.find((each) => each.workspace.id === workspaceId);
  const ledger = workspaceId === undefined ? undefined : ledgers.get(workspaceId);
  // Minute resolution is enough for "today" and the times rows show.
  const now = useNow(true, undefined, 60_000);
  // Workers closed with their worktree, which the ledger no longer has; read-only when opened.
  const finished = useFinishedWorkers(workspaceId);
  // Who an ask in the stack is from, so a row's glyph takes the tone every other view gives it.
  const asks = useWorkspaceAsks();
  const asking = useMemo(
    () =>
      new Set(askKeysByThread(asks.find((w) => w.workspaceId === workspaceId)?.asks ?? []).keys()),
    [asks, workspaceId],
  );
  const tabs = useMemo(
    () => workersByTab(ledger, { byId: summaries, statusDetail, now, asking }, finished),
    [ledger, summaries, statusDetail, now, asking, finished],
  );
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const openThread = useOpenThread();

  // One list in three sections, so every worker is a click away once it is open; the search
  // box filters all of them.
  const sections = WORKERS_TABS.map(({ id, label }) => ({
    id,
    label,
    features: searchWorkers(tabs[id], query),
  })).filter((section) => section.features.length > 0);
  const rows = sections.flatMap((section) => section.features.flatMap((feature) => feature.rows));
  const activeIndex = Math.min(active, rows.length - 1);

  // Opened on a section (the rail's "done today"): its first row active, the section in view, once
  // it has rows.
  const listRef = useRef<HTMLDivElement>(null);
  const openedOn = useWorkersListStore((s) => s.section);
  const [placed, setPlaced] = useState(false);
  const sectionAt = sections.findIndex((each) => each.id === openedOn);
  if (!placed && openedOn !== undefined && sectionAt !== -1) {
    setPlaced(true);
    setActive(sections.slice(0, sectionAt).reduce((sum, each) => sum + tabCount(each.features), 0));
  }
  useLayoutEffect(() => {
    if (!placed || openedOn === undefined) return;
    listRef.current
      ?.querySelector(`[data-testid="workers-section-${openedOn}"]`)
      ?.scrollIntoView({ block: "start" });
  }, [placed, openedOn]);

  const pick = (row: WorkerRow | undefined) => {
    if (row === undefined) return;
    useWorkersListStore.getState().opened(row.threadId);
    openThread(row.threadId);
  };
  // ⌘⏎: beside the orchestrator's chat instead, for a worker that is still there to watch.
  const beside = (row: WorkerRow | undefined) => {
    if (row === undefined || row.cleanedUp === true) return;
    useWorkersListStore.getState().close();
    keepBeside(row.threadId, openThread);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // In the search box, Home, End and the page keys move the caret; only ↑↓ and Return are the
    // list's.
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Enter") return;
    const next = listIndexForKey(event.key, activeIndex, rows.length);
    if (next !== undefined) {
      event.preventDefault();
      setActive(next);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) beside(rows[activeIndex]);
      else pick(rows[activeIndex]);
    }
  };

  let index = -1;
  return (
    <div className="flex min-h-0 flex-col" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-3 border-b border-border px-3 py-2">
        <Dialog.Title className="font-heading text-sm font-medium">Workers</Dialog.Title>
        <span className="ml-auto truncate text-xs text-muted-foreground">
          {tree?.workspace.name}
        </span>
      </div>
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search aria-hidden className="size-3.5 text-muted-foreground" />
        <input
          autoFocus
          data-testid="workers-search"
          aria-label="Search workers"
          placeholder="Search workers"
          className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
      </div>
      <div
        ref={listRef}
        role="listbox"
        aria-label="Workers"
        tabIndex={-1}
        aria-activedescendant={activeIndex < 0 ? undefined : `worker-row-${activeIndex}`}
        className="min-h-0 overflow-y-auto p-1 outline-none"
      >
        {rows.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {query.trim() !== "" ? "No matches" : EMPTY}
          </p>
        )}
        {sections.map((section) => (
          <section
            key={section.id}
            data-testid={`workers-section-${section.id}`}
            aria-label={section.label}
            className="mb-1"
          >
            <h2 className="flex items-center gap-1 px-2 pt-2 pb-0.5 text-xs font-medium text-foreground">
              {section.label}
              <span className="tabular-nums text-muted-foreground">
                {tabCount(section.features)}
              </span>
            </h2>
            {section.features.map((feature) => (
              <div key={feature.feature} role="group" aria-label={feature.feature} className="mb-1">
                <div className="px-2 pt-1 pb-0.5 text-[11px] font-medium text-muted-foreground">
                  {feature.feature}
                </div>
                <PresenceList>
                  {feature.rows.map((row) => {
                    index++;
                    const at = index;
                    return (
                      <PresenceItem key={row.threadId}>
                        <WorkerListRow
                          row={row}
                          index={at}
                          active={at === activeIndex}
                          onHover={() => setActive(at)}
                          onOpen={() => pick(row)}
                        />
                      </PresenceItem>
                    );
                  })}
                </PresenceList>
              </div>
            ))}
          </section>
        ))}
      </div>
      <div
        data-testid="workers-keys"
        className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground"
      >
        <span>
          <kbd className="font-sans">⏎</kbd> open
        </span>
        <span>
          <kbd className="font-sans">⌘⏎</kbd> keep beside
        </span>
      </div>
    </div>
  );
}

function WorkerListRow({
  row,
  index,
  active,
  onHover,
  onOpen,
}: {
  row: WorkerRow;
  index: number;
  active: boolean;
  onHover: () => void;
  onOpen: () => void;
}) {
  const glyph = GLYPHS[row.glyph];
  return (
    <div
      id={`worker-row-${index}`}
      role="option"
      aria-selected={active}
      data-testid="worker-row"
      data-thread-id={row.threadId}
      data-glyph={row.glyph}
      onMouseMove={onHover}
      onClick={onOpen}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm",
        active && "bg-accent text-accent-foreground",
      )}
    >
      <glyph.icon aria-hidden className={cn("size-3.5 shrink-0", glyph.tone)} />
      <span className="sr-only">{glyph.label}: </span>
      <GlideText glideId={workerGlideId(row.threadId)} className="min-w-0 truncate">
        {row.title}
      </GlideText>
      {row.held && <Hand aria-label="You hold it" className="size-3 shrink-0 text-status-needs" />}
      <span className="shrink-0 text-xs text-muted-foreground">{row.repo}</span>
      <span
        data-testid="worker-now"
        className="ml-auto shrink-0 pl-3 text-right text-xs text-muted-foreground"
      >
        <Swap swapKey={row.now}>{row.now}</Swap>
      </span>
    </div>
  );
}
