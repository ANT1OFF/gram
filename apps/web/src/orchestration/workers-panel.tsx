import { Menu } from "@base-ui/react/menu";
import type { ThreadId, WorkspaceId } from "@gram/contracts";
import {
  CheckIcon,
  ChevronDown,
  ListFilter,
  Search,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { create } from "zustand";

import { EmptyState } from "@/components/empty-state";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { useWorkersWord } from "@/embed/store";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { focusWhenRendered } from "@/shell/focus-regions";
import { useOpenThread } from "@/shell/thread-switcher";
import { useThreadsStore } from "@/stores/threads";

import { askKeysByThread } from "./ask-model";
import { closePane, keepBeside, openRecordBeside, useBesideStore } from "./beside-store";
import { useWorkspaceAsks } from "./ask-stack";
import { useAnsweredWorkers } from "./needs-you-store";
import { useOverviewFeatures } from "./overview-sidebar";
import { useMessageOrchestrator } from "./message-orchestrator";
import { useFinishedWorkerPages } from "./use-finished-workers";
import { needsYouThreads } from "./needs-you-items";
import { useNeedsYouIn } from "./use-needs-you";
import { useOrchestratorLedgers } from "./use-orchestration";
import { WorkersDocs } from "./workers-docs";
import { GroupHeading, ROW_NOTE } from "./workers-group";
import { workersByTab } from "./workers-model";
import {
  DONE_SHOWN,
  filteredGroups,
  filterLabel,
  FOLDED_BY_DEFAULT,
  overviewRowOf,
  rowsInOrder,
  STATUS_GROUPS,
  statusGroups,
  type PanelRow,
  type StatusGroup,
  type StatusGroupId,
} from "./workers-panel-model";
import { besideKey, WorkerRow } from "./worker-row";
import { WIDE_ROW_PARTS } from "./worker-row-wide";

export const WORKERS_PANEL_TEST_ID = "workers-panel";

interface WorkersPanelState {
  readonly toggled: ReadonlySet<StatusGroupId>;
  readonly shown: ReadonlySet<StatusGroupId>;
  readonly doneAll: boolean;
  readonly docsFolded: boolean;
  readonly query: string | undefined;
  readonly queryFor: WorkspaceId | undefined;
  readonly place: { readonly scroll: number; readonly index: number } | undefined;
  readonly focus: boolean;
  toggleDocs: () => void;
  toggle: (id: StatusGroupId) => void;
  setShown: (id: StatusGroupId, on: boolean) => void;
  showAll: () => void;
  setDoneAll: (all: boolean) => void;
  setQuery: (workspaceId: WorkspaceId, query: string | undefined) => void;
}

/** The list's folds, filter, search and place, kept while the pane shows a worker or a tab. */
export const useWorkersPanelStore = create<WorkersPanelState>()((set) => ({
  toggled: new Set(),
  shown: new Set(),
  doneAll: false,
  docsFolded: false,
  query: undefined,
  queryFor: undefined,
  place: undefined,
  focus: false,
  toggleDocs: () => set((s) => ({ docsFolded: !s.docsFolded })),
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
      return { shown: shown.size === STATUS_GROUPS.length ? new Set() : shown };
    }),
  showAll: () => set({ shown: new Set() }),
  setDoneAll: (doneAll) => set({ doneAll }),
  setQuery: (workspaceId, query) => set({ query, queryFor: workspaceId }),
}));

/** Asks the list for the keys: on the current row, else the first; it takes them once drawn. */
export const focusWorkersList = () => useWorkersPanelStore.setState({ focus: true });

const folded = (toggled: ReadonlySet<StatusGroupId>, id: StatusGroupId): boolean =>
  FOLDED_BY_DEFAULT.includes(id) !== toggled.has(id);

/**
 * A workspace's workers by group, the ⌘J rows' facts, and which ask each waits on: what the list,
 * the switcher and ↑ ↓ all read, so they agree on what each worker is and where it stands.
 */
export function useWorkerGroups(workspaceId: WorkspaceId, query = "") {
  const byId = useThreadsStore((s) => s.byId);
  const statusDetail = useThreadsStore((s) => s.statusDetail);
  const ids = useMemo(() => [workspaceId], [workspaceId]);
  const ledger = useOrchestratorLedgers(ids).get(workspaceId);
  const finished = useFinishedWorkerPages(ids).finished.get(workspaceId);
  const now = useNow(true, undefined, 60_000);
  const asks = useWorkspaceAsks();
  const askKeys = useMemo(
    () => askKeysByThread(asks.find((w) => w.workspaceId === workspaceId)?.asks ?? []),
    [asks, workspaceId],
  );
  const asking = useMemo(() => new Set(askKeys.keys()), [askKeys]);
  const answered = useAnsweredWorkers();
  const needs = useNeedsYouIn({ workspaceId });
  const needing = useMemo(() => needsYouThreads(needs.here), [needs.here]);
  const tabs = useMemo(
    () => workersByTab(ledger, { byId, statusDetail, now, asking, answered }, finished),
    [ledger, byId, statusDetail, now, asking, answered, finished],
  );
  const groups = useMemo(
    () => statusGroups(tabs, byId, now, needing, query),
    [tabs, byId, now, needing, query],
  );
  return { groups, askKeys };
}

function useCardRows(workspaceId: WorkspaceId) {
  const features = useOverviewFeatures(workspaceId);
  return useMemo(
    () =>
      new Map(
        features.flatMap((feature) =>
          feature.rows.map(
            (row) =>
              [row.threadId, { row, feature: feature.feature, at: feature.updatedAt }] as const,
          ),
        ),
      ),
    [features],
  );
}

/**
 * Opens a worker from the list in the pane, beside its orchestrator's chat, the keys staying in
 * the pane; a finished one whose worktree was cleaned up as its record. A solo thread, or any with
 * ⌘/Ctrl, opens in the main view. The one place that choice is made.
 */
export function useOpenWorker(): (
  row: PanelRow,
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  options?: { readonly keepTool?: boolean },
) => void {
  const openThread = useOpenThread();
  return (row, event, options = {}) => {
    const full = besideKey(event) || row.source.solo === true;
    if (full) return openThread(row.threadId);
    if (row.source.cleanedUp === true) {
      if (!openRecordBeside(row.threadId, options)) openThread(row.threadId);
      return;
    }
    if (!keepBeside(row.threadId, openThread, { keepFocus: true, ...options })) {
      openThread(row.threadId);
    }
  };
}

/** One of the orchestrator's own views, which its menu in the list's head opens in the pane. */
export interface OrchestratorView {
  readonly value: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

/**
 * The views of the thread in the main view, for the menu in the list's head: the orchestrator's,
 * named so; `label` names them otherwise (a worker opened in the main view: "This thread").
 */
export interface OrchestratorViews {
  readonly views: readonly OrchestratorView[];
  readonly onPick: (value: string) => void;
  readonly label?: string | undefined;
}

/**
 * The Workers list for the workspace the open thread is in. `orchestrator` is the orchestrator's
 * own views, for the menu in its head; left out (a phone's strip, or an app that offers the pane
 * for workers alone) there is none. `closable` puts ✕ in its head, the pane's own close.
 */
export function WorkersPanel({
  workspaceId,
  orchestrator,
  closable = false,
}: {
  workspaceId: WorkspaceId;
  orchestrator?: OrchestratorViews | undefined;
  closable?: boolean;
}) {
  const storedQuery = useWorkersPanelStore((s) => s.query);
  const queryFor = useWorkersPanelStore((s) => s.queryFor);
  const setQuery = useWorkersPanelStore((s) => s.setQuery);
  const query = queryFor === workspaceId ? storedQuery : undefined;
  const { groups: all, askKeys } = useWorkerGroups(workspaceId, query ?? "");
  const shown = useWorkersPanelStore((s) => s.shown);
  const groups = filteredGroups(all, shown);
  const cards = useCardRows(workspaceId);
  const searching = query !== undefined && query.trim() !== "";
  const matches = groups.some((group) => group.rows.length > 0);
  const none = !searching && all.every((group) => group.rows.length === 0);
  const messageOrchestrator = useMessageOrchestrator();
  const listed = groups.filter((group) => group.rows.length > 0);
  const docsFolded = useWorkersPanelStore((s) => s.docsFolded);
  const toggleDocs = useWorkersPanelStore((s) => s.toggleDocs);
  const word = useWorkersWord();
  const current = useBesideStore((s) => s.current);
  const scroller = useRef<HTMLDivElement>(null);
  const openWorker = useOpenWorker();
  const doneCount = all.find((group) => group.id === "done")?.rows.length ?? 0;
  const liveCount = all.reduce((sum, group) => sum + group.rows.length, 0) - doneCount;
  usePlaceKept(scroller, all, current);

  const open = (row: PanelRow, event: Pick<MouseEvent, "metaKey" | "ctrlKey">) => {
    const rows = [...(scroller.current?.querySelectorAll<HTMLElement>(LIST_ROWS) ?? [])];
    const index = rows.findIndex((each) => each.dataset.threadId === row.threadId);
    useWorkersPanelStore.setState({
      place: { scroll: scroller.current?.scrollTop ?? 0, index: Math.max(index, 0) },
    });
    openWorker(row, event);
  };

  return (
    <div
      data-testid={WORKERS_PANEL_TEST_ID}
      className="flex min-h-0 flex-1 flex-col"
      aria-label={word}
      role="region"
    >
      <Header
        word={word}
        counts={none ? undefined : { live: liveCount, done: doneCount }}
        query={query}
        onQuery={(next) => setQuery(workspaceId, next)}
        orchestrator={orchestrator}
        closable={closable}
      />
      <div
        ref={scroller}
        data-testid="workers-panel-list"
        onKeyDown={rowKeys}
        className="flex min-h-0 flex-1 flex-col gap-section overflow-y-auto px-section pt-inset pb-section"
      >
        {none ? (
          <EmptyState
            testId="workers-empty"
            icon={Workflow}
            title={`No ${word.toLowerCase()} yet`}
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
          <>
            {listed.map((group) => (
              <Group
                key={group.id}
                group={group}
                open={searching}
                render={(row) => {
                  const card = cards.get(row.threadId);
                  const done = row.source.tab === "done";
                  return (
                    <WorkerRow
                      key={row.threadId}
                      row={card?.row ?? overviewRowOf(row, askKeys.get(row.threadId))}
                      feature={card?.feature ?? row.source.feature}
                      updatedAt={card?.at ?? row.atMs ?? 0}
                      wide={WIDE_ROW_PARTS}
                      current={current === row.threadId}
                      onOpen={(event) => open(row, event)}
                      {...(done ? { at: row.atMs, mark: row.dot } : {})}
                    />
                  );
                }}
              />
            ))}
            {listed.length === 0 && (
              <p
                role="status"
                data-testid="workers-filter-empty"
                className="text-body text-muted-foreground"
              >
                No workers in {filterLabel(shown)}
              </p>
            )}
          </>
        )}
        {!searching && (
          <WorkersDocs workspaceId={workspaceId} folded={docsFolded} onToggle={toggleDocs} />
        )}
      </div>
    </div>
  );
}

const LIST_ROWS = '[data-testid="workers-panel-row"]';

function usePlaceKept(
  scroller: React.RefObject<HTMLDivElement | null>,
  groups: readonly StatusGroup[],
  current: ThreadId | undefined,
) {
  const restore = useBesideStore((s) => s.returned);
  const focus = useWorkersPanelStore((s) => s.focus);
  useLayoutEffect(() => {
    if (!restore || current === undefined) return;
    const group = groups.find((each) => each.rows.some((row) => row.threadId === current));
    if (group === undefined) return;
    const store = useWorkersPanelStore.getState();
    if (folded(store.toggled, group.id)) store.toggle(group.id);
    if (group.id === "done" && !store.doneAll) {
      const at = group.rows.findIndex((row) => row.threadId === current);
      if (at >= DONE_SHOWN) store.setDoneAll(true);
    }
  }, [restore, current, groups]);
  const listed =
    current !== undefined && groups.some((g) => g.rows.some((r) => r.threadId === current));
  useEffect(() => {
    if (!restore && !focus) return;
    const { place } = useWorkersPanelStore.getState();
    useWorkersPanelStore.setState({ focus: false });
    useBesideStore.setState({ returned: false });
    const box = scroller.current;
    if (box === null) return;
    if (restore && place !== undefined) box.scrollTo({ top: place.scroll });
    const rows = () =>
      [...box.querySelectorAll<HTMLElement>(LIST_ROWS)].filter(
        (row) => row.closest("[hidden]") === null,
      );
    let tries = 0;
    void focusWhenRendered(() => {
      const all = rows();
      const own = all.find((row) => row.dataset.threadId === current);
      if (own !== undefined) return own;
      if (listed && ++tries < 20) return null;
      if (all.length > 0) return all[Math.min(restore ? (place?.index ?? 0) : 0, all.length - 1)]!;
      return box.querySelector<HTMLElement>("button");
    }, 30).then(() => {
      (document.activeElement as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" });
    });
  }, [restore, focus, scroller, current, listed]);
}

function Header({
  word,
  counts,
  query,
  onQuery,
  orchestrator,
  closable,
}: {
  word: string;
  counts: { readonly live: number; readonly done: number } | undefined;
  query: string | undefined;
  onQuery: (query: string | undefined) => void;
  orchestrator: OrchestratorViews | undefined;
  closable: boolean;
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
          className="flex min-w-0 flex-1 items-baseline gap-inset truncate text-body-strong text-foreground"
        >
          {word}
          {counts !== undefined && (
            <span
              data-testid="workers-panel-counts"
              className="truncate font-normal text-muted-foreground tabular-nums"
            >
              {counts.live}
              {counts.done > 0 && ` · ${counts.done} done`}
            </span>
          )}
        </h2>
        <Hint
          label={query === undefined ? `Search ${word.toLowerCase()}` : "Close search"}
          side="bottom"
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              data-testid="workers-panel-search-toggle"
              aria-label={query === undefined ? `Search ${word.toLowerCase()}` : "Close search"}
              aria-pressed={query !== undefined}
              className="text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
              onClick={() => (query === undefined ? onQuery("") : close())}
            />
          }
        >
          <Search />
        </Hint>
        <FilterMenu />
        {orchestrator !== undefined && orchestrator.views.length > 0 && (
          <OrchestratorMenu
            views={orchestrator.views}
            onPick={orchestrator.onPick}
            label={orchestrator.label}
          />
        )}
        {closable && (
          <Hint
            label="Close"
            side="bottom"
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                data-testid="workers-panel-close"
                aria-label="Close"
                className="text-muted-foreground"
                onClick={closePane}
              />
            }
          >
            <X />
          </Hint>
        )}
      </div>
      {query !== undefined && (
        <div className="flex h-8 items-center gap-inset rounded-xs bg-muted px-inset">
          <Search aria-hidden className="size-icon-chip shrink-0 text-muted-foreground" />
          <input
            ref={input}
            autoFocus
            data-testid="workers-panel-search"
            aria-label={`Search ${word.toLowerCase()}`}
            placeholder={`Search ${word.toLowerCase()}…`}
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

function OrchestratorMenu({
  views,
  onPick,
  label,
}: {
  views: readonly OrchestratorView[];
  onPick: (value: string) => void;
  label: string | undefined;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        data-testid="workers-panel-orchestrator"
        aria-label={label === undefined ? "The orchestrator's own views" : `${label}: its views`}
        className="ml-tight flex h-7 shrink-0 items-center gap-1 rounded-xs px-1.5 text-meta text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:focus-ring data-popup-open:bg-accent data-popup-open:text-foreground"
      >
        {label ?? "Orchestrator"}
        <ChevronDown aria-hidden className="size-icon-chip" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="isolate z-50 outline-none">
          <Menu.Popup
            data-surface="overlay"
            data-testid="workers-panel-orchestrator-menu"
            className={POPUP}
          >
            {views.map((view) => (
              <Menu.Item
                key={view.value}
                data-view={view.value}
                className={ITEM}
                onClick={() => onPick(view.value)}
              >
                <view.icon aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
                {view.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

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

function Group({
  group,
  open,
  render,
}: {
  group: StatusGroup;
  open: boolean;
  render: (row: PanelRow) => React.ReactNode;
}) {
  const isFolded = useWorkersPanelStore((s) => !open && folded(s.toggled, group.id));
  const toggle = useWorkersPanelStore((s) => s.toggle);
  const doneAll = useWorkersPanelStore((s) => s.doneAll);
  const setDoneAll = useWorkersPanelStore((s) => s.setDoneAll);
  const body = `workers-group-${group.id}-rows`;
  const count = group.rows.length;
  const capped = group.id === "done" && !doneAll && !open && count > DONE_SHOWN + 1;
  const rows = capped ? group.rows.slice(0, DONE_SHOWN) : group.rows;
  return (
    <section
      aria-label={group.label}
      data-testid={`workers-group-${group.id}`}
      data-count={count}
      className="flex flex-col gap-tight"
    >
      <GroupHeading
        label={group.label}
        count={count}
        folded={isFolded}
        controls={body}
        onToggle={() => toggle(group.id)}
      />
      <div id={body} hidden={isFolded} className="flex flex-col gap-px">
        {rows.map(render)}
        {capped && (
          <button
            type="button"
            data-testid="workers-done-more"
            onClick={() => setDoneAll(true)}
            className={ROW_NOTE}
          >
            <span className="col-start-2">{count - DONE_SHOWN} more</span>
          </button>
        )}
      </div>
    </section>
  );
}

const KEYED_ROWS = '[data-testid="workers-panel-row"], [data-testid="doc-row"]';

function rowKeys(event: KeyboardEvent<HTMLElement>) {
  const from = (event.target as HTMLElement).closest<HTMLElement>(KEYED_ROWS);
  if (from === null) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(KEYED_ROWS)].filter(
    (row) => row.closest("[hidden]") === null,
  );
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

/** Every worker in the list's order, for ↑ ↓ and the switcher: the groups' rows, all of Done. */
export function useWorkerOrder(workspaceId: WorkspaceId) {
  const { groups, askKeys } = useWorkerGroups(workspaceId);
  return { groups, order: rowsInOrder(groups), askKeys };
}
