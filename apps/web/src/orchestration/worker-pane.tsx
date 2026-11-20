import { Popover } from "@base-ui/react/popover";
import type {
  BoundPr,
  FinishedWorkerDetail,
  GitState,
  ThreadId,
  WorkspaceId,
} from "@gram/contracts";
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
  type RefObject,
} from "react";

import { AgentIcon, agentLabel } from "@/agents/agent-display";
import { useApi } from "@/api/context";
import { Hint } from "@/components/hint";
import { worktreeMissing } from "@/components/worktree-missing";
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
import { focusWhenRendered } from "@/shell/focus-regions";
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
  WORKER_PANE_TEST_ID,
  type BesideTab,
} from "./beside-store";
import { FinishedFiles, FinishedWorkerView } from "./finished-worker-view";
import { shownPrNumbers, useWorkerPrChips, WorkerPrChips } from "./overview-pr-chips";
import { nowBesidePrs } from "./rail-model";
import { StatusDot } from "./status-dot";
import { STATUS_WORDS } from "./status-words";
import { PlanSteps } from "./worker-row-wide";
import { finishedRow } from "./workers-model";
import { neighbour, rowsInOrder, type PanelRow, type StatusGroup } from "./workers-panel-model";
import { useOpenWorker, useWorkerGroups } from "./workers-panel";

// A worker open in the right pane, under "‹ Workers › its title": its state on one line, its own
// tools in one row under that (Conversation, Changes, PR, Terminal, Files), and its composer, which
// steers it. The orchestrator's chat stays in the main view beside it. Back (‹, the crumb, or Esc
// with the keys in the pane and nothing typed) returns to the list where it was; ↑ ↓ step to the
// worker before or after it in the list's order, and its title opens a switcher of every worker,
// by group. A finished worker is read only: no composer, its Terminal and Files off and saying why,
// and its Changes what its PR (or, its worktree cleaned up, its record) kept. Opening it from the
// pane's list, its switcher or ↑ ↓ puts the keys on its title, so Esc and ↑ ↓ work at once.

export { WORKER_PANE_TEST_ID };

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
/** Why Changes, Terminal and Files are off for a worker whose folder was deleted outside Gram. */
export const FOLDER_MISSING = "Its folder was deleted";
/** Why Terminal and Files are off for a finished worker whose worktree is still there. */
export const FINISHED = "Finished: read only";

/** What a worker's tools are offered by: where it works, its PR, and whether it is finished. */
export interface ToolFacts {
  readonly git: Pick<GitState, "repo" | "changedFiles" | "pr" | "missing" | "origin"> | undefined;
  /**
   * The PR the thread is bound to, which the PR tool opens: before its badge has loaded, and over
   * a badge that still names another PR.
   */
  readonly boundPr?: Pick<BoundPr, "repo" | "number"> | undefined;
  /** Finished (Done): read only, though its worktree may still be there. */
  readonly finished?: boolean;
  /** A finished worker's changed files as its PR lists them, once read. */
  readonly prFiles?: number | undefined;
}

/**
 * The tools of a worker with a thread, from its git state: PR only with a PR to open, Changes,
 * Terminal and Files only with a checkout to read them from, and a finished one's Terminal and
 * Files off. One that is off says why.
 */
export const liveTools = ({
  git,
  boundPr,
  finished = false,
  prFiles,
}: ToolFacts): readonly Tool[] => {
  const outside = git !== undefined && !git.repo;
  const missing = worktreeMissing(git as GitState | undefined);
  // The one its PR panel opens, its row's chip names and its head line shows.
  const pr = prTargetOf(git, boundPr)?.number;
  const changed = finished && prFiles !== undefined ? prFiles : (git?.changedFiles ?? 0);
  const noCheckout = missing ? FOLDER_MISSING : finished ? FINISHED : undefined;
  return [
    { id: "thread", label: "Conversation", icon: MessageSquare },
    {
      id: "changes",
      label: "Changes",
      icon: FileDiff,
      count: changed > 0 ? String(changed) : undefined,
      // A finished one's from its PR, which needs no checkout.
      off: outside
        ? NO_REPOSITORY
        : missing && !(finished && prFiles !== undefined)
          ? FOLDER_MISSING
          : undefined,
    },
    {
      id: "pr",
      label: "PR",
      icon: GitPullRequest,
      count: pr === undefined ? undefined : `#${pr}`,
      off: outside ? NO_REPOSITORY : pr === undefined ? NO_PR_YET : undefined,
    },
    { id: "terminal", label: "Terminal", icon: SquareTerminal, off: noCheckout },
    { id: "files", label: "Files", icon: FolderTree, off: noCheckout },
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

/** Whether the keys are on something of the pane's, other than the pane itself or a disabled button. */
const heldInPane = (root: HTMLElement | null): boolean => {
  const held = document.activeElement;
  return (
    held instanceof HTMLElement &&
    held !== root &&
    root?.contains(held) === true &&
    !(held instanceof HTMLButtonElement && held.disabled)
  );
};

/** Whether a key press is in a field at all, where the arrows move the caret. */
const inField = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable);

/** Back to the list, which puts back its place and the keys on the current worker's row. */
export const goBackToWorkers = backToWorkers;

/** The files a finished worker's PR changed, from the query (and cache) the PR panel reads. */
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

/** Whether a key press in the pane would lose something typed: its composer holds a draft. */
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
  // Done in the list (merged, completed), else completed by its thread: read only either way.
  const finished =
    !record &&
    (row !== undefined ? row.source.tab === "done" : summary?.thread.completedAt !== undefined);
  const prFiles = usePrFiles(worker, finished);
  const tools = record
    ? recordTools(detail)
    : liveTools({
        git,
        boundPr: summary?.thread.boundPr,
        finished,
        prFiles: prFiles?.length,
      });
  // A tool that is off shows nothing: its conversation does instead.
  const shownTab = tools.find((tool) => tool.id === tab && tool.off === undefined)?.id ?? "thread";
  const before = neighbour(order, worker, -1);
  const after = neighbour(order, worker, 1);
  // Stepping keeps the tool shown, where the next worker has it.
  const step = (next: PanelRow | undefined) => {
    if (next !== undefined) openWorker(next, PLAIN, KEEP_TOOL);
  };
  // Opened from the pane's list, its switcher or ↑ ↓: the keys on its title once drawn, unless
  // they are on something of the pane's already (the tool they stepped from).
  const takeKeys = useBesideStore((s) => s.takeKeys);
  useEffect(() => {
    if (!takeKeys) return;
    useBesideStore.setState({ takeKeys: false });
    if (heldInPane(root.current)) return;
    void focusWhenRendered(() => titleRef.current);
  }, [takeKeys]);
  // A link in the pane opened one of its tools: the keys stay where they were, and if the link went
  // with the view it was in, they go to the shown tool's tab, where Esc and ↑ ↓ work.
  const toolKeys = useBesideStore((s) => s.toolKeys);
  useEffect(() => {
    if (!toolKeys) return;
    useBesideStore.setState({ toolKeys: false });
    void focusWhenRendered(() => {
      if (heldInPane(root.current)) return document.activeElement as HTMLElement;
      return root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? null;
    });
  }, [toolKeys]);
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
    // Something typed keeps it, in the field or in the composer below.
    if (typedIn(event.target) || draftIn(root.current)) return;
    event.preventDefault();
    goBackToWorkers();
  };
  // ↑ ↓ on its head (the crumb, the state line, the tools): the worker before or after.
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
          {/* ‹ and the list's name are one way back: one target, one stop for the keys. */}
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
        {record ? <RecordLine detail={detail} /> : <StateLine worker={worker} row={row} />}
        <ToolRow tools={tools} shown={shownTab} onPick={setTab} />
      </header>
      <ToolBody
        tool={shownTab}
        worker={worker}
        record={record}
        finished={finished}
        prFiles={prFiles}
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
 * A live worker's state in one line, in its sidebar row's order: its mark, its PR chips, then its
 * status in the list's own words less the PRs the chips name (each said once), its plan's steps,
 * then its agent and when it was last active, kept together so they wrap as one. At work, what its
 * thread runs.
 */
function StateLine({ worker, row }: { worker: ThreadId; row: PanelRow | undefined }) {
  const summary = useThreadsStore((s) => s.byId[worker]);
  const detail = useThreadsStore((s) => s.statusDetail[worker]);
  const chips = useWorkerPrChips(worker, NO_PRS);
  const { headline } = useThreadHeadline(worker);
  const now = useNow(true, undefined, 60_000);
  if (summary === undefined) return null;
  const display = threadStatusOf(summary, detail);
  const agent = summary.thread.model?.agent;
  const active = summary.thread.lastActivityAt;
  const status = row === undefined || display.working ? display.label : row.status;
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
      />
      <span data-testid="beside-status" className="min-w-0 truncate" title={status}>
        {nowBesidePrs(status, shownPrNumbers(chips, true))}
      </span>
      {headline !== undefined && headline.total > 0 && (
        <PlanSteps done={headline.done} total={headline.total} />
      )}
      <AgentAge agent={agent} at={active} now={now} />
    </div>
  );
}

/**
 * Its agent's mark (named on hover and to a screen reader) and "active 14m ago": one short piece
 * that never breaks, so it fits the state line beside the words and chips.
 */
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
            // A click leaves the keys in a field outside the pane (the chat's composer), where
            // someone types; anywhere else they go to the tab clicked, so ← → move on from it.
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

/** A tool picked by pointer leaves the keys where they are when they are in a field outside the pane. */
const keepsKeys = (held: Element | null, row: HTMLElement | null): boolean =>
  inField(held) && row?.closest(`[data-testid="${WORKER_PANE_TEST_ID}"]`)?.contains(held) !== true;

/** What a tool shows for the worker; a record's from what Gram kept. */
function ToolBody({
  tool,
  worker,
  record,
  finished,
  prFiles,
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
            beside={{ header: null, readOnly: true }}
          />
        </ReadOnlyTranscript.Provider>
      ) : (
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
      // A finished worker's, as its PR lists them: its branch is merged, its tree clean.
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

/** Its head's PR chip opens its PR tool here, the PR the tool names, the orchestrator staying. */
const openPrTool = () => useBesideStore.getState().setTab("pr");

/** An open with no ⌘ or Ctrl held: in the pane. */
const PLAIN = { metaKey: false, ctrlKey: false } as const;
/** ↑ ↓ and the switcher keep the tool shown. */
const KEEP_TOOL = { keepTool: true } as const;

/**
 * The open worker's title, which opens every worker of the orchestrator by group: a box to type in
 * narrows them, ↑ ↓ move, ⏎ opens, Esc closes and gives the keys back to the title.
 */
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
  // The option the keys are on stays in the list's view as they move.
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
