import type { DeliveredDigest, Thread, WorkspaceId } from "@gram/contracts";
import { useMemo, type ReactNode } from "react";

import { Hint } from "@/components/hint";
import { Switch } from "@/components/ui/switch";
import { useHistoryStore } from "@/history/history-view";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { useAllActivity } from "@/stores/all-activity";
import { useThreadsStore } from "@/stores/threads";
import { trackWrappedRow } from "@/thread/header-chips";

import { useOpenBoard } from "./open-board";
import { SinceYouLeft } from "./since-you-left";
import { statusHeaderCounts, type HeaderWorker } from "./status-header-model";
import { useOrchestratorLedgers } from "./use-orchestration";
import { showWorkersTab } from "./workers-tab";
import { workersByTab } from "./workers-model";

/** Every item's shape: a quiet button that opens the view behind its count. */
const ITEM =
  "flex h-7 min-w-7 shrink-0 items-center gap-1 rounded-sm px-1.5 text-meta text-muted-foreground tabular-nums outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/**
 * A count in the foreground, its word muted. The word is always there, in full: short of room the
 * strip drops whole items from its end rather than words, so a number never stands alone and no
 * two counts read the same ("6 merged" beside "2 merged").
 */
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
      <span data-testid="status-word">{word}</span>
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

/**
 * The orchestrator's status header: one compact row at the top of its chat that is always current
 * and never a message. Running, In review and Merged today, each opening the view it counts (⌘J's
 * Now, the Board, History), then "Since you left" while there is an absence to sum up, and the
 * switch that shows every digest and reply in the chat. Names are on hover. What needs you is not
 * repeated here: the sidebar's pill counts it across every workspace (here and elsewhere on its
 * hover) and the workspace's line its own share. The subscription limit is the title bar's.
 * Background events change these counts rather than adding to the transcript.
 */
export function StatusHeader({
  thread,
  digests,
}: {
  thread: Thread;
  /** The digests the orchestrator was given, which "Since you left" folds; none before they load. */
  digests?: readonly DeliveredDigest[] | undefined;
}) {
  const workspaceId = thread.workspaceId;
  if (thread.role !== "orchestrator" || workspaceId === undefined) return null;
  return <StatusStrip thread={thread} workspaceId={workspaceId} digests={digests} />;
}

function StatusStrip({
  thread,
  workspaceId,
  digests,
}: {
  thread: Thread;
  workspaceId: WorkspaceId;
  digests: readonly DeliveredDigest[] | undefined;
}) {
  const threadId = thread.id;
  const ids = useMemo(() => [workspaceId], [workspaceId]);
  const ledger = useOrchestratorLedgers(ids).get(workspaceId);
  const byId = useThreadsStore((s) => s.byId);
  const statusDetail = useThreadsStore((s) => s.statusDetail);
  // Minute resolution is enough for "today" and the hover's lines.
  const now = useNow(true, undefined, 60_000);
  const counts = useMemo(
    () => statusHeaderCounts(workersByTab(ledger, { byId, statusDetail, now }), now),
    [ledger, byId, statusDetail, now],
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
      className="@container relative flex min-w-0 shrink-0 items-center border-b border-border px-2 py-0.5"
    >
      {/* The items wrap, the fixed height hides every line after the first, and what wraps is
          inert: short of room, whole items go from the end, never their words. */}
      <div
        ref={trackItems}
        data-testid="status-items"
        className="flex h-7 min-w-0 flex-1 flex-wrap items-center gap-x-inset gap-y-4 overflow-hidden"
      >
        <Item
          testId="status-running"
          label={`${running} running, open Workers`}
          hint={<WorkersHint title="Running" workers={counts.running} />}
          onClick={showWorkersTab}
        >
          <Count n={running} word="running" />
        </Item>
        <Item
          testId="status-review"
          label={`${review} in review, open the Board`}
          hint={<WorkersHint title="In review" workers={counts.inReview} />}
          onClick={() => openBoard(workspaceId)}
        >
          <Count n={review} word="in review" />
        </Item>
        <Item
          testId="status-merged"
          label={`${merged} merged today, open History`}
          hint={<WorkersHint title="Merged today" workers={counts.mergedToday} />}
          onClick={() => useHistoryStore.getState().show("workers")}
        >
          <Count n={merged} word="merged today" />
        </Item>
        {digests !== undefined && (
          <SinceYouLeft key={`since-you-left:${threadId}`} thread={thread} digests={digests} />
        )}
      </div>
      <AllActivitySwitch threadId={threadId} on={all} />
    </div>
  );
}

/** The room between the last count shown and the switch. */
const SWITCH_GAP_PX = 12;

/**
 * Puts the switch just after the counts the row still shows, not at the strip's end, where the
 * title bar's "…" opens over it. The row keeps the switch's room at its end, so where the switch
 * goes never changes what fits: the counts wrap by the row's width alone.
 */
function placeSwitch(row: HTMLDivElement) {
  const control = row.nextElementSibling;
  if (!(control instanceof HTMLElement)) return;
  // Only when it changes: a new padding resizes the row, which runs this again.
  const room = `${control.offsetWidth + SWITCH_GAP_PX}px`;
  if (row.style.paddingInlineEnd !== room) row.style.paddingInlineEnd = room;
  const start = row.getBoundingClientRect().left;
  let end = 0;
  for (const child of row.children) {
    if (child instanceof HTMLElement && !child.inert)
      end = Math.max(end, child.getBoundingClientRect().right - start);
  }
  const left = `${row.offsetLeft + end + (end > 0 ? SWITCH_GAP_PX : 0)}px`;
  if (control.style.left !== left) control.style.left = left;
}

/** The counts' row: what wraps goes inert, and the switch follows what stays. */
const trackItems = (row: HTMLDivElement | null) => trackWrappedRow(row, placeSwitch);

/** Folded (off) or every digest and reply (on): only the chat's view of them changes. */
function AllActivitySwitch({ threadId, on }: { threadId: Thread["id"]; on: boolean }) {
  const id = `all-activity-${threadId}`;
  return (
    <div
      data-testid="status-all-activity-control"
      // Placed beside the counts by `placeSwitch`.
      className="absolute top-1/2 flex -translate-y-1/2 items-center gap-1.5 text-meta text-muted-foreground"
    >
      {/* Narrow, its words shorten but stay: a switch alone says nothing. */}
      <label htmlFor={id} className="cursor-default">
        <span className="@max-2xl:hidden">Show all activity</span>
        <span className="hidden @max-2xl:inline">All activity</span>
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
