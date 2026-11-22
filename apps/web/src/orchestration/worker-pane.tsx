import { Popover } from "@base-ui/react/popover";
import type { FinishedWorkerDetail, ThreadId, WorkspaceId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GitPullRequest,
  Search,
  SquareArrowOutUpRight,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { AgentIcon, agentLabel } from "@/agents/agent-display";
import { useApi } from "@/api/context";
import { Hint } from "@/components/hint";
import { useWorkersWord } from "@/embed/store";
import { formatStamp, agoText } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { Swap } from "@/motion";
import { DiffPanel } from "@/panels/diff-panel";
import { FilesPanel } from "@/panels/files/files-panel";
import { OutboundLink } from "@/panels/outbound-link";
import { prDetailQuery, prDetailStamp } from "@/panels/pr-detail-query";
import { prTargetOf } from "@/panels/pr-identity";
import { PrPanel } from "@/panels/pr-panel";
import { ProofPanel, useVerifyState } from "@/panels/proof-panel";
import { TerminalPanel } from "@/panels/terminal/terminal-panel";
import { focusWhenRendered } from "@/shell/focus-regions";
import { useOpenThread } from "@/shell/thread-switcher";
import { threadStatusOf } from "@/sidebar/status";
import { useThreadsStore } from "@/stores/threads";
import { ReadOnlyTranscript } from "@/thread/read-only-transcript";
import { ThreadView } from "@/thread/thread-view";

import {
  backToWorkers,
  closeBeside,
  closePane,
  useBesideStore,
  WORKER_PANE_TEST_ID,
  type BesideTab,
} from "./beside-store";
import { FinishedFiles, FinishedWorkerView } from "./finished-worker-view";
import { shownPrNumbers, useWorkerPrChips, WorkerPrChips } from "./overview-pr-chips";
import { nowBesidePrs } from "./rail-model";
import { StatusDot } from "./status-dot";
import { STATUS_WORDS } from "./status-words";
import { WorkerHeadPlan } from "./worker-head-plan";
import { finishedRow } from "./workers-model";
import { neighbour, rowsInOrder, type PanelRow, type StatusGroup } from "./workers-panel-model";
import { useOpenWorker, useWorkerGroups } from "./workers-panel";
import { liveTools, recordTools, type Tool } from "./worker-tools";

export { WORKER_PANE_TEST_ID };

function useRecord(worker: ThreadId, record: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ["orchestrator", "finishedWorker", worker],
    queryFn: () => api.finishedWorker(worker),
    enabled: record,
    retry: false,
    staleTime: 60_000,
  });
}

const typedIn = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return target.value !== "";
  }
  return target.isContentEditable && (target.textContent ?? "").trim() !== "";
};

const heldInPane = (root: HTMLElement | null): boolean => {
  const held = document.activeElement;
  return (
    held instanceof HTMLElement &&
    held !== root &&
    root?.contains(held) === true &&
    !(held instanceof HTMLButtonElement && held.disabled)
  );
};

const inField = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable);

/** Back to the list, which puts back its place and the keys on the current worker's row. */
export const goBackToWorkers = backToWorkers;

function usePrFiles(worker: ThreadId, enabled: boolean) {
  const api = useApi();
  const git = useThreadsStore((s) => s.byId[worker]?.git);
  const boundPr = useThreadsStore((s) => s.byId[worker]?.thread.boundPr);
  const stamp = prDetailStamp(git, boundPr);
  const { data } = useQuery({
    ...prDetailQuery(api, worker, stamp),
    enabled: enabled && stamp !== null,
  });
  const files = data?.detail?.files;
  return files === undefined || files.length === 0 ? undefined : files;
}

const draftIn = (root: HTMLElement | null): boolean =>
  [...(root?.querySelectorAll<HTMLTextAreaElement>("textarea") ?? [])].some(
    (field) => field.value.trim() !== "",
  );

/**
 * The worker open in the pane, for the workspace whose list it came from. `record` is a finished
 * worker whose worktree was cleaned up, read from what Gram kept of it.
 */
export function WorkerPane({
  workspaceId,
  worker,
  record,
}: {
  workspaceId: WorkspaceId;
  worker: ThreadId;
  record: boolean;
}) {
  const summary = useThreadsStore((s) => s.byId[worker]);
  const kept = useRecord(worker, record);
  const detail = kept.data;
  const word = useWorkersWord();
  const title = summary?.thread.title ?? detail?.worker.title ?? "";
  const { groups } = useWorkerGroups(workspaceId);
  const order = useMemo(() => rowsInOrder(groups), [groups]);
  const openWorker = useOpenWorker();
  const tab = useBesideStore((s) => s.tab);
  const setTab = useBesideStore((s) => s.setTab);
  const focused = useBesideStore((s) => s.focused);
  const setFocused = useBesideStore((s) => s.setFocused);
  const root = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLButtonElement>(null);
  const git = summary?.git;
  const row = order.find((each) => each.threadId === worker);
  const finished =
    !record &&
    (row !== undefined ? row.source.tab === "done" : summary?.thread.completedAt !== undefined);
  const prFiles = usePrFiles(worker, finished);
  const verify = useVerifyState(worker, git?.head, !record && git?.repo === true).data;
  const tools = record
    ? recordTools(detail)
    : liveTools({
        git,
        boundPr: summary?.thread.boundPr,
        finished,
        prFiles: prFiles?.length,
        verify,
      });
  const shownTab = tools.find((tool) => tool.id === tab && tool.off === undefined)?.id ?? "thread";
  const before = neighbour(order, worker, -1);
  const after = neighbour(order, worker, 1);
  const step = (next: PanelRow | undefined) => {
    if (next !== undefined) openWorker(next, PLAIN, KEEP_TOOL);
  };
  const takeKeys = useBesideStore((s) => s.takeKeys);
  useEffect(() => {
    if (!takeKeys) return;
    useBesideStore.setState({ takeKeys: false });
    if (heldInPane(root.current)) return;
    void focusWhenRendered(() => titleRef.current);
  }, [takeKeys]);
  const toolKeys = useBesideStore((s) => s.toolKeys);
  useEffect(() => {
    if (!toolKeys) return;
    useBesideStore.setState({ toolKeys: false });
    void focusWhenRendered(() => {
      if (heldInPane(root.current)) return document.activeElement as HTMLElement;
      return root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? null;
    });
  }, [toolKeys]);
  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node | null)) setFocused(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      setFocused(false);
    };
  }, [setFocused]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.repeat) return;
    if (typedIn(event.target) || draftIn(root.current)) return;
    event.preventDefault();
    goBackToWorkers();
  };
  const onHeadKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.shiftKey || inField(event.target)) return;
    const next = event.key === "ArrowUp" ? before : after;
    event.preventDefault();
    step(next);
  };

  return (
    <div
      ref={root}
      data-testid={WORKER_PANE_TEST_ID}
      data-thread-id={worker}
      data-record={record || undefined}
      data-focused={focused}
      aria-label={`${word}: ${title}`}
      role="region"
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col bg-thread outline-none"
      onKeyDown={onKeyDown}
      onPointerDownCapture={() => setFocused(true)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <header
        data-testid="worker-pane-head"
        onKeyDown={onHeadKeyDown}
        className="flex shrink-0 flex-col gap-1 border-b border-border px-section pt-list pb-1.5"
      >
        <div className="flex min-w-0 items-center gap-0.5">
          <Hint
            label="Back (Esc)"
            side="bottom"
            render={
              <button
                type="button"
                data-testid="beside-back"
                aria-label={`Back to ${word}`}
                aria-keyshortcuts="Escape"
                onClick={goBackToWorkers}
                className="flex h-7 shrink-0 items-center gap-0.5 rounded-sm pr-1 text-body text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            <ChevronLeft aria-hidden className="size-icon-row" />
            <span data-testid="beside-crumb">{word}</span>
          </Hint>
          <ChevronRight aria-hidden className="size-icon-chip shrink-0 text-muted-foreground" />
          <Switcher
            trigger={titleRef}
            title={title}
            worker={worker}
            groups={groups}
            word={word}
            onPick={(picked) => openWorker(picked, PLAIN, KEEP_TOOL)}
          />
          <span className="flex-1" />
          <Hint
            label={before === undefined ? "No worker before" : `Previous: ${before.title} (↑)`}
            side="bottom"
            render={
              <button
                type="button"
                data-testid="beside-prev"
                aria-label={before === undefined ? "Previous worker" : `Previous: ${before.title}`}
                aria-keyshortcuts="ArrowUp"
                disabled={before === undefined}
                onClick={() => step(before)}
                className={ICON_BUTTON}
              />
            }
          >
            <ArrowUp aria-hidden className="size-icon-row" />
          </Hint>
          <Hint
            label={after === undefined ? "No worker after" : `Next: ${after.title} (↓)`}
            side="bottom"
            render={
              <button
                type="button"
                data-testid="beside-next"
                aria-label={after === undefined ? "Next worker" : `Next: ${after.title}`}
                aria-keyshortcuts="ArrowDown"
                disabled={after === undefined}
                onClick={() => step(after)}
                className={ICON_BUTTON}
              />
            }
          >
            <ArrowDown aria-hidden className="size-icon-row" />
          </Hint>
          <MainViewButton worker={worker} />
          <Hint
            label="Close"
            side="bottom"
            render={
              <button
                type="button"
                aria-label="Close"
                data-testid="beside-close"
                className={ICON_BUTTON}
                onClick={closePane}
              />
            }
          >
            <X aria-hidden className="size-icon-row" />
          </Hint>
        </div>
        {record ? (
          <RecordLine detail={detail} />
        ) : (
          <>
            <StateLine worker={worker} row={row} />
            <WorkerHeadPlan worker={worker} />
          </>
        )}
        <ToolRow tools={tools} shown={shownTab} onPick={setTab} />
      </header>
      <ToolBody
        tool={shownTab}
        worker={worker}
        record={record}
        finished={finished}
        prFiles={prFiles}
        head={git?.head}
        detail={detail}
        loading={record && kept.isPending}
        title={title}
        focused={focused}
      />
    </div>
  );
}

const ICON_BUTTON =
  "grid size-7 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";

function MainViewButton({ worker }: { worker: ThreadId }) {
  const open = useOpenThread();
  return (
    <Hint
      label="Open in the main view"
      side="bottom"
      render={
        <button
          type="button"
          aria-label="Open in the main view"
          data-testid="beside-open"
          className={ICON_BUTTON}
          onClick={() => {
            closeBeside();
            open(worker);
          }}
        />
      }
    >
      <SquareArrowOutUpRight aria-hidden className="size-icon-row" />
    </Hint>
  );
}

function StateLine({ worker, row }: { worker: ThreadId; row: PanelRow | undefined }) {
  const summary = useThreadsStore((s) => s.byId[worker]);
  const detail = useThreadsStore((s) => s.statusDetail[worker]);
  const chips = useWorkerPrChips(worker, NO_PRS);
  const now = useNow(true, undefined, 60_000);
  if (summary === undefined) return null;
  const display = threadStatusOf(summary, detail);
  const agent = summary.thread.model?.agent;
  const active = summary.thread.lastActivityAt;
  const status = row === undefined || display.working ? display.label : row.status;
  const tabPr = prTargetOf(summary.git, summary.thread.boundPr)?.number;
  return (
    <div
      data-testid="beside-state"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-1 text-meta text-muted-foreground"
    >
      {row === undefined || display.working ? (
        <Swap swapKey={display.label}>
          <display.icon
            aria-hidden
            data-working={display.working}
            className={cn("size-icon-row shrink-0", display.tone)}
          />
        </Swap>
      ) : (
        <StatusDot state={row.dot} className="-mr-0.5 shrink-0" />
      )}
      <WorkerPrChips
        threadId={worker}
        cardPrs={NO_PRS}
        chips={chips}
        dense
        foldMerged
        className="flex shrink-0 items-center"
        onOpenOwn={openPrTool}
        numberless={tabPr}
      />
      <span data-testid="beside-status" className="min-w-0 truncate" title={status}>
        {nowBesidePrs(status, shownPrNumbers(chips, true))}
      </span>
      <AgentAge agent={agent} at={active} now={now} />
    </div>
  );
}

function AgentAge({
  agent,
  at,
  now,
  stamp = false,
}: {
  agent: string | undefined;
  at: number | undefined;
  now: number;
  stamp?: boolean;
}) {
  if (agent === undefined && at === undefined) return null;
  return (
    <span
      data-testid="beside-agent-age"
      title={agent === undefined ? undefined : agentLabel(agent)}
      className="flex shrink-0 items-center gap-1 whitespace-nowrap"
    >
      {agent !== undefined && (
        <>
          <AgentIcon agent={agent} className="size-icon-chip" />
          <span className="sr-only">{agentLabel(agent)}</span>
        </>
      )}
      {at !== undefined && `active ${stamp ? formatStamp(at, now) : agoText(at, now)}`}
    </span>
  );
}

function RecordLine({ detail }: { detail: FinishedWorkerDetail | undefined }) {
  const now = useNow(true, undefined, 60_000);
  if (detail === undefined) return <div className="h-lh text-meta" />;
  const row = finishedRow(detail.worker, now);
  const merged = row.glyph === "merged";
  return (
    <div
      data-testid="beside-state"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-1 text-meta text-muted-foreground"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <StatusDot state={merged ? "merged" : "archived"} />
        <span className="truncate">
          {merged ? STATUS_WORDS.merged : "Cleaned up"} {formatStamp(detail.worker.closedAt, now)}
        </span>
      </span>
      {detail.worker.prs.map((pr) => (
        <OutboundLink
          key={`${pr.repo}#${pr.number}`}
          href={pr.url}
          className="inline-flex h-5 items-center gap-1 rounded-full border border-edge px-1.5 tabular-nums hover:text-foreground"
        >
          <GitPullRequest aria-hidden className="size-icon-chip" />
          {pr.number}
        </OutboundLink>
      ))}
      <AgentAge agent={detail.worker.agent} at={detail.worker.closedAt} now={now} stamp />
    </div>
  );
}

function ToolRow({
  tools,
  shown,
  onPick,
}: {
  tools: readonly Tool[];
  shown: BesideTab;
  onPick: (tab: BesideTab) => void;
}) {
  const reasons = useId();
  const row = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = [...(row.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
    const at = all.indexOf(event.target as HTMLElement);
    if (at === -1) return;
    const next =
      event.key === "ArrowRight"
        ? (at + 1) % all.length
        : event.key === "ArrowLeft"
          ? (at - 1 + all.length) % all.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? all.length - 1
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    all[next]?.focus();
  };
  return (
    <div
      ref={row}
      role="tablist"
      aria-label="The worker's tools"
      onKeyDown={onKeyDown}
      className="-mx-1 flex min-w-0 items-center gap-0.5 overflow-x-auto text-meta"
    >
      {tools.map((tool) => {
        const off = tool.off !== undefined;
        const selected = tool.id === shown;
        const button = (
          <button
            key={tool.id}
            type="button"
            role="tab"
            data-testid={`beside-tab-${tool.id}`}
            data-off={off || undefined}
            aria-selected={selected}
            aria-disabled={off || undefined}
            aria-describedby={off ? `${reasons}-${tool.id}` : undefined}
            tabIndex={selected ? 0 : -1}
            onMouseDown={(event) => {
              if (!keepsKeys(document.activeElement, row.current)) return;
              event.preventDefault();
            }}
            onClick={(event) => {
              if (!keepsKeys(document.activeElement, row.current)) event.currentTarget.focus();
              if (!off) onPick(tool.id);
            }}
            className={cn(
              "flex h-7 shrink-0 items-center gap-1 rounded-sm px-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring",
              off
                ? "cursor-not-allowed text-subtle line-through decoration-subtle"
                : selected
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <tool.icon aria-hidden className="size-icon-chip shrink-0" />
            {tool.label}
            {tool.count !== undefined && (
              <span className="tabular-nums opacity-80">{tool.count}</span>
            )}
            {off && (
              <span id={`${reasons}-${tool.id}`} className="sr-only">
                {tool.off}
              </span>
            )}
          </button>
        );
        return off ? (
          <Hint key={tool.id} label={tool.off!} side="bottom" render={button} />
        ) : (
          button
        );
      })}
    </div>
  );
}

const keepsKeys = (held: Element | null, row: HTMLElement | null): boolean =>
  inField(held) && row?.closest(`[data-testid="${WORKER_PANE_TEST_ID}"]`)?.contains(held) !== true;

function ToolBody({
  tool,
  worker,
  record,
  finished,
  prFiles,
  head,
  detail,
  loading,
  title,
  focused,
}: {
  tool: BesideTab;
  worker: ThreadId;
  record: boolean;
  finished: boolean;
  prFiles: readonly { path: string; additions: number; deletions: number }[] | undefined;
  head: string | undefined;
  detail: FinishedWorkerDetail | undefined;
  loading: boolean;
  title: string;
  focused: boolean;
}): ReactNode {
  if (record) {
    if (loading) return <Note>Loading…</Note>;
    if (detail === undefined) return <Note>Nothing kept of this worker</Note>;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {tool === "changes" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <FinishedFiles files={detail.files} />
          </div>
        ) : tool === "pr" ? (
          <ul className="flex flex-col gap-1 px-4 py-3 text-reading">
            {detail.worker.prs.map((pr) => (
              <li key={`${pr.repo}#${pr.number}`}>
                <OutboundLink href={pr.url} className="hover:underline">
                  {pr.repo}#{pr.number}
                  {pr.merged === true ? " · merged" : ""}
                </OutboundLink>
              </li>
            ))}
          </ul>
        ) : (
          <FinishedWorkerView detail={detail} bare />
        )}
        <p
          data-testid="beside-record-note"
          className="mx-section mb-section shrink-0 rounded-md border border-dashed border-edge px-3 py-2 text-meta text-muted-foreground"
        >
          Finished. Its worktree is cleaned up, so this is its record: read only.
        </p>
      </div>
    );
  }
  switch (tool) {
    case "thread":
      return finished ? (
        <ReadOnlyTranscript.Provider value>
          <ThreadView
            key={worker}
            threadId={worker}
            focused={focused}
            beside={{ header: null, readOnly: true, ownHead: true }}
          />
        </ReadOnlyTranscript.Provider>
      ) : (
        <ThreadView
          key={worker}
          threadId={worker}
          focused={focused}
          beside={{ header: null, placeholder: `Steer ${title}…`, ownHead: true }}
        />
      );
    case "terminal":
      return <TerminalPanel key={worker} threadId={worker} focusOnOpen={false} />;
    case "changes":
      if (finished && prFiles !== undefined) {
        return (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <FinishedFiles files={prFiles} />
          </div>
        );
      }
      return (
        <ReadOnlyTranscript.Provider value>
          <div className="flex min-h-0 flex-1 flex-col">
            <DiffPanel key={worker} threadId={worker} />
          </div>
        </ReadOnlyTranscript.Provider>
      );
    case "pr":
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <PrPanel key={worker} threadId={worker} />
        </div>
      );
    case "files":
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <FilesPanel key={worker} threadId={worker} />
        </div>
      );
    case "proof":
      return <ProofPanel key={worker} threadId={worker} head={head} />;
  }
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex flex-1 items-center justify-center text-reading text-muted-foreground">
      {children}
    </p>
  );
}

const NO_PRS: readonly never[] = [];

const openPrTool = () => useBesideStore.getState().setTab("pr");

const PLAIN = { metaKey: false, ctrlKey: false } as const;
const KEEP_TOOL = { keepTool: true } as const;

function Switcher({
  trigger,
  title,
  worker,
  groups,
  word,
  onPick,
}: {
  trigger: RefObject<HTMLButtonElement | null>;
  title: string;
  worker: ThreadId;
  groups: readonly StatusGroup[];
  word: string;
  onPick: (row: PanelRow) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<ThreadId | undefined>(undefined);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || active === undefined) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(active)}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);
  const needle = query.trim().toLowerCase();
  const shown = groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter((row) => needle === "" || row.title.toLowerCase().includes(needle)),
    }))
    .filter((group) => group.rows.length > 0);
  const rows = rowsInOrder(shown);
  const at = rows.findIndex((row) => row.threadId === active);
  const pick = (row: PanelRow | undefined) => {
    if (row === undefined) return;
    setOpen(false);
    onPick(row);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        rows.length === 0
          ? -1
          : event.key === "ArrowDown"
            ? Math.min(at + 1, rows.length - 1)
            : Math.max(at - 1, 0);
      setActive(rows[next]?.threadId);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(rows[at] ?? rows[0]);
    }
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery("");
          setActive(worker);
        }
      }}
    >
      <Popover.Trigger
        ref={trigger}
        data-testid="beside-title"
        aria-label={`${title}: go to another worker`}
        title={title}
        className="flex min-w-0 shrink items-center gap-1 rounded-sm px-1.5 py-0.5 font-heading text-body-strong text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent"
      >
        <span className="min-w-0 truncate">{title}</span>
        <ChevronDown aria-hidden className="size-icon-chip shrink-0 text-muted-foreground" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4} className="isolate z-50">
          <Popover.Popup
            data-testid="beside-switcher"
            data-surface="overlay"
            className="flex max-h-96 w-80 flex-col overflow-hidden rounded-md border border-edge bg-popover text-popover-foreground shadow-overlay outline-none"
          >
            <div className="flex items-center gap-2 border-b border-edge px-2.5 py-2">
              <Search aria-hidden className="size-icon-chip shrink-0 text-muted-foreground" />
              <input
                autoFocus
                data-testid="beside-switcher-filter"
                role="combobox"
                aria-expanded
                aria-controls={listId}
                aria-activedescendant={active === undefined ? undefined : `${listId}-${active}`}
                aria-label={`Go to another of the ${word.toLowerCase()}`}
                placeholder="Go to a worker…"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(undefined);
                }}
                onKeyDown={onKeyDown}
                className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              className="min-h-0 flex-1 overflow-y-auto p-1"
            >
              {shown.length === 0 && (
                <p className="px-2 py-1.5 text-meta text-muted-foreground">No matches</p>
              )}
              {shown.map((group) => (
                <div key={group.id} role="group" aria-label={group.label}>
                  <div className="px-2 pt-1.5 pb-0.5 text-meta text-muted-foreground">
                    {group.label}
                  </div>
                  {group.rows.map((row) => (
                    <div
                      key={row.threadId}
                      id={`${listId}-${row.threadId}`}
                      role="option"
                      data-testid="beside-switcher-row"
                      data-thread-id={row.threadId}
                      aria-selected={row.threadId === active}
                      aria-current={row.threadId === worker || undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => setActive(row.threadId)}
                      onClick={() => pick(row)}
                      className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-body aria-selected:row-cursor"
                    >
                      <StatusDot state={row.dot} className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{row.title}</span>
                      <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
                        {row.age}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <p className="flex gap-3 border-t border-edge px-2.5 py-1.5 text-meta text-muted-foreground">
              <span>↑ ↓ move</span>
              <span>⏎ open</span>
              <span>Esc close</span>
            </p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
