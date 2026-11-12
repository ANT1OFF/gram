import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useRouterState } from "@tanstack/react-router";
import { History, Search, Settings } from "lucide-react";
import { Fragment, useMemo } from "react";

import { useApi } from "@/api/context";
import {
  OUTCOME_LABEL,
  RECENT_DONE,
  recentDone,
  recentWhen,
  type HistoryOutcome,
  type RecentDone,
} from "@/history/history-model";
import { useHistoryStore } from "@/history/history-view";
import { Hint } from "@/components/hint";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { openExternalUrl } from "@/api/open-external";
import { PrMarkIcon } from "@/components/pr-marks";
import { prMarksOf, prTooltipOf, worstPrMark } from "@/components/pr-marks-model";
import { useOpenPrRows } from "@/reviews/open-prs";
import { useReviewRequests } from "@/reviews/review-requests";
import { LimitBar, useLimitsNow } from "@/shell/usage-meter";
import { cn } from "@/lib/utils";
import { TopLeftNav } from "@/shell/top-left-nav";
import { useOpenThread } from "@/shell/thread-switcher";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { useSame } from "@/stores/use-same";
import { RowMenuItems, rowMenuKeys, threadDragProps } from "@/thread/row-menu";
import { limitSpent, useUsageLimits } from "@/stores/usage-limits";
import { useSettleRule } from "@/views/use-settle-rule";
import { useViewWorkspace } from "@/views/view-workspace";

import {
  footMeters,
  overviewPrRows,
  PR_KIND_LABEL,
  prSubLine,
  workerSlots,
  type OverviewPrRow,
} from "./overview-extras-model";
import {
  CURRENT_ROW,
  ROW,
  ROW_MARK,
  ROW_TITLE,
  ROW_TRAIL,
  RowMenu,
  SECTION_TITLE,
  STOP,
} from "./overview-section";
import { StatusDot, type DotState } from "./status-dot";
import { useFinishedWorkerPages } from "./use-finished-workers";
import { useOrchestratorLedger, useOrchestratorLedgers, useWorkspaces } from "./use-orchestration";
import { useThreadsListed } from "@/embed/store";
import {
  EmbedAccount,
  EmbedFootIcons,
  KeyCaps,
  RAIL_TILE,
  ROOMY_ROW,
  RoomyTile,
} from "@/embed/slots";
import { useLaunchIssues } from "@/launch-checks/banner";

// The overview sidebar's extras: At rest's Pull requests and Done, each gone with nothing in it, the
// way into History, and the usage meters and worker slots at its foot, off by default. Each reads
// what the title bar's meter and History read, so they all say the same.

/**
 * The review requests and the user's open PRs, as At rest lists them: a list placed nowhere is left
 * out here too.
 */
export function useOverviewPrRows(): readonly OverviewPrRow[] {
  const { data: requests } = useReviewRequests();
  const own = useOpenPrRows();
  const reviewsShown = useLayoutStore((s) => s.reviewRequestsPlacement !== "hidden");
  const ownShown = useLayoutStore((s) => s.openPrsPlacement !== "hidden");
  return useMemo(
    () =>
      overviewPrRows(requests?.requests ?? [], own.rows, { reviews: reviewsShown, own: ownShown }),
    [requests, own.rows, reviewsShown, ownShown],
  );
}

/**
 * The PRs in At rest, one row each, under one heading, "Pull requests", or one per kind ("Review
 * requests", "Your PRs") when both are there, headed as At rest's other groups are. A click opens
 * the PR on GitHub.
 */
export function OverviewPullRequests({ rows }: { rows: readonly OverviewPrRow[] }) {
  if (rows.length === 0) return null;
  const both = rows[0]?.kind !== rows.at(-1)?.kind;
  const groups = both
    ? (["review", "yours"] as const).map((kind) => ({
        title: PR_KIND_LABEL[kind],
        kinded: true,
        rows: rows.filter((row) => row.kind === kind),
      }))
    : [{ title: "Pull requests", kinded: false, rows }];
  return (
    <section
      aria-label="Pull requests"
      data-testid="overview-section-pullRequests"
      className="flex flex-col gap-px"
    >
      {groups.map((group) => (
        <Fragment key={group.title}>
          <RestHeading
            title={group.title}
            count={group.rows.length}
            testId={group.kinded ? "overview-pr-kind" : undefined}
          />
          {group.rows.map((row) => (
            <PrRow key={row.key} row={row} />
          ))}
        </Fragment>
      ))}
    </section>
  );
}

/**
 * A group's heading inside At rest ("Pull requests", "Done"): a section title's
 * look and grid, its count in the same right column, with no fold of its own.
 */
export function RestHeading({
  title,
  count,
  testId,
}: {
  title: string;
  count: number;
  testId?: string | undefined;
}) {
  return (
    <h3
      data-testid={testId}
      aria-label={`${title}, ${count}`}
      className={cn(SECTION_TITLE, "mt-1 hover:text-muted-foreground")}
    >
      <span aria-hidden />
      <span className="min-w-0 truncate">{title}</span>
      <span className="tabular-nums">{count}</span>
    </h3>
  );
}

/**
 * A PR in one row: its worst mark in the vocabulary (`worstPrMark`), its title, and its short ref
 * at the edge. Its tooltip and name say the rest: its author, which list it is on and every mark.
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
      title={`${row.title}\n${label} · ${sub}\n${prTooltipOf(row.facts, marks)}`}
      onClick={() => void openExternalUrl(api, row.url).catch(() => {})}
      className={ROW}
    >
      <span
        data-testid="overview-pr-glyph"
        data-state={row.glyph.kind}
        data-worst={worst.mark.kind}
        className={ROW_MARK}
      >
        <PrMarkIcon group={worst.group} mark={worst.mark} />
      </span>
      <span data-testid="overview-pr-title" className={ROW_TITLE}>
        {row.title}
      </span>
      <span data-testid="overview-pr-sub" className={ROW_TRAIL}>
        <span className="truncate">{row.ref}</span>
      </span>
    </button>
  );
}

/**
 * Search, written out under the Needs you pill so it is found without knowing its shortcut: it
 * opens the command palette, which finds threads, workers and commands.
 */
export function OverviewSearch({
  roomy = false,
  phone = false,
}: {
  roomy?: boolean;
  /** In a phone's drawer, where it is a field and says what it finds. */
  phone?: boolean;
}) {
  const hint = useShortcutHint("palette.open");
  // Where an app in front of Gram leaves the threads out of the sidebar, search finds more than them.
  const threadsListed = useThreadsListed();
  const open = useLayoutStore((s) => s.paletteOpen);
  if (roomy)
    return (
      <button
        type="button"
        data-testid="overview-search"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-keyshortcuts={hint === "" ? undefined : hint}
        title={withHint("Search", hint)}
        onClick={() => useLayoutStore.getState().openPalette()}
        className={cn(ROOMY_ROW, "w-full shrink-0 font-normal")}
      >
        <RoomyTile>
          <Search aria-hidden />
        </RoomyTile>
        <span className="flex-1 truncate">Search</span>
        <KeyCaps hint={hint} />
      </button>
    );
  return (
    <button
      type="button"
      data-testid="overview-search"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-keyshortcuts={hint === "" ? undefined : hint}
      title={withHint("Search threads, workers and commands", hint)}
      onClick={() => useLayoutStore.getState().openPalette()}
      className="flex h-8 w-full shrink-0 items-center gap-1.5 rounded-(--radius-sm) pr-1.5 pl-1 text-left text-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:text-foreground in-data-phone-drawer:h-11 in-data-phone-drawer:min-w-0 in-data-phone-drawer:flex-1 in-data-phone-drawer:gap-2 in-data-phone-drawer:rounded-(--radius-md) in-data-phone-drawer:border in-data-phone-drawer:border-border in-data-phone-drawer:px-3"
    >
      <Search aria-hidden className="size-icon-row shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {phone && threadsListed ? "Search threads" : "Search"}
      </span>
      {hint !== "" && (
        <kbd className="font-sans text-meta tabular-nums in-data-phone-drawer:hidden">{hint}</kbd>
      )}
    </button>
  );
}

/**
 * Every finished chat Done counts, latest first (`recentDone`), and the time its rows read: the head
 * of History's Done chip, solo threads that settled on their own included.
 */
export function useOverviewDone(): { rows: readonly RecentDone[]; now: number } {
  const api = useApi();
  const workspaces = useWorkspaces();
  const ids = useMemo(() => workspaces.map((state) => state.workspace.id), [workspaces]);
  const ledgers = useOrchestratorLedgers(ids);
  const { finished } = useFinishedWorkerPages(ids);
  const { data: projects } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  // Minute resolution is enough for the times rows show, and for what has settled.
  const settle = useSettleRule();
  const { now } = settle;
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
        settle,
      }),
    ),
  );
  return { rows, now };
}

/**
 * Done, At rest's last group: the three chats that finished last, one row each (its title, and
 * when at the edge; its outcome and place on its hover), muted until hovered, so they never compete
 * with the live rows above. The rest are one line away on History's Done chip, never unfolded here,
 * so a busy day's Done can't push the live rows off screen. The open thread's row stays in sight.
 */
export function OverviewDone({ rows, now }: { rows: readonly RecentDone[]; now: number }) {
  const viewed = useParams({ strict: false }).threadId;
  if (rows.length === 0) return null;
  const shown = rows.filter((row, index) => index < RECENT_DONE || row.threadId === viewed);
  const more = rows.length - shown.length;
  return (
    <section
      aria-label="Done"
      aria-description="Finished and settled chats, latest first. History has them all."
      data-testid="overview-section-doneToday"
      className="flex flex-col gap-px"
    >
      <RestHeading title="Done" count={rows.length} />
      {shown.map((row) => (
        <DoneRow key={row.threadId} row={row} now={now} />
      ))}
      {more > 0 && (
        <button
          type="button"
          {...{ [STOP]: "" }}
          data-testid="overview-done-more"
          aria-haspopup="dialog"
          title="Open History on Done"
          onClick={() => useHistoryStore.getState().show("done")}
          className={cn(ROW, "text-meta text-muted-foreground hover:text-foreground")}
        >
          {/* An empty mark column, so the words start where the rows' titles do. */}
          <span aria-hidden />
          <span className={ROW_TITLE}>{more} more in History</span>
        </button>
      )}
    </section>
  );
}

const NO_PROJECTS: readonly never[] = [];

/** Each outcome's dot: the merged colour for work that landed, red for a failure, grey for a stop. */
const OUTCOME_DOT: Readonly<Record<HistoryOutcome, DotState>> = {
  merged: "merged",
  delivered: "done",
  stopped: "idle",
  failed: "error",
  archived: "archived",
  idle: "idle",
};

/** A finished chat in one row: its outcome's dot, its title and when; muted until hovered. */
function DoneRow({ row, now }: { row: RecentDone; now: number }) {
  const openThread = useOpenThread();
  // Only this row's answer: a move to another thread re-renders the two rows it changes, not all.
  const viewed = useParams({
    strict: false,
    select: (params) => params.threadId === row.threadId,
  });
  const word = row.outcome === undefined ? "finished" : OUTCOME_LABEL[row.outcome];
  const when = recentWhen(row.finishedAt, now);
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
        title={`${row.title}\n${row.place} · ${word}`}
        aria-keyshortcuts="Shift+F10"
        onClick={() => openThread(row.threadId)}
        onKeyDown={rowMenuKeys}
        className={cn(
          ROW,
          "text-muted-foreground hover:text-foreground aria-current:text-foreground",
          CURRENT_ROW,
        )}
      >
        {/* Its state's dot, as a worker's row has: one mark family down the column. Its outcome
            and place are on its hover; the edge says when, or the outcome with no time to say. */}
        <span aria-hidden className={ROW_MARK}>
          <StatusDot state={row.outcome === undefined ? "done" : OUTCOME_DOT[row.outcome]} />
        </span>
        <span className={ROW_TITLE}>{row.title}</span>
        <span data-testid="overview-done-status" className={ROW_TRAIL}>
          <span className={cn("truncate tabular-nums", when === "" && "capitalize")}>
            {when === "" ? word : when}
          </span>
        </span>
      </button>
    </RowMenu>
  );
}

/**
 * The column's foot, out of the scroll so it is always there: History, the sidebar's one way into
 * every past chat in one searchable list (Done's folded row only unfolds), and Settings beside it.
 * With Done turned off, History's line goes and Settings stays.
 */
export function OverviewHistory({ showHistory = true }: { showHistory?: boolean }) {
  const hint = useShortcutHint("history.open");
  const open = useHistoryStore((s) => s.open);
  return (
    <div className="flex shrink-0 items-center gap-1 border-t border-border px-2 py-1.5 in-data-phone-drawer:pb-[max(--spacing(1.5),env(safe-area-inset-bottom))]">
      {showHistory ? (
        <button
          type="button"
          data-testid="overview-history"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-keyshortcuts={hint === "" ? undefined : hint}
          title={withHint("Finished workers, done and archived threads, past CLI sessions", hint)}
          onClick={() => useHistoryStore.getState().show()}
          className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-(--radius-sm) pr-1.5 pl-1 text-left text-body text-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:text-foreground in-data-phone-drawer:h-11 in-data-phone-drawer:gap-2.5 in-data-phone-drawer:px-2"
        >
          {/* An inline glyph, on Search's and the rows' marks. Its key is on its hover: beside
              Settings the foot has no room for it on one line. */}
          <History aria-hidden className="size-icon-row shrink-0" />
          <span className="flex-1 truncate">History</span>
        </button>
      ) : (
        <span className="flex-1" />
      )}
      {/* Settings beside History, the sidebar's places to go, clear of its header's toggles. */}
      <TopLeftNav update={false} hintSide="top" className="shrink-0" />
    </div>
  );
}

/**
 * The `roomy` sidebar's foot, an app in front of Gram's look: one row of icons, the embedding
 * app's other places, then History and Settings, each named on hover, and under it the app's
 * account. Short, so the list above keeps the window's height.
 */
export function RoomyFoot({ showHistory = true }: { showHistory?: boolean }) {
  const historyHint = useShortcutHint("history.open");
  const historyOpen = useHistoryStore((s) => s.open);
  const settingsHint = useShortcutHint("settings.open");
  const setup = useLaunchIssues().dismissed;
  const inSettings = useRouterState({
    select: (state) => state.location.pathname.startsWith("/settings"),
  });
  const settingsLabel =
    setup.length === 0
      ? "Settings"
      : `Settings, ${setup.length === 1 ? "1 setup problem" : `${setup.length} setup problems`}`;
  return (
    <div
      data-testid="overview-roomy-foot"
      className="flex shrink-0 flex-col gap-tight border-t border-border px-inset py-tight"
    >
      <div data-testid="overview-roomy-foot-icons" className="flex items-center gap-1 px-1">
        <EmbedFootIcons />
        {showHistory && (
          <Hint
            label={withHint("History", historyHint)}
            side="top"
            render={
              <button
                type="button"
                data-testid="overview-history"
                aria-label="History"
                aria-haspopup="dialog"
                aria-expanded={historyOpen}
                aria-keyshortcuts={historyHint === "" ? undefined : historyHint}
                onClick={() => useHistoryStore.getState().show()}
                className={RAIL_TILE}
              />
            }
          >
            <History aria-hidden className="size-4.5" />
          </Hint>
        )}
        <Hint
          label={withHint(settingsLabel, settingsHint)}
          side="top"
          render={
            <Link
              to={setup.length === 0 ? "/settings" : "/settings/diagnostics"}
              data-testid="overview-settings"
              aria-label={settingsLabel}
              aria-current={inSettings ? "page" : undefined}
              className={RAIL_TILE}
            />
          }
        >
          <Settings aria-hidden className="size-4.5" />
          {setup.length > 0 && (
            <span
              aria-hidden
              data-testid="top-left-settings-dot"
              className="absolute top-1 right-1 size-1.5 rounded-full bg-foreground"
            />
          )}
        </Hint>
      </div>
      <EmbedAccount />
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
      className="grid shrink-0 gap-2 border-t border-border px-3.5 pt-2.5 pb-3 text-meta text-muted-foreground tabular-nums"
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
          <span data-testid="overview-usage-text" className="whitespace-nowrap">
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
                    "block size-1.5 rounded-2xs",
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
