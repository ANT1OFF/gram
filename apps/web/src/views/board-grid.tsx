import {
  FEATURE_STATIONS,
  STATION_LABELS,
  type FeatureStage,
  type FeatureStation,
  type ThreadId,
} from "@gram/contracts";
import { CircleAlert, Layers } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

import { Hint } from "@/components/hint";
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
import { useFeatureSummary } from "@/orchestration/use-feature-cards";

// The Board as a grid: a row per feature with its cells side by side, Task · Stage · Now · Pull
// request, so a feature's name, how far it has come, what it does and its checks read on one line.
// A feature with several workers (or a held brief beside one) heads a row of its own, its workers
// under it. The stations stay in each Stage cell as five small steps; the lanes are the other
// layout (board-view.tsx).

/** The grid's four columns, shared by its heads and every row so the cells line up. */
export const GRID_COLUMNS =
  "grid grid-cols-[minmax(10rem,2.2fr)_minmax(8.5rem,10rem)_minmax(8rem,2fr)_minmax(6rem,1fr)] gap-x-4";

/** The column heads over the rows. */
export function GridHeads() {
  return (
    <div
      aria-hidden
      data-testid="board-grid-heads"
      className={cn(
        GRID_COLUMNS,
        "sticky top-0 z-10 border-b border-border bg-thread px-4 py-1.5 text-meta text-muted-foreground",
      )}
    >
      <span>Task</span>
      <span>Stage</span>
      <span>Now</span>
      <span>Pull request</span>
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
 * Five small steps, one per station, filled up to where the work stands, then the station's word:
 * the lanes' track in the width of a cell. The step it stands on takes its tone's colour.
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
      className="flex min-w-0 items-center gap-2 text-meta"
    >
      <span aria-hidden className="flex shrink-0 items-center gap-0.5">
        {FEATURE_STATIONS.map((each, index) => (
          <i
            key={each}
            className={cn(
              "h-1.5 w-2.5 rounded-full transition-colors duration-(--dur-base)",
              index < at
                ? "bg-muted-foreground/70"
                : index === at
                  ? tone === undefined
                    ? "bg-foreground/80"
                    : STEP_TONE[tone]
                  : "bg-border",
            )}
          />
        ))}
      </span>
      <span className="truncate text-foreground/80">{label}</span>
    </span>
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
  worker,
  station,
  asking,
  shown,
  onOpen,
}: {
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
  return (
    <div
      data-testid="rail-worker"
      data-thread-id={worker.threadId}
      data-station={station}
      data-tone={worker.tone}
      data-asking={asking || undefined}
      className="flex min-w-0 items-start gap-1.5 text-meta"
    >
      <Hint
        label={hint}
        delay={HINT_MS}
        render={
          <button
            type="button"
            data-testid="rail-worker-open"
            onClick={(event) => onOpen(worker.threadId, event)}
            aria-label={`${worker.title}, ${tone.label}, ${worker.now}`}
            className="flex min-w-0 items-start gap-1.5 rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <tone.icon aria-hidden className={cn("mt-px size-3.5 shrink-0", tone.tone)} />
        {/* Its PRs are in the cell beside it: each said once. */}
        <Status tone={worker.tone} now={nowBesidePrs(worker.now, shown)} />
      </Hint>
      {overlap !== undefined && (
        <Hint
          label={overlap}
          render={
            <span
              data-testid="rail-overlap"
              className="mt-px flex shrink-0 items-center text-muted-foreground"
            />
          }
        >
          <Layers aria-hidden className="size-3.5" />
          <span className="sr-only">{overlap}</span>
        </Hint>
      )}
    </div>
  );
}

/** A worker's Stage, Now and Pull request cells. */
function WorkerCells({
  worker,
  station,
  asking,
  onOpen,
}: {
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
        worker={worker}
        station={station}
        asking={asking}
        shown={shownPrNumbers(chips)}
        onOpen={onOpen}
      />
      <WorkerPrChips threadId={worker.threadId} cardPrs={worker.prs} className="min-w-0" />
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
