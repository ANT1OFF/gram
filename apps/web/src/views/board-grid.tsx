import {
  FEATURE_STATIONS,
  STATION_LABELS,
  type FeatureStage,
  type FeatureStation,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import { CircleAlert, Layers } from "lucide-react";
import { useMemo, type MouseEvent, type ReactNode } from "react";

import { Hint } from "@/components/hint";
import { formatStamp } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { RowPlace } from "@/lib/virtual-rows";
import { FeatureMenu, PausedBadge, RAIL_TONES } from "@/orchestration/feature-sheet";
import { openFeatureSheet } from "@/orchestration/feature-sheet-store";
import { HeldBriefChip } from "@/orchestration/held-brief";
import { shownPrNumbers, useWorkerPrChips, WorkerPrChips } from "@/orchestration/overview-pr-chips";
import {
  nowBesidePrs,
  overlapHint,
  type RailRow,
  type RailTone,
  type RailWorker,
} from "@/orchestration/rail-model";
import { StageChip } from "@/orchestration/stage-stepper";
import { StatusDot } from "@/orchestration/status-dot";
import { useOrchestratorLedger } from "@/orchestration/use-orchestration";
import { useFeatureSummary } from "@/orchestration/use-feature-cards";

// The Board as a grid: a row per feature with its cells side by side, Task · Stage · Now · Pull
// request, so a feature's name, how far it has come, what it does and its checks read on one line.
// A feature with several workers (or a held brief beside one) heads a row of its own, its workers
// under it. The stations stay in each Stage cell as a segmented bar under the station's name; the
// lanes are the other layout (board-view.tsx).

/**
 * The grid's four columns, shared by its heads and every row so the cells line up. Each is as wide
 * as what it holds needs and no wider: a task's name (two lines) to 15 rem, the stage bar's fixed
 * 9, Now's state and latest report line to 26, and the PR's chips and words to 12. No column takes
 * the rest, so a wide window leaves its room after the PR column, not before it.
 */
export const GRID_COLUMNS =
  "grid grid-cols-[minmax(10rem,15rem)_9rem_minmax(12rem,26rem)_minmax(7rem,12rem)] gap-x-6";

/** The column heads over the rows. */
export function GridHeads() {
  return (
    <div
      aria-hidden
      data-testid="board-grid-heads"
      className="sticky top-0 z-10 border-b border-border bg-thread px-4 py-1.5 text-meta text-muted-foreground"
    >
      <div className={GRID_COLUMNS}>
        <span>Task</span>
        <span>Stage</span>
        <span>Now</span>
        <span>Pull request</span>
      </div>
    </div>
  );
}

/** A tone as the step its worker stands on, in the status colours (DESIGN.md). */
const STEP_TONE: Readonly<Record<RailTone, string>> = {
  needs: "bg-status-needs-mark",
  attention: "bg-foreground",
  error: "bg-destructive",
  working: "bg-status-working",
  waiting: "bg-status-working",
  idle: "bg-muted-foreground",
  merged: "bg-merged",
};

/**
 * The stage bar: the station's name and where it stands ("Checks 3/5"), over five joined segments,
 * one per station, filled up to where the work stands. The segment it stands on takes its tone's
 * colour; the lanes' track in the width of a cell.
 */
export function StationSteps({
  station,
  tone,
}: {
  station: FeatureStation;
  /** The worker's tone; a feature over several workers draws its furthest step plain. */
  tone?: RailTone | undefined;
}) {
  const at = FEATURE_STATIONS.indexOf(station);
  const label = STATION_LABELS[station];
  return (
    <span
      role="img"
      aria-label={`${label}, step ${at + 1} of ${FEATURE_STATIONS.length}`}
      data-testid="grid-stage"
      data-station={station}
      className="flex min-w-0 flex-col gap-1"
    >
      <span aria-hidden className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate text-body font-medium text-foreground">{label}</span>
        <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
          {at + 1}/{FEATURE_STATIONS.length}
        </span>
      </span>
      <span aria-hidden data-testid="grid-stage-bar" className="flex w-full max-w-36 gap-0.5">
        {FEATURE_STATIONS.map((each, index) => (
          <i
            key={each}
            data-step={index < at ? "done" : index === at ? "current" : "upcoming"}
            className={cn(
              "h-1.5 flex-1 transition-colors duration-(--dur-base) first:rounded-s-full last:rounded-e-full",
              index < at
                ? "bg-muted-foreground"
                : index === at
                  ? tone === undefined
                    ? "bg-foreground"
                    : STEP_TONE[tone]
                  : "bg-border-strong/50",
            )}
          />
        ))}
      </span>
    </span>
  );
}

/**
 * The Pull request cell: the worker's chips, then what its first PR waits on in words (its checks,
 * its review, its merge), so the state reads without decoding the glyphs; "No PR yet" before one.
 */
function PrCell({ worker }: { worker: RailWorker }) {
  const chips = useWorkerPrChips(worker.threadId, worker.prs);
  const first = chips[0];
  if (first === undefined) {
    return (
      <span data-testid="grid-pr-none" className="pt-px text-meta text-muted-foreground">
        No PR yet
      </span>
    );
  }
  // A settled PR's marks are its state alone, so a merged one adds no words.
  const { checks, review, merge } = first.marks;
  const words = [
    ...(checks === undefined || checks.kind === "none" || checks.kind === "unknown"
      ? []
      : [checks]),
    ...(review === undefined ? [] : [review]),
    ...(merge === undefined ? [] : [merge]),
  ];
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <WorkerPrChips threadId={worker.threadId} cardPrs={worker.prs} className="min-w-0" />
      {words.length > 0 && (
        <span
          data-testid="grid-pr-state"
          className="line-clamp-2 min-w-0 text-meta break-words text-muted-foreground"
        >
          {words.map((mark, index) => (
            <span
              key={mark.word}
              className={cn(checks?.kind === "failing" && mark === checks && "text-destructive")}
            >
              {index > 0 && " · "}
              {mark.word}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * A worker's state in words, its tone's word first (amber only while it needs you), then what it
 * is doing: "Working · tests 38/52". The lanes' cards say it the same way.
 */
export function Status({ tone, now }: { tone: RailWorker["tone"]; now: string }) {
  const { label } = RAIL_TONES[tone];
  // What it waits on may lead with the same word ("Waiting · checks on #88"): said once.
  const rest = now.replace(new RegExp(`^${label}\\s*(?:·\\s*)?`, "iu"), "");
  return (
    <span className="line-clamp-2 min-w-0 flex-[1_1_6rem] break-words">
      <span
        data-testid="rail-status"
        className={cn(
          "font-medium",
          tone === "needs"
            ? "text-status-needs"
            : tone === "error"
              ? "text-destructive"
              : "text-foreground/80",
        )}
      >
        {label}
      </span>
      {rest !== "" && (
        <>
          <span className="text-muted-foreground"> · </span>
          <span data-testid="rail-now" className="text-muted-foreground">
            {rest}
          </span>
        </>
      )}
    </span>
  );
}

/** How soon a status's whole text shows on hover: quick, but not for a pointer passing over. */
const HINT_MS = 200;

/**
 * The worker's Now cell: its tone and what it does, a click from its thread (or its ask in the
 * dock). It carries the lanes' chip's test hooks, so either layout is driven the same way.
 */
function NowCell({
  workspaceId,
  worker,
  station,
  asking,
  shown,
  onOpen,
}: {
  workspaceId: WorkspaceId;
  worker: RailWorker;
  station: FeatureStation;
  asking: boolean;
  /** The PRs its PR cell shows, which its words leave out. */
  shown: readonly { readonly number: number }[];
  onOpen: (threadId: ThreadId, event: MouseEvent) => void;
}) {
  const tone = RAIL_TONES[worker.tone];
  const overlap = overlapHint(worker);
  const hint = [
    worker.title,
    ...(worker.waiting === undefined ? [] : [worker.waiting.hint]),
    ...(asking ? ["Click to answer in Asks"] : []),
  ].join("\n");
  const report = useLatestReport(workspaceId, worker.threadId);
  return (
    <div
      data-testid="rail-worker"
      data-thread-id={worker.threadId}
      data-station={station}
      data-tone={worker.tone}
      data-asking={asking || undefined}
      className="flex min-w-0 flex-col gap-0.5 text-meta"
    >
      <div className="flex min-w-0 items-start gap-1.5">
        <Hint
          label={hint}
          delay={HINT_MS}
          render={
            <button
              type="button"
              data-testid="rail-worker-open"
              onClick={(event) => onOpen(worker.threadId, event)}
              aria-label={`${worker.title}, ${tone.label}, ${worker.now}`}
              className="flex min-w-0 items-start gap-2 rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          {/* The sidebar's and Workers' dot for its state. */}
          <span className="flex h-lh shrink-0 items-center">
            <StatusDot state={worker.tone} data-testid="rail-dot" />
          </span>
          {/* Its PRs are in the cell beside it: each said once. */}
          <Status tone={worker.tone} now={nowBesidePrs(worker.now, shown)} />
        </Hint>
        {overlap !== undefined && (
          <Hint
            label={overlap}
            render={
              <span
                data-testid="rail-overlap"
                className="flex h-lh shrink-0 items-center text-muted-foreground"
              />
            }
          >
            <Layers aria-hidden className="size-3.5" />
            <span className="sr-only">{overlap}</span>
          </Hint>
        )}
      </div>
      {/* Its latest report, in the room the row has: when, then what it said. */}
      {report !== undefined && (
        <p
          data-testid="grid-report"
          title={report.summary}
          className="line-clamp-2 min-w-0 pl-4 break-words text-muted-foreground"
        >
          <time dateTime={new Date(report.at).toISOString()} className="tabular-nums">
            {formatStamp(report.at)}
          </time>
          {" · "}
          {report.summary}
        </p>
      )}
    </div>
  );
}

/** A worker's latest report from its workspace's ledger, if it has made one. */
function useLatestReport(
  workspaceId: WorkspaceId,
  threadId: ThreadId,
): { readonly summary: string; readonly at: number } | undefined {
  const { data: ledger } = useOrchestratorLedger(workspaceId);
  return useMemo(() => {
    const report = ledger?.features
      .flatMap((feature) => feature.workers)
      .find((worker) => worker.threadId === threadId)?.lastReport;
    return report === undefined || report.summary.trim() === ""
      ? undefined
      : { summary: report.summary, at: report.at };
  }, [ledger, threadId]);
}

/** A worker's Stage, Now and Pull request cells. */
function WorkerCells({
  workspaceId,
  worker,
  station,
  asking,
  onOpen,
}: {
  workspaceId: WorkspaceId;
  worker: RailWorker;
  station: FeatureStation;
  asking: boolean;
  onOpen: (threadId: ThreadId, event: MouseEvent) => void;
}) {
  const chips = useWorkerPrChips(worker.threadId, worker.prs);
  return (
    <>
      <StationSteps station={station} tone={worker.tone} />
      <NowCell
        workspaceId={workspaceId}
        worker={worker}
        station={station}
        asking={asking}
        shown={shownPrNumbers(chips)}
        onOpen={onOpen}
      />
      <PrCell worker={worker} />
    </>
  );
}

/** A line's workers with the station each stands on, in the stations' order. */
const placedWorkers = (row: RailRow) =>
  FEATURE_STATIONS.flatMap((station) => row.cells[station].map((worker) => ({ worker, station })));

/** One row of the grid: its four cells, aligned with the heads. */
function GridRow({ sub = false, children }: { sub?: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(GRID_COLUMNS, "items-start", sub ? "border-t border-border/40 py-1.5" : "py-2")}
    >
      {children}
    </div>
  );
}

/** A worker under its feature's row: its title, indented, then its cells. */
function SubTask({ children }: { children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-start gap-1.5 pl-3 text-meta text-foreground/80">
      <span aria-hidden className="mt-1.5 h-px w-2 shrink-0 bg-border-strong" />
      <span className="line-clamp-2 min-w-0 break-words">{children}</span>
    </span>
  );
}

/**
 * A feature in the grid. With one worker, or one held brief, it is one row; with more, a row for
 * the feature, then one for each.
 */
export function GridLine({
  row,
  stage,
  needsMark,
  repos,
  asking,
  onOpen,
  place,
}: {
  row: RailRow;
  stage: FeatureStage | undefined;
  needsMark: boolean;
  repos: boolean;
  asking: ReadonlySet<ThreadId>;
  onOpen: (threadId: ThreadId, event: MouseEvent) => void;
  place?: RowPlace | undefined;
}) {
  const summary = useFeatureSummary(row.card);
  const workers = placedWorkers(row);
  const single = workers.length + row.held.length === 1;
  const only = single ? workers[0] : undefined;
  const held = (each: RailRow["held"][number]) => (
    <ul aria-label={STATION_LABELS.briefed} className="col-span-2 min-w-0">
      <HeldBriefChip
        workspaceId={row.card.workspaceId}
        held={each}
        paused={row.card.paused === true}
      />
    </ul>
  );
  const needs = workers.filter(({ worker }) => worker.tone === "needs").length;
  return (
    <li
      ref={place?.ref}
      data-index={place?.["data-index"]}
      style={place?.style}
      data-testid="rail-row"
      data-layout="grid"
      data-feature={row.feature}
      data-reach={row.reach}
      data-finished={row.finished || undefined}
      aria-label={row.title}
      className={cn(
        "group/line px-4 hover:bg-sidebar-row-hover/50",
        row.finished && "opacity-70",
        place?.className,
      )}
    >
      <GridRow>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 items-start gap-1.5 text-reading font-medium">
            {/* The name opens the feature's sheet; its menu sits beside it. */}
            <button
              type="button"
              data-testid="rail-feature"
              title={
                workers.length > 1
                  ? `${row.feature} · ${workers.length} workers`
                  : `${row.title} · ${row.feature}`
              }
              onClick={() => openFeatureSheet(row.card.workspaceId, row.feature)}
              className="line-clamp-2 min-w-0 rounded-sm text-left break-words underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {row.title}
            </button>
            {row.card.paused === true && <PausedBadge testId="rail-paused" />}
            {needsMark && row.needs && (
              <CircleAlert
                aria-label="Needs you"
                data-testid="rail-needs"
                className="mt-1 size-3.5 shrink-0 text-status-needs-mark"
              />
            )}
            <FeatureMenu
              row={row}
              className="ml-auto opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"
            />
          </span>
          {(stage !== undefined || summary !== undefined || repos) && (
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-meta">
              {stage !== undefined && <StageChip stage={stage} testId="rail-stage-chip" />}
              {repos && (
                <span data-testid="rail-repos" className="truncate text-muted-foreground">
                  {row.projects.join(" · ")}
                </span>
              )}
              {/* The helper's sentence for this card version; the row is complete without it. */}
              {summary !== undefined && (
                <span
                  data-testid="rail-summary"
                  title={summary}
                  className="line-clamp-1 min-w-0 basis-full text-foreground/80"
                >
                  {summary}
                </span>
              )}
            </span>
          )}
        </div>
        {only !== undefined ? (
          <WorkerCells
            workspaceId={row.card.workspaceId}
            worker={only.worker}
            station={only.station}
            asking={asking.has(only.worker.threadId)}
            onOpen={onOpen}
          />
        ) : single && row.held[0] !== undefined ? (
          <>
            <StationSteps station="briefed" />
            {held(row.held[0])}
          </>
        ) : (
          <>
            <StationSteps station={FEATURE_STATIONS[row.reach] ?? "briefed"} />
            <span data-testid="grid-workers" className="pt-px text-meta text-muted-foreground">
              {workers.length} {workers.length === 1 ? "worker" : "workers"}
              {needs > 0 && (
                <span className="text-status-needs">
                  {` · ${needs} ${needs === 1 ? "needs" : "need"} you`}
                </span>
              )}
              {row.held.length > 0 && ` · ${row.held.length} held`}
            </span>
            <span />
          </>
        )}
      </GridRow>
      {!single && (
        <ul aria-label={`Workers on ${row.title}`}>
          {workers.map(({ worker, station }) => (
            <li key={worker.threadId}>
              <GridRow sub>
                <SubTask>{worker.title}</SubTask>
                <WorkerCells
                  workspaceId={row.card.workspaceId}
                  worker={worker}
                  station={station}
                  asking={asking.has(worker.threadId)}
                  onOpen={onOpen}
                />
              </GridRow>
            </li>
          ))}
          {row.held.map((each) => (
            <li key={each.id}>
              <GridRow sub>
                <SubTask>Held brief</SubTask>
                <StationSteps station="briefed" />
                {held(each)}
              </GridRow>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
