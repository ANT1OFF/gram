import type { Thread, WorkspaceId } from "@gram/contracts";
import { Link } from "@tanstack/react-router";
import { ChartNoAxesCombined, Eye, GitMerge, Inbox, Workflow } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { Hint } from "@/components/hint";
import { Switch } from "@/components/ui/switch";
import { useHistoryStore } from "@/history/history-view";
import { showInbox } from "@/inbox/inbox-store";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { LimitBar, useLimitsNow } from "@/shell/usage-meter";
import { useAllActivity } from "@/stores/all-activity";
import { useThreadsStore } from "@/stores/threads";
import { limitTone, tightestLimit, useUsageLimits } from "@/stores/usage-limits";
import { limitSummaryText, meterText, resetText } from "@/usage/limit-format";

import { useOpenBoard } from "./open-board";
import { namesText, statusHeaderCounts, type HeaderWorker } from "./status-header-model";
import { useNeedsYouList } from "./use-needs-you";
import { useOrchestratorLedgers } from "./use-orchestration";
import { useWorkersListStore } from "./workers-list";
import { workersByTab } from "./workers-model";

/** Every item's shape: a quiet button that opens the view behind its count. */
const ITEM =
  "flex h-7 min-w-7 shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-meta text-muted-foreground tabular-nums outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/** A count in the foreground, its word muted; the word drops first when the pane is narrow. */
function Count({
  n,
  word,
  className,
}: {
  n: number;
  word: string;
  className?: string | undefined;
}) {
  return (
    <>
      <span data-testid="status-count" className={cn("font-medium text-foreground", className)}>
        {n}
      </span>
      <span className="@max-3xl:hidden">{word}</span>
    </>
  );
}

/** A hover's list of workers, each with where it stands: "Faster cold start · Editing code". */
function WorkersHint({ title, workers }: { title: string; workers: readonly HeaderWorker[] }) {
  return (
    <div className="flex max-w-80 flex-col gap-0.5 text-meta">
      <span className="font-medium">{title}</span>
      {workers.length === 0 ? (
        <span className="text-muted-foreground">None now</span>
      ) : (
        workers.map((worker) => (
          <span key={worker.threadId} data-testid="status-hint-worker" className="truncate">
            {worker.title}
            {worker.now !== "" && <span className="text-muted-foreground"> · {worker.now}</span>}
          </span>
        ))
      )}
    </div>
  );
}

function Item({
  testId,
  label,
  hint,
  onClick,
  children,
}: {
  testId: string;
  /** The accessible name: the count and what it opens. */
  label: string;
  hint: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Hint
      label={hint}
      side="bottom"
      render={
        <button
          type="button"
          data-testid={testId}
          aria-label={label}
          className={ITEM}
          onClick={onClick}
        />
      }
    >
      {children}
    </Hint>
  );
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * The orchestrator's status header: a compact strip at the top of its chat that is always current
 * and never a message. Running, Waiting on you, In review and Merged today, each opening the view it
 * counts (⌘J's Now, Needs you, the Board, History), the tightest subscription limit as a small
 * meter, and the switch that shows every digest and reply in the chat. Background events change
 * these counts rather than adding to the transcript.
 */
export function StatusHeader({ thread }: { thread: Thread }) {
  const workspaceId = thread.workspaceId;
  if (thread.role !== "orchestrator" || workspaceId === undefined) return null;
  return <StatusStrip threadId={thread.id} workspaceId={workspaceId} />;
}

function StatusStrip({
  threadId,
  workspaceId,
}: {
  threadId: Thread["id"];
  workspaceId: WorkspaceId;
}) {
  const ids = useMemo(() => [workspaceId], [workspaceId]);
  const ledger = useOrchestratorLedgers(ids).get(workspaceId);
  const byId = useThreadsStore((s) => s.byId);
  const statusDetail = useThreadsStore((s) => s.statusDetail);
  // Minute resolution is enough for "today" and the hover's lines.
  const now = useNow(true, undefined, 60_000);
  const groups = useNeedsYouList().groups;
  const waiting = groups.find((group) => group.workspaceId === workspaceId)?.items.length ?? 0;
  const counts = useMemo(
    () => statusHeaderCounts(workersByTab(ledger, { byId, statusDetail, now }), waiting, now),
    [ledger, byId, statusDetail, now, waiting],
  );
  const openBoard = useOpenBoard();
  const all = useAllActivity((s) => s.shown.has(threadId));
  const running = counts.running.length;
  const review = counts.inReview.length;
  const merged = counts.mergedToday.length;

  return (
    <div
      role="region"
      aria-label="Workspace status"
      data-testid="status-header"
      className="@container flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-2 py-0.5"
    >
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
        <Item
          testId="status-running"
          label={`${running} running, open Workers`}
          hint={<WorkersHint title="Running" workers={counts.running} />}
          onClick={() => useWorkersListStore.getState().show("now")}
        >
          <Workflow
            aria-hidden
            className={cn("size-3.5 shrink-0", running > 0 && "text-status-working")}
          />
          <Count n={running} word="running" />
          {running > 0 && (
            <span
              data-testid="status-running-names"
              className="max-w-56 min-w-0 truncate @max-5xl:hidden"
            >
              {namesText(counts.running)}
            </span>
          )}
        </Item>
        <Item
          testId="status-waiting"
          label={`${waiting} waiting on you, open Inbox`}
          hint={
            waiting === 0
              ? "Nothing waits on you"
              : `${waiting} ${plural(waiting, "item waits", "items wait")} on you`
          }
          onClick={() => showInbox({ workspaceId })}
        >
          <Inbox
            aria-hidden
            className={cn("size-3.5 shrink-0", waiting > 0 && "text-status-needs-mark")}
          />
          <Count
            n={waiting}
            word="waiting on you"
            className={waiting > 0 ? "text-status-needs" : undefined}
          />
        </Item>
        <Item
          testId="status-review"
          label={`${review} in review, open the Board`}
          hint={<WorkersHint title="In review" workers={counts.inReview} />}
          onClick={() => openBoard(workspaceId)}
        >
          <Eye aria-hidden className="size-3.5 shrink-0" />
          <Count n={review} word="in review" />
        </Item>
        <Item
          testId="status-merged"
          label={`${merged} merged today, open History`}
          hint={<WorkersHint title="Merged today" workers={counts.mergedToday} />}
          onClick={() => useHistoryStore.getState().show("workers")}
        >
          <GitMerge aria-hidden className={cn("size-3.5 shrink-0", merged > 0 && "text-merged")} />
          <Count n={merged} word="merged today" />
        </Item>
        <LimitItem />
      </div>
      <AllActivitySwitch threadId={threadId} on={all} />
    </div>
  );
}

/** The tightest subscription limit as a small meter, toned as the title bar's; it opens Usage. */
function LimitItem() {
  const limits = useUsageLimits((s) => s.limits);
  const now = useLimitsNow(limits);
  const tightest = tightestLimit(limits, now);
  if (tightest === undefined) return null;
  const tone = limitTone(tightest.limit);
  const summary = limitSummaryText(tightest);
  const reset =
    tightest.limit.resetsAt === undefined
      ? ""
      : `, resets ${resetText(tightest.limit.resetsAt, now)}`;
  return (
    <Hint
      label={`${summary}${reset}`}
      side="bottom"
      render={
        <Link
          to="/usage"
          data-testid="status-limit"
          aria-label={`${summary}, open Usage`}
          className={cn(
            ITEM,
            tone === "warning" && "text-warning hover:text-warning",
            tone === "spent" && "text-destructive hover:text-destructive",
          )}
        />
      }
    >
      <ChartNoAxesCombined aria-hidden className="size-3.5 shrink-0" />
      <LimitBar limit={tightest.limit} className="w-8" />
      <span className="@max-4xl:hidden">{meterText(tightest)}</span>
    </Hint>
  );
}

/** Folded (off) or every digest and reply (on): only the chat's view of them changes. */
function AllActivitySwitch({ threadId, on }: { threadId: Thread["id"]; on: boolean }) {
  const id = `all-activity-${threadId}`;
  return (
    <div className="flex shrink-0 items-center gap-1.5 text-meta text-muted-foreground">
      <label htmlFor={id} className="cursor-default @max-2xl:sr-only">
        Show all activity
      </label>
      <Switch
        id={id}
        data-testid="status-all-activity"
        aria-label="Show all activity"
        checked={on}
        onCheckedChange={(checked) => useAllActivity.getState().set(threadId, checked)}
      />
    </div>
  );
}
