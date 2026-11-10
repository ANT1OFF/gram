import { Menu } from "@base-ui/react/menu";
import type { FeatureCardPr, HostId, ThreadId, WorkspaceId } from "@gram/contracts";
import { CheckIcon, ChevronDown, ListFilter, Search, Server, Workflow, X } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { create } from "zustand";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { EmptyState } from "@/components/empty-state";
import { showInbox } from "@/inbox/inbox-store";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { machineHealth } from "@/settings/machine-status";
import { MACHINES_KEY, machinesApi } from "@/settings/machines-api";
import { useOpenThread } from "@/shell/thread-switcher";
import { useThreadsStore } from "@/stores/threads";

import { askKeysByThread } from "./ask-model";
import { keepBeside } from "./beside-store";
import { useWorkspaceAsks } from "./ask-stack";
import { useAnsweredWorkers } from "./needs-you-store";
import { useChipsFit, useWorkerPrChips, WorkerPrChips } from "./overview-pr-chips";
import { ROW_MARK, ROW_STATUS } from "./overview-section";
import { StatusDot } from "./status-dot";
import { useMessageOrchestrator } from "./message-orchestrator";
import { useFinishedWorkerPages } from "./use-finished-workers";
import { needsYouThreads } from "./needs-you-items";
import { useNeedsYouIn } from "./use-needs-you";
import { useOrchestratorLedgers, useWorkspaces } from "./use-orchestration";
import { WorkersDocs } from "./workers-docs";
import { workersByTab } from "./workers-model";
import {
  DONE_SHOWN,
  filteredGroups,
  filterLabel,
  FOLDED_BY_DEFAULT,
  STATUS_GROUPS,
  statusGroups,
  type PanelRow,
  type StatusGroup,
  elsewhereLine,
  type StatusGroupId,
} from "./workers-panel-model";

// The panel's Workers tab: one workspace's workers by where they stand, named in its heading,
// Needs you first and Done folded, each group's count quiet beside its name. Calm by space, not
// lines: no card edges, no rules, a dot, a title and an age per row. Its rows are ⌘J's, and its
// Needs you is the needs-you selector's in this workspace (`needsYouIn`), so every count agrees
// with the sidebar, the Board and the Inbox; what needs you elsewhere is said apart, never folded
// into this workspace's count.

export const WORKERS_PANEL_TEST_ID = "workers-panel";

interface WorkersPanelState {
  /** Groups folded or unfolded against their default (`FOLDED_BY_DEFAULT`). */
  readonly toggled: ReadonlySet<StatusGroupId>;
  /** Groups the filter shows; none picked shows every one. */
  readonly shown: ReadonlySet<StatusGroupId>;
  /** Done's rows past `DONE_SHOWN` are shown. */
  readonly doneAll: boolean;
  toggle: (id: StatusGroupId) => void;
  setShown: (id: StatusGroupId, on: boolean) => void;
  showAll: () => void;
  setDoneAll: (all: boolean) => void;
}

/** The tab's folds and filter, kept while the panel switches tabs or threads. */
export const useWorkersPanelStore = create<WorkersPanelState>()((set) => ({
  toggled: new Set(),
  shown: new Set(),
  doneAll: false,
  toggle: (id) =>
    set((s) => {
      const toggled = new Set(s.toggled);
      if (!toggled.delete(id)) toggled.add(id);
      return { toggled };
    }),
  setShown: (id, on) =>
    set((s) => {
      const shown = new Set(s.shown);
      if (on) shown.add(id);
      else shown.delete(id);
      // Every group picked is no filter at all.
      return { shown: shown.size === STATUS_GROUPS.length ? new Set() : shown };
    }),
  showAll: () => set({ shown: new Set() }),
  setDoneAll: (doneAll) => set({ doneAll }),
}));

/**
 * The rows' grid, which a group's heading, empty line and "N more" share: a 10 px mark column, then
 * the title, then its age, so marks centre on one column and words start on one edge.
 */
const ROW_GRID = "grid w-full grid-cols-[0.625rem_minmax(0,1fr)_auto] gap-x-2 px-1.5";

const folded = (toggled: ReadonlySet<StatusGroupId>, id: StatusGroupId): boolean =>
  FOLDED_BY_DEFAULT.includes(id) !== toggled.has(id);

/**
 * Opens a worker from the panel: a live one in the Thread tab, beside its orchestrator's chat, and
 * one that opens in the main view only (`mainOnly`), or any with ⌘/Ctrl, in the main view. The one
 * place that choice is made.
 */
function useOpenWorker(): (row: PanelRow, event: Pick<MouseEvent, "metaKey" | "ctrlKey">) => void {
  const openThread = useOpenThread();
  return (row, event) => {
    const full = row.mainOnly || event.metaKey || event.ctrlKey;
    if (!full && keepBeside(row.threadId, openThread)) return;
    openThread(row.threadId);
  };
}

/** The Workers tab for the workspace the open thread is in. */
export function WorkersPanel({ workspaceId }: { workspaceId: WorkspaceId }) {
  const byId = useThreadsStore((s) => s.byId);
  const statusDetail = useThreadsStore((s) => s.statusDetail);
  const ids = useMemo(() => [workspaceId], [workspaceId]);
  const ledger = useOrchestratorLedgers(ids).get(workspaceId);
  const finished = useFinishedWorkerPages(ids).finished.get(workspaceId);
  // Minute resolution is enough for the ages rows show.
  const now = useNow(true, undefined, 60_000);
  // Who an ask in the stack is from, so a row's dot takes the tone every other view gives it.
  const asks = useWorkspaceAsks();
  const asking = useMemo(
    () =>
      new Set(askKeysByThread(asks.find((w) => w.workspaceId === workspaceId)?.asks ?? []).keys()),
    [asks, workspaceId],
  );
  const answered = useAnsweredWorkers();
  const name = useWorkspaces().find((state) => state.workspace.id === workspaceId)?.workspace.name;
  // What needs you here, by the one selector the workspace's badge counts by, and elsewhere.
  const needs = useNeedsYouIn({ workspaceId });
  const needing = useMemo(() => needsYouThreads(needs.here), [needs.here]);
  const tabs = useMemo(
    () => workersByTab(ledger, { byId, statusDetail, now, asking, answered }, finished),
    [ledger, byId, statusDetail, now, asking, answered, finished],
  );
  const [query, setQuery] = useState<string | undefined>(undefined);
  const shown = useWorkersPanelStore((s) => s.shown);
  const all = statusGroups(tabs, byId, now, needing, query ?? "");
  const groups = filteredGroups(all, shown);
  const searching = query !== undefined && query.trim() !== "";
  const matches = groups.some((group) => group.rows.length > 0);
  // No worker at all, in any group: one empty state, not five groups that each say so.
  const none = !searching && all.every((group) => group.rows.length === 0);
  const messageOrchestrator = useMessageOrchestrator();

  return (
    <div
      data-testid={WORKERS_PANEL_TEST_ID}
      className="flex min-h-0 flex-1 flex-col"
      aria-label={name === undefined ? "Workers" : `Workers in ${name}`}
      role="region"
    >
      <Header query={query} onQuery={setQuery} workspace={name} />
      <div
        onKeyDown={rowKeys}
        className="flex min-h-0 flex-1 flex-col gap-section overflow-y-auto px-section pt-inset pb-section"
      >
        <WorkersDocs workspaceId={workspaceId} />
        {none ? (
          <EmptyState
            testId="workers-empty"
            icon={Workflow}
            title="No workers yet"
            line="The orchestrator briefs a worker for each piece of a task; each shows here by where it stands."
            action={{
              label: "Message the orchestrator",
              onClick: () => messageOrchestrator(workspaceId),
            }}
          />
        ) : searching && !matches ? (
          <p role="status" className="text-body text-muted-foreground">
            No matches
          </p>
        ) : (
          groups
            // A search lists only where it found something; otherwise every group says what it holds.
            .filter((group) => !searching || group.rows.length > 0)
            .map((group) => (
              <Group
                key={group.id}
                group={group}
                open={searching}
                elsewhere={group.id === "needs" && !searching ? needs.elsewhere.length : 0}
                here={name}
              />
            ))
        )}
      </div>
    </div>
  );
}

/**
 * "Workers in <workspace>", then search and the filter: two glyphs, each named on hover. The
 * workspace is named so every count under it reads as this workspace's, not the window's.
 */
function Header({
  query,
  onQuery,
  workspace,
}: {
  query: string | undefined;
  onQuery: (query: string | undefined) => void;
  workspace: string | undefined;
}) {
  const input = useRef<HTMLInputElement>(null);
  const close = () => onQuery(undefined);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  return (
    <div className="flex shrink-0 flex-col gap-inset px-section pt-list">
      <div className="flex items-center gap-tight">
        <h2
          data-testid="workers-panel-title"
          title={workspace === undefined ? undefined : `Workers in ${workspace}`}
          className="min-w-0 flex-1 truncate text-body-strong text-foreground"
        >
          Workers
          {workspace !== undefined && (
            <span className="font-normal text-muted-foreground"> in {workspace}</span>
          )}
        </h2>
        <Hint
          label={query === undefined ? "Search workers" : "Close search"}
          side="bottom"
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              data-testid="workers-panel-search-toggle"
              aria-label={query === undefined ? "Search workers" : "Close search"}
              aria-pressed={query !== undefined}
              className="text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
              onClick={() => (query === undefined ? onQuery("") : close())}
            />
          }
        >
          <Search />
        </Hint>
        <FilterMenu />
      </div>
      {query !== undefined && (
        <div className="flex h-8 items-center gap-inset rounded-xs bg-muted px-inset">
          <Search aria-hidden className="size-icon-chip shrink-0 text-muted-foreground" />
          <input
            ref={input}
            autoFocus
            data-testid="workers-panel-search"
            aria-label="Search workers"
            placeholder="Search workers…"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={onKeyDown}
            className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground"
          />
          {query !== "" && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                onQuery("");
                input.current?.focus();
              }}
              className="flex size-5 shrink-0 items-center justify-center rounded-2xs text-muted-foreground outline-none hover:text-foreground focus-visible:focus-ring"
            >
              <X aria-hidden className="size-icon-chip" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const POPUP =
  "z-50 min-w-48 origin-(--transform-origin) rounded-md border border-edge bg-popover p-1 text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";
const ITEM =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-body outline-none select-none data-[highlighted]:row-cursor";

/** Which groups show: each one checked, or every one. The glyph is on while a filter holds. */
function FilterMenu() {
  const shown = useWorkersPanelStore((s) => s.shown);
  const setShown = useWorkersPanelStore((s) => s.setShown);
  const showAll = useWorkersPanelStore((s) => s.showAll);
  const label = `Filter: ${filterLabel(shown)}`;
  const filtering = shown.size > 0;
  return (
    <Menu.Root>
      <Hint
        label={label}
        side="bottom"
        render={
          <Menu.Trigger
            data-testid="workers-panel-filter"
            data-filtering={filtering || undefined}
            aria-label={label}
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:focus-ring data-popup-open:bg-accent data-popup-open:text-foreground",
              // A filter that hides groups shows on the glyph's background, never by colour alone.
              filtering && "bg-accent text-foreground",
            )}
          />
        }
      >
        <ListFilter aria-hidden className="size-icon-row" />
      </Hint>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="isolate z-50 outline-none">
          <Menu.Popup
            data-surface="overlay"
            data-testid="workers-panel-filter-menu"
            className={POPUP}
          >
            <Menu.CheckboxItem
              checked={!filtering}
              onCheckedChange={() => showAll()}
              className={ITEM}
            >
              <Check />
              All workers
            </Menu.CheckboxItem>
            {STATUS_GROUPS.map((spec) => (
              <Menu.CheckboxItem
                key={spec.id}
                data-group={spec.id}
                checked={shown.has(spec.id)}
                onCheckedChange={(on) => setShown(spec.id, on)}
                className={ITEM}
              >
                <Check />
                {spec.label}
              </Menu.CheckboxItem>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function Check() {
  return (
    <span className="flex size-icon-row items-center justify-center">
      <Menu.CheckboxItemIndicator>
        <CheckIcon aria-hidden className="size-icon-chip" />
      </Menu.CheckboxItemIndicator>
    </span>
  );
}

/**
 * One group: its name and quiet count, a chevron that folds it, and its rows or the one line that
 * says what would be there. `open` unfolds it whatever its fold, as a search does. `elsewhere` is
 * how much needs you outside this workspace (`here`), said under Needs you so its count reads as
 * this workspace's share, with the way to the Inbox that lists it all.
 */
function Group({
  group,
  open,
  elsewhere = 0,
  here,
}: {
  group: StatusGroup;
  open: boolean;
  elsewhere?: number;
  here?: string | undefined;
}) {
  const isFolded = useWorkersPanelStore((s) => !open && folded(s.toggled, group.id));
  const toggle = useWorkersPanelStore((s) => s.toggle);
  const doneAll = useWorkersPanelStore((s) => s.doneAll);
  const setDoneAll = useWorkersPanelStore((s) => s.setDoneAll);
  const body = `workers-group-${group.id}-rows`;
  const count = group.rows.length;
  // Done shows its latest few before the rest fold behind "N more", as the sidebar's does.
  const capped = group.id === "done" && !doneAll && !open && count > DONE_SHOWN + 1;
  const rows = capped ? group.rows.slice(0, DONE_SHOWN) : group.rows;
  return (
    <section
      aria-label={group.label}
      data-testid={`workers-group-${group.id}`}
      data-count={count}
      className="flex flex-col gap-tight"
    >
      <h3>
        <button
          type="button"
          aria-expanded={!isFolded}
          aria-controls={body}
          aria-label={`${group.label}, ${count}`}
          onClick={() => toggle(group.id)}
          // Its chevron centred on the rows' dots, its name where their titles start.
          className={cn(
            ROW_GRID,
            "h-7 items-center rounded-xs text-left text-body text-muted-foreground outline-none hover:text-foreground focus-visible:focus-ring",
          )}
        >
          <span className="flex justify-center">
            <ChevronDown
              aria-hidden
              className={cn(
                "size-icon-chip shrink-0 transition-transform duration-(--dur-fast)",
                isFolded && "-rotate-90",
              )}
            />
          </span>
          <span className="flex min-w-0 items-baseline gap-inset">
            <span className="truncate font-medium text-foreground">{group.label}</span>
            <span data-testid="workers-group-count" className="text-meta tabular-nums">
              {count}
            </span>
          </span>
        </button>
      </h3>
      <div id={body} hidden={isFolded} className="flex flex-col">
        {count === 0 ? (
          // Only Needs you says it is empty, naming its workspace; any other group's 0 says it.
          group.id === "needs" && (
            <p
              data-testid="workers-group-empty"
              className={cn(ROW_GRID, "text-meta text-muted-foreground")}
            >
              <span className="col-start-2">
                {group.id === "needs" && here !== undefined
                  ? `Nothing in ${here} needs you`
                  : group.empty}
              </span>
            </p>
          )
        ) : (
          <>
            {rows.map((row) => (
              <Row key={row.threadId} row={row} />
            ))}
            {capped && (
              <button
                type="button"
                data-testid="workers-done-more"
                onClick={() => setDoneAll(true)}
                className={cn(
                  ROW_GRID,
                  "rounded-xs py-1 text-left text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:focus-ring",
                )}
              >
                <span className="col-start-2">{count - DONE_SHOWN} more</span>
              </button>
            )}
          </>
        )}
        {elsewhere > 0 && (
          <button
            type="button"
            data-testid="workers-needs-elsewhere"
            onClick={() => showInbox({ ask: true })}
            className={cn(
              ROW_GRID,
              "rounded-xs py-1 text-left text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:focus-ring",
            )}
          >
            <span className="col-start-2">{elsewhereLine(elsewhere, count)} · Open Inbox</span>
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * A worker, in the sidebar's row shape: its dot, its title on one line (cut at its end, whole on
 * hover) and its age, then one muted status line (amber while it needs you) with its PR chips at
 * the line's end while they fit beside the words. Opens it.
 */
function Row({ row }: { row: PanelRow }) {
  const openWorker = useOpenWorker();
  const current = useIsCurrentThread(row.threadId);
  const chips = useWorkerPrChips(row.threadId, NO_CARD_PRS);
  const { line, words, ghost, fits } = useChipsFit(chips.length);
  return (
    <div className="relative">
      <button
        type="button"
        data-testid="workers-panel-row"
        data-thread-id={row.threadId}
        data-dot={row.dot}
        aria-current={current ? "page" : undefined}
        title={`${row.title}\n${row.status}`}
        onClick={(event) => openWorker(row, event)}
        onKeyDown={(event) => {
          // ⌘⏎ opens it in the main view, as ⌘-click does; ⏎ alone is the row's click.
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          openWorker(row, event);
        }}
        className={cn(
          ROW_GRID,
          "items-start rounded-xs py-1.5 text-left text-body outline-none hover:bg-accent focus-visible:focus-ring aria-current:choice-selected",
        )}
      >
        <span className={ROW_MARK}>
          <StatusDot state={row.dot} />
        </span>
        <span className="min-w-0 truncate text-foreground">{row.title}</span>
        <span
          data-testid="workers-panel-age"
          title={row.at}
          className="flex h-lh items-center text-meta text-muted-foreground tabular-nums"
        >
          {row.age}
        </span>
        <span ref={line} className={cn(ROW_STATUS, "flex-wrap content-start overflow-hidden")}>
          <span
            ref={words}
            data-testid="workers-panel-status"
            className={cn(
              "min-w-0 flex-[0_1_auto] truncate",
              row.dot === "needs" && "text-status-needs",
            )}
          >
            {row.line}
          </span>
          {row.hostId !== undefined && <MachineTag hostId={row.hostId} />}
          <WorkerPrChips
            threadId={row.threadId}
            cardPrs={NO_CARD_PRS}
            chips={chips}
            dense
            ghost
            ghostRef={ghost}
            className="ml-auto"
          />
        </span>
      </button>
      {/* The chips sit over the status line, outside the row's button: each is a button of its own. */}
      {fits && (
        <WorkerPrChips
          threadId={row.threadId}
          cardPrs={NO_CARD_PRS}
          chips={chips}
          dense
          className="absolute right-1.5 bottom-1.5"
        />
      )}
    </div>
  );
}

/** The joined machine a worker runs on, named on hover as in Settings → Machines. */
function MachineTag({ hostId }: { hostId: HostId }) {
  const { data } = useQuery({
    queryKey: MACHINES_KEY,
    queryFn: machinesApi.list,
    retry: false,
    staleTime: 10_000,
  });
  const machine = data?.machines.find((m) => m.id === hostId);
  const name = machine?.name ?? "another machine";
  const health =
    machine === undefined || data === undefined ? undefined : machineHealth(machine, data);
  const label =
    health === undefined || health.tone === "online"
      ? `On ${name}`
      : `On ${name}, which ${health.tone === "update" ? "needs an update" : "is offline"}${
          health.why === undefined ? "" : `. ${health.why}`
        }`;
  // An icon of fixed width, its name on hover: the chips' fit is measured without it changing.
  return (
    <span
      data-testid="workers-panel-machine"
      role="img"
      aria-label={label}
      title={label}
      className="flex h-lh shrink-0 items-center text-muted-foreground"
    >
      <Server aria-hidden className="size-3" />
    </span>
  );
}

/** The panel's rows have no feature card: their chips come from the thread and the ledger. */
const NO_CARD_PRS: readonly FeatureCardPr[] = [];

/**
 * ↑↓, Home and End move between the rows shown, as in every list; ⏎ opens the one focused. Off a
 * row (in the search box, on a heading) only ↑↓ from a row count, so typing keeps its keys.
 */
function rowKeys(event: KeyboardEvent<HTMLElement>) {
  const from = (event.target as HTMLElement).closest<HTMLElement>(
    '[data-testid="workers-panel-row"]',
  );
  if (from === null) return;
  const rows = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[data-testid="workers-panel-row"]'),
  ].filter((row) => row.closest("[hidden]") === null);
  const at = rows.indexOf(from);
  const next =
    event.key === "ArrowDown"
      ? Math.min(at + 1, rows.length - 1)
      : event.key === "ArrowUp"
        ? Math.max(at - 1, 0)
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? rows.length - 1
            : undefined;
  if (next === undefined) return;
  event.preventDefault();
  rows[next]?.focus();
}

/**
 * Whether `threadId` is open in the main view, which its row marks as the current place. Only this
 * row's answer: a move to another thread re-renders the two rows it changes, not all.
 */
function useIsCurrentThread(threadId: ThreadId): boolean {
  return useParams({ strict: false, select: (params) => params.threadId === threadId });
}
