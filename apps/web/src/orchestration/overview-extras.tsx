import { Fragment, useEffect, useMemo, useState } from "react";

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
import { overviewSectionFolded, useLayoutStore, type DoneGrouping } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { useSame } from "@/stores/use-same";
import { limitSpent, useUsageLimits } from "@/stores/usage-limits";
import { RowMenuItems, rowMenuKeys, threadDragProps } from "@/thread/row-menu";
import { doneSoloThreads } from "@/views/solo-threads";
import { useViewWorkspace } from "@/views/view-workspace";

import { DoneGroupingMenu } from "./done-grouping-menu";
import { DONE_PAGE, doneWhen, doneWhenLong, doneWindow } from "./done-model";
import {
  doneRows,
  footMeters,
  overviewPrRows,
  PR_KIND_LABEL,
  prSubLine,
  workerSlots,
  type DoneRow,
  type OverviewPrRow,
} from "./overview-extras-model";
import { ROW, RowMenu, Section, SETTLED, STOP } from "./overview-section";
import { useFinishedWorkerPages } from "./use-finished-workers";
import { useOrchestratorLedger, useOrchestratorLedgers, useWorkspaces } from "./use-orchestration";

// The overview sidebar's extras: Pull requests and Done, folded until opened and gone with nothing
// in them, and the usage meters and worker slots at its foot, off by default. Each reads what ⌘J
// and the title bar's meter read, so they all say the same.

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

/**
 * Every finished chat, the workers of every workspace and the solo threads marked done, latest
 * first, by date or by orchestrator (`groupDone`), one line each; a click opens one. It shows a
 * page of `DONE_PAGE` rows and "Show more" adds the next, paged across the list; older finished
 * workers are read from the server only as the rows reach them. With none, the section stays away.
 */
export function OverviewDone() {
  const workspaces = useWorkspaces();
  const ids = useMemo(() => workspaces.map((state) => state.workspace.id), [workspaces]);
  const inWorkspace = useMemo(() => new Set<string>(ids), [ids]);
  const ledgers = useOrchestratorLedgers(ids);
  const pages = useFinishedWorkerPages(ids);
  const { finished, horizons, loadMore, busy } = pages;
  // Minute resolution is enough for the days and the times rows show.
  const now = useNow(true, undefined, 60_000);
  const by = useLayoutStore((s) => s.doneGrouping);
  const open = useLayoutStore((s) => !overviewSectionFolded(s, "doneToday"));
  const [limit, setLimit] = useState(DONE_PAGE);
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
    useSame((s) =>
      doneRows(sources, doneSoloThreads(Object.values(s.byId), inWorkspace), {
        byId: s.byId,
        statusDetail: s.statusDetail,
        now,
      }),
    ),
  );
  const shown = useMemo(
    () => doneWindow(rows, by, now, horizons, limit),
    [rows, by, now, horizons, limit],
  );
  // The page is short only because a workspace's older workers aren't read yet: read the next.
  // `loadMore` changes as each page lands, so this asks again while the page is still short.
  const waitsOn = open ? shown.load : undefined;
  useEffect(() => {
    if (waitsOn !== undefined && !busy) loadMore(waitsOn);
  }, [waitsOn, busy, loadMore]);
  if (rows.length === 0) return null;
  return (
    <Section
      id="doneToday"
      title="Done"
      count={rows.length}
      action={<DoneGroupingMenu stop={{ [STOP]: "" }} />}
    >
      {shown.groups.map((group) => (
        <Fragment key={group.key}>
          <h3
            data-testid="overview-done-group"
            data-grouping={by}
            className="px-1.5 pt-1 pb-0.5 text-xs font-medium text-muted-foreground"
          >
            {group.label}
          </h3>
          {group.rows.map((row) => (
            <OverviewDoneRow key={row.threadId} row={row} by={by} now={now} />
          ))}
        </Fragment>
      ))}
      {shown.more && (
        <button
          type="button"
          {...{ [STOP]: "" }}
          data-testid="overview-done-more"
          aria-busy={busy || undefined}
          onClick={() => setLimit((current) => current + DONE_PAGE)}
          className="rounded-(--radius-sm) px-1.5 py-1 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Show more
        </button>
      )}
    </Section>
  );
}

/**
 * A finished chat: grey until hovered, which says where it was and what became of it. A solo
 * thread keeps its menu and its drag into a pane, as its row in Solo threads had them.
 */
function OverviewDoneRow({ row, by, now }: { row: DoneRow; by: DoneGrouping; now: number }) {
  const openThread = useOpenThread();
  const when = doneWhen(row.finishedAt, by, now);
  const button = (
    <button
      type="button"
      {...{ [STOP]: "" }}
      {...(row.kind === "solo"
        ? {
            ...threadDragProps(row.threadId),
            onKeyDown: rowMenuKeys,
            "aria-keyshortcuts": "Shift+F10",
          }
        : {})}
      data-testid="overview-done"
      data-kind={row.kind}
      data-thread-id={row.threadId}
      data-workspace-id={row.workspaceId}
      data-merged={row.merged || undefined}
      aria-label={`${row.title}, ${row.sub}, ${doneWhenLong(row.finishedAt, now)}`}
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
        {when}
      </span>
    </button>
  );
  return row.kind === "solo" ? (
    <RowMenu menu={<RowMenuItems threadId={row.threadId} />}>{button}</RowMenu>
  ) : (
    button
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
            limitSpent(meter.limit) ? "text-destructive" : meter.warns && "text-warning",
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
