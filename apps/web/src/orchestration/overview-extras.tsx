import type { FinishedWorker, WorkspaceId } from "@gram/contracts";
import { useQueries } from "@tanstack/react-query";
import { Fragment, useMemo } from "react";

import { useApi } from "@/api/context";
import { openExternalUrl } from "@/api/open-external";
import { PrMarkIcon } from "@/components/pr-marks";
import { prMarksOf, prTooltipOf, worstPrMark } from "@/components/pr-marks-model";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { useOpenPrRows } from "@/reviews/open-prs";
import { useReviewRequests } from "@/reviews/review-requests";
import { LimitBar, useLimitsNow } from "@/shell/usage-meter";
import { useOpenThread } from "@/shell/thread-switcher";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { useSame } from "@/stores/use-same";
import { useUsageLimits } from "@/stores/usage-limits";
import { useViewWorkspace } from "@/views/view-workspace";

import {
  doneTodayRows,
  footMeters,
  overviewPrRows,
  PR_KIND_LABEL,
  prSubLine,
  workerSlots,
  type DoneTodayRow,
  type OverviewPrRow,
} from "./overview-extras-model";
import { ROW, Section, SETTLED, STOP } from "./overview-section";
import { useOrchestratorLedger, useOrchestratorLedgers, useWorkspaces } from "./use-orchestration";

// The overview sidebar's extras: Pull requests and Done
// today, folded until opened and gone with nothing in them, and the usage meters and worker slots
// at its foot, off by default. Each reads what ⌘J and the title bar's meter read, so they all say
// the same.

/**
 * The review requests and the user's open PRs in one-line rows, under a sub-heading each when both
 * are there; a click opens the PR on GitHub, as there. A list placed nowhere is left out here too,
 * and with nothing to list the section stays away.
 */
export function OverviewPullRequests() {
  const { data: requests } = useReviewRequests();
  const own = useOpenPrRows();
  const reviewsShown = useLayoutStore((s) => s.reviewRequestsPlacement !== "hidden");
  const ownShown = useLayoutStore((s) => s.openPrsPlacement !== "hidden");
  const rows = useMemo(
    () =>
      overviewPrRows(requests?.requests ?? [], own.rows, { reviews: reviewsShown, own: ownShown }),
    [requests, own.rows, reviewsShown, ownShown],
  );
  if (rows.length === 0) return null;
  const both = rows[0]?.kind !== rows.at(-1)?.kind;
  return (
    <Section id="pullRequests" title="Pull requests" count={rows.length}>
      {rows.map((row, i) => (
        <Fragment key={row.key}>
          {both && rows[i - 1]?.kind !== row.kind && (
            <h3
              data-testid="overview-pr-kind"
              className="px-1.5 pt-1 pb-0.5 text-xs font-medium text-muted-foreground"
            >
              {PR_KIND_LABEL[row.kind]}
            </h3>
          )}
          <PrRow row={row} />
        </Fragment>
      ))}
    </Section>
  );
}

/**
 * A PR on one line: its worst mark in the vocabulary (`worstPrMark`) and its title. Its tooltip and
 * name say the rest: `repo#n · author`, which list it is on and every mark.
 */
function PrRow({ row }: { row: OverviewPrRow }) {
  const api = useApi();
  const sub = prSubLine(row);
  const marks = useMemo(() => prMarksOf(row.facts), [row.facts]);
  const worst = worstPrMark(marks);
  const label = PR_KIND_LABEL[row.kind];
  const words = worst.group === "state" ? row.glyph.word : `${row.glyph.word}, ${worst.mark.word}`;
  return (
    <button
      type="button"
      {...{ [STOP]: "" }}
      data-testid="overview-pr"
      data-kind={row.kind}
      data-ref={row.ref}
      data-pr={row.pr}
      aria-label={`Open ${row.ref} on GitHub: ${row.title}, ${words}, ${sub}, ${label}`}
      title={`${label} · ${sub}\n${prTooltipOf(row.facts, marks)}`}
      onClick={() => void openExternalUrl(api, row.url).catch(() => {})}
      className={ROW}
    >
      <span
        data-testid="overview-pr-glyph"
        data-state={row.glyph.kind}
        data-worst={worst.mark.kind}
        className="flex justify-self-center"
      >
        <PrMarkIcon group={worst.group} mark={worst.mark} />
      </span>
      <span data-testid="overview-pr-title" className="col-span-2 truncate">
        {row.title}
      </span>
    </button>
  );
}

/** Every workspace's workers closed since the cleanup sweep, as ⌘J reads them; cached alike. */
function useFinishedWorkersOf(ids: readonly WorkspaceId[]) {
  const api = useApi();
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: ["finishedWorkers", id],
      queryFn: () => api.finishedWorkers(id),
      retry: false,
      staleTime: 30_000,
    })),
    combine: (results) =>
      new Map<WorkspaceId, readonly FinishedWorker[] | undefined>(
        ids.map((id, i) => [id, results[i]?.data]),
      ),
  });
}

/**
 * The workers that finished today in every workspace, as ⌘J's Done today lists each, latest first,
 * one line each; a click opens one as ⌘J does. With none, the section stays away.
 */
export function OverviewDoneToday() {
  const workspaces = useWorkspaces();
  const ids = useMemo(() => workspaces.map((state) => state.workspace.id), [workspaces]);
  const ledgers = useOrchestratorLedgers(ids);
  const finished = useFinishedWorkersOf(ids);
  // Minute resolution is enough for "today" and the times rows show.
  const now = useNow(true, undefined, 60_000);
  const sources = useMemo(
    () =>
      workspaces.map((state) => ({
        workspaceId: state.workspace.id,
        name: state.workspace.name,
        ledger: ledgers.get(state.workspace.id),
        finished: finished.get(state.workspace.id),
      })),
    [workspaces, ledgers, finished],
  );
  // Only the rows: a thread's change that leaves them reading the same leaves the section still.
  const rows = useThreadsStore(
    useSame((s) => doneTodayRows(sources, { byId: s.byId, statusDetail: s.statusDetail, now })),
  );
  if (rows.length === 0) return null;
  return (
    <Section id="doneToday" title="Done today" count={rows.length}>
      {rows.map((row) => (
        <DoneRow key={row.threadId} row={row} />
      ))}
    </Section>
  );
}

/** A finished worker: grey until hovered, which says its workspace and what became of it. */
function DoneRow({ row }: { row: DoneTodayRow }) {
  const openThread = useOpenThread();
  return (
    <button
      type="button"
      {...{ [STOP]: "" }}
      data-testid="overview-done"
      data-thread-id={row.threadId}
      data-workspace-id={row.workspaceId}
      data-merged={row.merged || undefined}
      aria-label={`${row.title}, ${row.sub}, ${row.time}`}
      title={row.sub}
      onClick={() => openThread(row.threadId)}
      className={cn(ROW, SETTLED)}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 justify-self-center rounded-full",
          row.merged ? "bg-merged" : "bg-muted-foreground/60",
        )}
      />
      <span data-testid="overview-done-title" className="truncate">
        {row.title}
      </span>
      <span data-testid="overview-done-time" className="text-xs text-muted-foreground tabular-nums">
        {row.time}
      </span>
    </button>
  );
}

/**
 * The foot: each provider's 5-hour meter, from the title bar meter's readings, and the worker slots
 * of the workspace the window is on, against its cap, with the briefs held for later. Grey, but
 * for the warning colour the title bar's meter takes near a limit.
 */
export function OverviewFoot() {
  const limits = useUsageLimits((s) => s.limits);
  const now = useLimitsNow(limits);
  const meters = footMeters(limits, now);
  const workspace = useViewWorkspace();
  const { data: ledger } = useOrchestratorLedger(workspace?.workspace.id);
  const slots =
    ledger === undefined ? undefined : workerSlots(ledger.budget, ledger.held?.length ?? 0);
  if (meters.length === 0 && slots === undefined) return null;
  return (
    <div
      data-testid="overview-foot"
      className="grid shrink-0 gap-2 border-t border-border px-3.5 pt-2.5 pb-3 text-xs text-muted-foreground tabular-nums"
    >
      {meters.map((meter) => (
        <div
          key={meter.provider}
          data-testid="overview-usage"
          data-provider={meter.provider}
          data-warn={meter.warns || undefined}
          aria-label={`${meter.name} 5-hour limit ${meter.percent}% used${meter.resets === undefined ? "" : `, resets ${meter.resets}`}`}
          className={cn(
            "grid grid-cols-[3.25rem_minmax(0,1fr)_auto] items-center gap-2",
            meter.warns && "text-warning",
          )}
        >
          <span>{meter.name}</span>
          <LimitBar limit={meter.limit} />
          <span data-testid="overview-usage-text">
            {meter.percent}%{meter.resets === undefined ? "" : ` · ${meter.resets}`}
          </span>
        </div>
      ))}
      {slots !== undefined && (
        <div
          data-testid="overview-slots"
          data-live={slots.live}
          data-cap={slots.cap}
          data-held={slots.held}
          className="flex items-center justify-between gap-2"
        >
          <span>Worker slots</span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-flex items-center gap-0.75">
              {slots.pips.map((taken, i) => (
                <i
                  key={i}
                  data-taken={taken || undefined}
                  className={cn(
                    "block size-1.5 rounded-[2px]",
                    taken ? "bg-muted-foreground" : "bg-border",
                  )}
                />
              ))}
            </span>
            <span data-testid="overview-slots-text">{slots.text}</span>
          </span>
        </div>
      )}
    </div>
  );
}
