import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { History, Search } from "lucide-react";
import { Fragment, useMemo } from "react";

import { useApi } from "@/api/context";
import { recentDone, recentWhen, OUTCOME_LABEL, type RecentDone } from "@/history/history-model";
import { OUTCOME_GLYPH, useHistoryStore } from "@/history/history-view";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { openExternalUrl } from "@/api/open-external";
import { PrMarkIcon } from "@/components/pr-marks";
import { prMarksOf, prTooltipOf, worstPrMark } from "@/components/pr-marks-model";
import { useOpenPrRows } from "@/reviews/open-prs";
import { useReviewRequests } from "@/reviews/review-requests";
import { LimitBar, useLimitsNow } from "@/shell/usage-meter";
import { cn } from "@/lib/utils";
import { useNow } from "@/lib/use-now";
import { useOpenThread } from "@/shell/thread-switcher";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { useSame } from "@/stores/use-same";
import { RowMenuItems, rowMenuKeys, threadDragProps } from "@/thread/row-menu";
import { limitSpent, useUsageLimits } from "@/stores/usage-limits";
import { useViewWorkspace } from "@/views/view-workspace";

import {
  footMeters,
  overviewPrRows,
  PR_KIND_LABEL,
  prSubLine,
  workerSlots,
  type OverviewPrRow,
} from "./overview-extras-model";
import { ROW, RowMenu, Section, STOP } from "./overview-section";
import { useFinishedWorkerPages } from "./use-finished-workers";
import { useOrchestratorLedger, useOrchestratorLedgers, useWorkspaces } from "./use-orchestration";

// The overview sidebar's extras: Pull requests, folded until opened and gone with nothing in it, the
// way into History, and the usage meters and worker slots at its foot, off by default. Each reads
// what the title bar's meter and History read, so they all say the same.

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
 * Search, written out under the Needs you pill so it is found without knowing its shortcut: it
 * opens the command palette, which finds threads, workers and commands.
 */
export function OverviewSearch() {
  const hint = useShortcutHint("palette.open");
  const open = useLayoutStore((s) => s.paletteOpen);
  return (
    <button
      type="button"
      data-testid="overview-search"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-keyshortcuts={hint === "" ? undefined : hint}
      title={withHint("Search threads, workers and commands", hint)}
      onClick={() => useLayoutStore.getState().openPalette()}
      className="flex h-7 w-full shrink-0 items-center gap-2 rounded-(--radius-sm) px-2.5 text-left text-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:text-foreground"
    >
      <Search aria-hidden className="size-3.5 shrink-0" />
      <span className="flex-1">Search</span>
      {hint !== "" && <kbd className="font-sans text-xs tabular-nums">{hint}</kbd>}
    </button>
  );
}

/**
 * Done: the few chats that finished last, each one muted line with no status under it, so they
 * never compete with the live rows above. History, at the column's foot, has the rest.
 */
export function OverviewDone() {
  const api = useApi();
  const workspaces = useWorkspaces();
  const ids = useMemo(() => workspaces.map((state) => state.workspace.id), [workspaces]);
  const ledgers = useOrchestratorLedgers(ids);
  const { finished } = useFinishedWorkerPages(ids);
  const { data: projects } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  // Minute resolution is enough for the times rows show.
  const now = useNow(true, undefined, 60_000);
  const rows = useThreadsStore(
    useSame((s) =>
      recentDone({
        workspaces: workspaces.map((state) => ({
          workspaceId: state.workspace.id,
          name: state.workspace.name,
          ledger: ledgers.get(state.workspace.id),
          finished: finished.get(state.workspace.id),
        })),
        summaries: Object.values(s.byId).flatMap((each) => (each ? [each] : [])),
        projects: projects ?? NO_PROJECTS,
        facts: { byId: s.byId, statusDetail: s.statusDetail, now },
      }),
    ),
  );
  if (rows.length === 0) return null;
  return (
    <Section id="doneToday" title="Done" count={rows.length}>
      {rows.map((row) => (
        <DoneRow key={row.threadId} row={row} now={now} />
      ))}
    </Section>
  );
}

const NO_PROJECTS: readonly never[] = [];

/** A finished chat: its outcome's glyph, its title and when, all muted until hovered. */
function DoneRow({ row, now }: { row: RecentDone; now: number }) {
  const openThread = useOpenThread();
  const viewed = useParams({ strict: false }).threadId === row.threadId;
  const glyph = row.outcome === undefined ? undefined : OUTCOME_GLYPH[row.outcome];
  const word = row.outcome === undefined ? "finished" : OUTCOME_LABEL[row.outcome];
  const when = recentWhen(row.finishedAt, now);
  const Icon = glyph?.icon;
  return (
    <RowMenu menu={<RowMenuItems threadId={row.threadId} />}>
      <button
        type="button"
        {...{ [STOP]: "" }}
        {...threadDragProps(row.threadId)}
        data-testid="overview-done"
        data-thread-id={row.threadId}
        data-outcome={row.outcome}
        aria-current={viewed || undefined}
        aria-label={`${row.title}, ${row.place}, ${word}${when === "" ? "" : `, ${when}`}`}
        title={`${row.place} · ${word}`}
        aria-keyshortcuts="Shift+F10"
        onClick={() => openThread(row.threadId)}
        onKeyDown={rowMenuKeys}
        className={cn(
          ROW,
          "text-muted-foreground hover:text-foreground aria-current:bg-sidebar-row-active aria-current:text-foreground",
        )}
      >
        <span aria-hidden className="flex justify-self-center">
          {Icon !== undefined && <Icon className="size-3.5" />}
        </span>
        <span className="truncate">{row.title}</span>
        <span className="text-xs tabular-nums">{when}</span>
      </button>
    </RowMenu>
  );
}

/**
 * The way into History: one line at the column's foot, under Done's few rows and out of the scroll
 * so it is always there, that opens every past chat in one searchable list.
 */
export function OverviewHistory() {
  const hint = useShortcutHint("history.open");
  const open = useHistoryStore((s) => s.open);
  return (
    <div className="shrink-0 border-t border-border px-2 py-1.5">
      <button
        type="button"
        data-testid="overview-history"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-keyshortcuts={hint === "" ? undefined : hint}
        title={withHint("Finished workers, done and archived threads, past CLI sessions", hint)}
        onClick={() => useHistoryStore.getState().show()}
        className="flex h-8 w-full items-center gap-2 rounded-(--radius-sm) px-1.5 text-left text-[13px] text-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:text-foreground"
      >
        <History aria-hidden className="size-4 shrink-0" />
        <span className="flex-1">Open History</span>
        {hint !== "" && <kbd className="font-sans text-xs tabular-nums">{hint}</kbd>}
      </button>
    </div>
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
