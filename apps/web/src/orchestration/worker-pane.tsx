import { Popover } from "@base-ui/react/popover";
import type { FinishedWorkerDetail, ThreadId, WorkspaceId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileDiff,
  FolderTree,
  GitPullRequest,
  MessageSquare,
  Search,
  SquareArrowOutUpRight,
  SquareTerminal,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
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
import { PrPanel } from "@/panels/pr-panel";
import { useOpenThread } from "@/shell/thread-switcher";
import { threadStatusOf } from "@/sidebar/status";
import { useThreadsStore } from "@/stores/threads";
import { useThreadHeadline } from "@/thread/plan-ui";
import { ReadOnlyTranscript } from "@/thread/read-only-transcript";
import { ThreadView } from "@/thread/thread-view";

import { LiveTerminal } from "./beside-dock";
import {
  backToWorkers,
  closeBeside,
  closePane,
  useBesideStore,
  type BesideTab,
} from "./beside-store";
import { FinishedFiles, FinishedWorkerView } from "./finished-worker-view";
import { useWorkerPrChips, WorkerPrChips } from "./overview-pr-chips";
import { StatusDot } from "./status-dot";
import { STATUS_WORDS } from "./status-words";
import { PlanSteps } from "./worker-row-wide";
import { finishedRow } from "./workers-model";
import { neighbour, rowsInOrder, type PanelRow, type StatusGroup } from "./workers-panel-model";
import { useOpenWorker, useWorkerGroups, useWorkersPanelStore } from "./workers-panel";

// A worker open in the right pane, under "‹ Workers › its title": its state on one line, its own
// tools in one row under that (Conversation, Changes, PR, Terminal, Files), and its composer, which
// steers it. The orchestrator's chat stays in the main view beside it. Back (‹, the crumb, or Esc
// with the keys in the pane and nothing typed) returns to the list where it was; ↑ ↓ step to the
// worker before or after it in the list's order, and its title opens a switcher of every worker,
// by group. A finished worker whose worktree was cleaned up opens as its record: read only, with
// its Terminal and Files off and saying why.

export const WORKER_PANE_TEST_ID = "beside-dock";

interface Tool {
  readonly id: BesideTab;
  readonly label: string;
  readonly icon: LucideIcon;
  /** A count or number after its name: "3", "#142". */
  readonly count?: string | undefined;
  /** Why it can't be used now; it is off while this is set. */
  readonly off?: string | undefined;
}

/** Why Terminal and Files are off for a worker kept only as its record. */
export const WORKTREE_GONE = "Worktree cleaned up";
/** Why PR is off for a worker without one. */
export const NO_PR_YET = "No pull request yet";
/** Why Changes and PR are off for a worker that works in no repository. */
export const NO_REPOSITORY = "Not in a git repository";

/** The tools of a live worker, from its git state. */
const liveTools = (
  git: { repo: boolean; changedFiles: number; pr?: { number: number } } | undefined,
): readonly Tool[] => {
  const outside = git !== undefined && !git.repo;
  return [
    { id: "thread", label: "Conversation", icon: MessageSquare },
    {
      id: "changes",
      label: "Changes",
      icon: FileDiff,
      count: git !== undefined && git.changedFiles > 0 ? String(git.changedFiles) : undefined,
      off: outside ? NO_REPOSITORY : undefined,
    },
    {
      id: "pr",
      label: "PR",
      icon: GitPullRequest,
      count: git?.pr === undefined ? undefined : `#${git.pr.number}`,
      off: outside ? NO_REPOSITORY : git?.pr === undefined ? NO_PR_YET : undefined,
    },
    { id: "terminal", label: "Terminal", icon: SquareTerminal },
    { id: "files", label: "Files", icon: FolderTree },
  ];
};

/**
 * The tools of a worker kept only as its record: its Changes from the same record its summary
 * counts, so the two never disagree, its PR while it had one, and no Terminal or Files.
 */
export const recordTools = (detail: FinishedWorkerDetail | undefined): readonly Tool[] => {
  const pr = detail?.worker.prs[0];
  return [
    { id: "thread", label: "Conversation", icon: MessageSquare },
    {
      id: "changes",
      label: "Changes",
      icon: FileDiff,
      count:
        detail === undefined || detail.files.length === 0 ? undefined : String(detail.files.length),
    },
    {
      id: "pr",
      label: "PR",
      icon: GitPullRequest,
      count: pr === undefined ? undefined : `#${pr.number}`,
      off: pr === undefined ? NO_PR_YET : undefined,
    },
    { id: "terminal", label: "Terminal", icon: SquareTerminal, off: WORKTREE_GONE },
    { id: "files", label: "Files", icon: FolderTree, off: WORKTREE_GONE },
  ];
};

/** A worker kept only as its record, from what Gram kept of it. */
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

/** Whether a key press is typing: in a field that holds something, where Esc is the field's. */
const typedIn = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return target.value !== "";
  }
  return target.isContentEditable && (target.textContent ?? "").trim() !== "";
};

/** Whether a key press is in a field at all, where the arrows move the caret. */
const inField = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable);

/** Back to the list, asking it to put back its place. */
export function goBackToWorkers(): void {
  useWorkersPanelStore.setState({ restore: true });
  backToWorkers();
}

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
  const git = summary?.git;
  const tools = record ? recordTools(detail) : liveTools(git);
  // A tool that is off shows nothing: its conversation does instead.
  const shownTab = tools.find((tool) => tool.id === tab && tool.off === undefined)?.id ?? "thread";
  const before = neighbour(order, worker, -1);
  const after = neighbour(order, worker, 1);
  const step = (row: PanelRow | undefined) => {
    if (row !== undefined) openWorker(row, PLAIN);
  };
  // Its keys while focus or the last press is in it; a press anywhere else gives them back.
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

  // Esc goes back, with the keys in the pane and nothing typed; a menu or field that took it first
  // keeps it. It is marked as handled, never stopped: an app around Gram skips a handled Esc.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.repeat) return;
    if (typedIn(event.target)) return;
    event.preventDefault();
    goBackToWorkers();
  };
  // ↑ ↓ on its head (the crumb, the state line, the tools): the worker before or after.
  const onHeadKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.shiftKey || inField(event.target)) return;
    const row = event.key === "ArrowUp" ? before : after;
    event.preventDefault();
    step(row);
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
                className={ICON_BUTTON}
              />
            }
          >
            <ChevronLeft aria-hidden className="size-icon-row" />
          </Hint>
          <button
            type="button"
            data-testid="beside-crumb"
            onClick={goBackToWorkers}
            className="shrink-0 rounded-xs px-1 text-body text-muted-foreground outline-none hover:text-foreground focus-visible:focus-ring"
          >
            {word}
          </button>
          <ChevronRight aria-hidden className="size-icon-chip shrink-0 text-muted-foreground" />
          <Switcher
            title={title}
            worker={worker}
            groups={groups}
            word={word}
            onPick={(row) => openWorker(row, PLAIN)}
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
        {record ? <RecordLine detail={detail} /> : <StateLine worker={worker} />}
        <ToolRow tools={tools} shown={shownTab} onPick={setTab} />
      </header>
      <ToolBody
        tool={shownTab}
        worker={worker}
        record={record}
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

/** ↗: the worker in the main view, in the orchestrator's place; the pane closes. */
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

/**
 * A live worker's state in one line: its status, its PR chips and its plan's steps, then its agent
 * and when it was last active, kept together so they wrap as one.
 */
function StateLine({ worker }: { worker: ThreadId }) {
  const summary = useThreadsStore((s) => s.byId[worker]);
  const detail = useThreadsStore((s) => s.statusDetail[worker]);
  const chips = useWorkerPrChips(worker, NO_PRS);
  const { headline } = useThreadHeadline(worker);
  const now = useNow(true, undefined, 60_000);
  if (summary === undefined) return null;
  const display = threadStatusOf(summary, detail);
  const agent = summary.thread.model?.agent;
  const active = summary.thread.lastActivityAt;
  return (
    <div
      data-testid="beside-state"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-1 text-meta text-muted-foreground"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Swap swapKey={display.label}>
          <display.icon
            aria-hidden
            data-working={display.working}
            className={cn("size-icon-row shrink-0", display.tone)}
          />
        </Swap>
        <span className="truncate">{display.label}</span>
      </span>
      <WorkerPrChips
        threadId={worker}
        cardPrs={NO_PRS}
        chips={chips}
        dense
        foldMerged
        className="flex shrink-0 items-center"
      />
      {headline !== undefined && headline.total > 0 && (
        <PlanSteps done={headline.done} total={headline.total} />
      )}
      <AgentAge agent={agent} at={active} now={now} />
    </div>
  );
}

/** "Claude · active 14m", one piece that never breaks between the agent and the age. */
function AgentAge({
  agent,
  at,
  now,
  stamp = false,
}: {
  agent: string | undefined;
  at: number | undefined;
  now: number;
  /** The time it was, for a finished worker, rather than how long ago. */
  stamp?: boolean;
}) {
  if (agent === undefined && at === undefined) return null;
  return (
    <span
      data-testid="beside-agent-age"
      className="flex shrink-0 items-center gap-1 whitespace-nowrap"
    >
      {agent !== undefined && <AgentIcon agent={agent} className="size-icon-chip" />}
      {[
        ...(agent === undefined ? [] : [agentLabel(agent)]),
        ...(at === undefined ? [] : [`active ${stamp ? formatStamp(at, now) : agoText(at, now)}`]),
      ].join(" · ")}
    </span>
  );
}

/** A record's state in one line: merged or cleaned up and when, its PRs, its agent. */
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

/**
 * The worker's tools, one row: each named, with its count; one that is off says why on hover and
 * to a screen reader, and stays reachable by the keys so the reason is too. ← → move along it.
 */
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
            // Picking a tool by pointer leaves the keyboard where it was (the chat's composer).
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!off) onPick(tool.id);
            }}
            className={cn(
              "flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring",
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

/** What a tool shows for the worker; a record's from what Gram kept. */
function ToolBody({
  tool,
  worker,
  record,
  detail,
  loading,
  title,
  focused,
}: {
  tool: BesideTab;
  worker: ThreadId;
  record: boolean;
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
            <FinishedFiles detail={detail} />
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
      return (
        <ThreadView
          key={worker}
          threadId={worker}
          focused={focused}
          beside={{ header: null, placeholder: `Steer ${title}…`, takeoverNoted: true }}
        />
      );
    case "terminal":
      return <LiveTerminal threadId={worker} />;
    case "changes":
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

/** An open with no ⌘ or Ctrl held: in the pane. */
const PLAIN = { metaKey: false, ctrlKey: false } as const;

/**
 * The open worker's title, which opens every worker of the orchestrator by group: a box to type in
 * narrows them, ↑ ↓ move, ⏎ opens, Esc closes and gives the keys back to the title.
 */
function Switcher({
  title,
  worker,
  groups,
  word,
  onPick,
}: {
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
            <div id={listId} role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1">
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
