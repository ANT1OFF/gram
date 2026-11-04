import {
  FEATURE_STATIONS,
  STATION_LABELS,
  type FeatureStage,
  type FeatureStation,
  type ThreadId,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import { CircleAlert, Columns3, Layers } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";
import { VirtualRows, type RowPlace } from "@/lib/virtual-rows";
import { drawOn, Expand, GlideItem, GlideList } from "@/motion";
import { askKeysByThread } from "@/orchestration/ask-model";
import { showAsk } from "@/orchestration/ask-sheet-store";
import { AskStack, useWorkspaceAsks } from "@/orchestration/ask-stack";
import { laneCounts, lanesMinWidth, laneTemplate } from "@/orchestration/board-lanes";
import { useBoardWaiting, WaitingList, WAITING_BAND } from "@/orchestration/board-waiting";
import { FailuresCard } from "@/orchestration/failures-card";
import {
  FeatureMenu,
  PausedBadge,
  RAIL_TONES,
  useOpenWorker,
  useRailFacts,
} from "@/orchestration/feature-sheet";
import { openFeatureSheet } from "@/orchestration/feature-sheet-store";
import { HeldBriefChip } from "@/orchestration/held-brief";
import { useBoardBand } from "@/orchestration/open-board";
import {
  boardRows,
  hiddenWorkerCount,
  overlapHint,
  railEntries,
  railRows,
  type RailEntry,
  type RailRow,
  type RailWorker,
} from "@/orchestration/rail-model";
import { useSetStage } from "@/orchestration/use-board-actions";
import { useFeatureCards, useFeatureSummary } from "@/orchestration/use-feature-cards";
import { useWorkspaces } from "@/orchestration/use-orchestration";
import { useLayoutStore } from "@/stores/layout";

import { BoardHeader } from "./board-header";
import { StageChip } from "@/orchestration/stage-stepper";

import { GroupBand } from "./board-group";
import { useViewStore } from "./view-store";

// The Board view: the workspace as feature lines, each worker on
// the station its feature card gives it, and the ask stack docked below. Its header carries the
// workspace's controls and what waits on you; lines carry their stage and gather under their
// group's band; unresolved failures stand in a card above them all.

/** What a view is given: the workspace the window is on, if any. */
export interface ViewProps {
  readonly workspaceId: WorkspaceId | undefined;
}

/** How soon a chip's whole title shows on hover: quick, but not for a pointer passing over. */
const CHIP_HINT_MS = 200;

/** The lines' columns, from the Board's `--board-lanes` (`laneTemplate`). */
const COLUMNS = "grid-cols-(--board-lanes)";

function WorkerChip({
  worker,
  station,
  named,
  asking,
  onOpen,
}: {
  worker: RailWorker;
  station: FeatureStation;
  /** Whether it says its title: a line's only worker leaves that to the line's name. */
  named: boolean;
  /** Whether it waits on an ask in the dock, which a click turns to. */
  asking: boolean;
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
    <GlideItem
      glideId={`rail-worker-${worker.threadId}`}
      data-testid="rail-worker"
      data-thread-id={worker.threadId}
      data-station={station}
      data-tone={worker.tone}
      data-asking={asking || undefined}
      // The name's button stretches over the whole chip; the PR and the overlap sit above it.
      className={cn(
        "relative flex w-full max-w-72 min-w-0 flex-col gap-1 rounded-(--radius-md) border border-border bg-card px-2.5 py-2 text-xs focus-within:ring-2 focus-within:ring-ring hover:border-ring/60",
        worker.tone === "needs" && "border-status-needs-mark/60",
      )}
    >
      {/* Its whole title on hover, as two lines may still cut a long one short. */}
      <Hint
        label={hint}
        delay={CHIP_HINT_MS}
        render={
          <button
            type="button"
            data-testid="rail-worker-open"
            onClick={(event) => onOpen(worker.threadId, event)}
            aria-label={`${worker.title}, ${tone.label}, ${worker.now}`}
            className="flex min-w-0 items-start gap-1.5 text-left outline-none after:absolute after:inset-0 after:content-['']"
          />
        }
      >
        <tone.icon aria-hidden className={cn("mt-0.5 size-3.5 shrink-0", tone.tone)} />
        {named ? (
          <span
            data-testid="rail-worker-title"
            className="line-clamp-2 min-w-0 font-medium break-words text-foreground"
          >
            {worker.title}
          </span>
        ) : (
          <Status tone={worker.tone} now={worker.now} />
        )}
      </Hint>
      <span
        className={cn(
          // In a narrow lane the PR and the overlap wrap under the words rather than cut them.
          "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-4.5 text-xs text-muted-foreground",
          !named && worker.pr === undefined && overlap === undefined && "hidden",
        )}
      >
        {named && <Status tone={worker.tone} now={worker.now} />}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 empty:hidden">
          {worker.pr !== undefined &&
            (worker.pr.url === undefined ? (
              <span className="tabular-nums">#{worker.pr.number}</span>
            ) : (
              <a
                href={worker.pr.url}
                target="_blank"
                rel="noreferrer"
                className="relative rounded-sm tabular-nums outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                #{worker.pr.number}
              </a>
            ))}
          {overlap !== undefined && (
            <Hint
              label={overlap}
              render={
                <span
                  data-testid="rail-overlap"
                  className="relative flex items-center text-muted-foreground"
                />
              }
            >
              <Layers aria-hidden className="size-3.5" />
              <span className="sr-only">{overlap}</span>
            </Hint>
          )}
        </span>
      </span>
    </GlideItem>
  );
}

/**
 * A card's state in words, its tone's word first (amber only while it needs you), then what it is
 * doing: "Working · tests 38/52".
 */
function Status({ tone, now }: { tone: RailWorker["tone"]; now: string }) {
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

/**
 * One station's piece of the line under the stations: its dot, and the line in from the station
 * before and on to the next, drawn as far as the feature's furthest worker. Each lane draws its own
 * piece, so the line follows lanes of any width.
 */
function TrackPiece({ index, reach }: { index: number; reach: number }) {
  const last = FEATURE_STATIONS.length - 1;
  return (
    <div aria-hidden className="relative row-start-1 h-3" style={{ gridColumnStart: index + 2 }}>
      {/* Half the column gap past each edge, so the pieces meet. */}
      {index > 0 && (
        <span
          className={cn(
            "absolute top-[5px] -left-1 h-0.5 w-[calc(50%+0.25rem)]",
            index <= reach ? "bg-muted-foreground" : "bg-border",
          )}
        />
      )}
      {index < last && (
        <span
          className={cn(
            "absolute top-[5px] -right-1 h-0.5 w-[calc(50%+0.25rem)]",
            index < reach ? "bg-muted-foreground" : "bg-border",
          )}
        />
      )}
      <i
        className={cn(
          "absolute top-px left-1/2 size-2.5 -translate-x-1/2 rounded-full border-2 border-border bg-background transition-colors duration-(--dur-base)",
          index <= reach && "border-muted-foreground bg-muted-foreground",
        )}
      />
    </div>
  );
}

function FeatureLine({
  row,
  stage,
  needsMark,
  repos,
  asking,
  onOpen,
  place,
  stacked,
}: {
  row: RailRow;
  /** The workers waiting on an ask in the dock. */
  asking: ReadonlySet<ThreadId>;
  /** Whether it names its repos: only where the workspace has more than one. */
  repos: boolean;
  /**
   * Its stage from the workspace, which carries who set it and when: a chip, as the stations already
   * say how far the work has come. Its plan's steps are set in the feature's sheet.
   */
  stage: FeatureStage | undefined;
  /** Whether the line marks that it needs you; in a group's band, the band says it once. */
  needsMark: boolean;
  onOpen: (threadId: ThreadId, event: MouseEvent) => void;
  /** Where the Board's list draws it; a line in a group's band flows in it. */
  place?: RowPlace | undefined;
  /**
   * A narrow pane: its cards under its name, by station, rather than in lanes too narrow for them.
   */
  stacked: boolean;
}) {
  const summary = useFeatureSummary(row.card);
  return (
    <li
      ref={place?.ref}
      data-index={place?.["data-index"]}
      style={place?.style}
      data-testid="rail-row"
      data-feature={row.feature}
      data-reach={row.reach}
      data-finished={row.finished || undefined}
      aria-label={row.title}
      data-stacked={stacked || undefined}
      className={cn(
        "group/line gap-x-2 gap-y-2 px-4 py-3 hover:bg-sidebar-row-hover/50",
        stacked ? "flex flex-col" : cn("grid", COLUMNS),
        row.finished && "opacity-70",
        place?.className,
      )}
    >
      <div
        className={cn(
          "flex min-w-0 flex-col justify-center gap-1",
          stacked ? "max-w-xl" : "row-span-2 pr-2",
        )}
      >
        <span className="flex min-w-0 items-start gap-1.5 text-sm font-medium">
          {/* The name opens the feature's sheet; its menu sits beside it. */}
          <button
            type="button"
            data-testid="rail-feature"
            title={
              workerCount(row) > 1
                ? `${row.feature} · ${workerCount(row)} workers`
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
        {stage !== undefined && (
          <StageChip stage={stage} testId="rail-stage-chip" className="self-start" />
        )}
        {/* The helper's sentence for this card version; the line is complete without it. */}
        {summary !== undefined && (
          <span
            data-testid="rail-summary"
            title={summary}
            className="line-clamp-2 text-xs text-foreground/80"
          >
            {summary}
          </span>
        )}
        {repos && (
          <span data-testid="rail-repos" className="truncate text-xs text-muted-foreground">
            {row.projects.join(" · ")}
          </span>
        )}
      </div>
      {!stacked &&
        FEATURE_STATIONS.map((station, index) => (
          <TrackPiece key={station} index={index} reach={row.reach} />
        ))}
      {FEATURE_STATIONS.map((station, index) => {
        const cards = row.cells[station].length + (station === "briefed" ? row.held.length : 0);
        // Stacked, a station with nothing on this line says nothing.
        if (stacked && cards === 0) return null;
        const list = (
          <ul
            key={station}
            aria-label={STATION_LABELS[station]}
            className={
              stacked
                ? "grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2 [&>*]:max-w-none"
                : "row-start-2 flex min-w-0 flex-col items-center gap-2"
            }
            style={stacked ? undefined : { gridColumnStart: index + 2 }}
          >
            {row.cells[station].map((worker) => (
              <WorkerChip
                key={worker.threadId}
                worker={worker}
                station={station}
                named={workerCount(row) > 1}
                asking={asking.has(worker.threadId)}
                onOpen={onOpen}
              />
            ))}
            {station === "briefed" &&
              row.held.map((held) => (
                <HeldBriefChip
                  key={held.id}
                  workspaceId={row.card.workspaceId}
                  held={held}
                  paused={row.card.paused === true}
                />
              ))}
          </ul>
        );
        if (!stacked) return list;
        return (
          <section
            key={station}
            data-testid="rail-stack-station"
            data-station={station}
            className="flex flex-col gap-1.5"
          >
            <h4 className="flex items-baseline gap-1.5 text-xs font-medium text-foreground/80">
              {STATION_LABELS[station]}
              <span className="font-normal text-muted-foreground tabular-nums">{cards}</span>
            </h4>
            {list}
          </section>
        );
      })}
    </li>
  );
}

/** How many workers a line draws on its stations. */
const workerCount = (row: RailRow): number =>
  Object.values(row.cells).reduce((sum, cell) => sum + cell.length, 0);

/** The first line in no group under the bands, headed, so it doesn't read as the band's above it. */
function OtherLine({ place, children }: { place: RowPlace; children: ReactNode }) {
  return (
    <li {...place}>
      <p
        data-testid="rail-other"
        className="bg-card/40 px-4 py-2 text-sm font-medium text-muted-foreground"
      >
        Other
      </p>
      <ul aria-label="Features in no group">{children}</ul>
    </li>
  );
}

/** A line's height before it draws: a feature with a worker or two. */
const LINE_HEIGHT = 96;
/** Lines drawn past each edge of the view: a line is tall, so a few cover a fast scroll. */
const LINE_OVERSCAN = 3;

const entryKey = (entry: RailEntry) =>
  entry.kind === "line" ? `line:${entry.row.feature}` : `group:${entry.group.group}`;

/** The stations over the lanes, each with its count; an empty one's name dimmed in its slim lane. */
function LaneHeads({ counts }: { counts: Readonly<Record<FeatureStation, number>> }) {
  return (
    <div
      aria-hidden
      data-testid="rail-lane-heads"
      className={cn(
        "sticky top-0 z-10 grid gap-x-2 border-b border-border bg-thread px-4 py-1.5 text-center text-xs",
        COLUMNS,
      )}
    >
      <span />
      {FEATURE_STATIONS.map((station) => (
        <span
          key={station}
          data-testid="rail-lane-head"
          data-station={station}
          data-empty={counts[station] === 0 || undefined}
          className={cn(
            "min-w-0 truncate",
            counts[station] === 0 ? "text-muted-foreground/70" : "font-medium text-foreground/80",
          )}
        >
          {STATION_LABELS[station]}
          {counts[station] > 0 && (
            <span className="ml-1 font-normal text-muted-foreground tabular-nums">
              {counts[station]}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

/** The pane's width as it is laid out, read before paint and on every resize. */
function usePaneWidth(ref: RefObject<HTMLElement | null>): number | undefined {
  const [width, setWidth] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    // A frame later: a switch between lanes and stacks re-lays the Board out, which must not
    // happen inside the observer's own callback.
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const next = entry.contentRect.width;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(next));
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [ref]);
  return width;
}

/**
 * Picking Board leaves focus on the switcher's radio, or on the chat now inert under the board,
 * where the stack's plain keys never reach. The board takes it, so ⏎, 1, 2 and → answer at once,
 * on every pick: a click, ⌘⌥2, the switcher's arrows, or Board picked again while it shows. Focus
 * anywhere else that still counts, the sidebar or a field being typed in say, stays.
 */
const takesFocusOnOpen = (active: Element | null) =>
  active === null ||
  active === document.body ||
  active.closest('[data-testid="view-switcher"], [inert]') !== null;

function RailBoard({ state }: { state: WorkspaceState }) {
  const workspaceId = state.workspace.id;
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const take = () => {
      if (takesFocusOnOpen(document.activeElement)) root.current?.focus({ preventScroll: true });
    };
    take();
    // Picked again while it shows: nothing mounts, so the pick itself says so.
    return useViewStore.subscribe((view, previous) => {
      if (view.picks !== previous.picks && view.view === "board") take();
    });
  }, []);
  const cards = useFeatureCards(workspaceId);
  const facts = useRailFacts(workspaceId);
  // Show finished: archived workers, and the lines whose work is over, back on the Board.
  const finishedShown = useLayoutStore((s) => s.boardArchivedShown.includes(workspaceId));
  const openWorker = useOpenWorker();
  // A worker that asks is a click from its ask in the dock below; ⌘-click or ⌥-click still opens it.
  const asks = useWorkspaceAsks().find((w) => w.workspaceId === workspaceId)?.asks;
  const askOf = useMemo(() => {
    const keys = askKeysByThread(asks ?? []);
    const byKey = new Map((asks ?? []).map((ask) => [ask.key, ask]));
    return new Map(
      [...keys].flatMap(([threadId, key]) => {
        const ask = byKey.get(key);
        return ask === undefined ? [] : [[threadId, ask] as const];
      }),
    );
  }, [asks]);
  const asking = useMemo(() => new Set(askOf.keys()), [askOf]);
  const onOpen = (threadId: ThreadId, event: MouseEvent) => {
    const ask = askOf.get(threadId);
    if (ask !== undefined && !event.metaKey && !event.ctrlKey && !event.altKey) {
      showAsk(workspaceId, ask);
      return;
    }
    openWorker(threadId, event);
  };
  const setStage = useSetStage(workspaceId);
  const rows = useMemo(
    () => boardRows(railRows(cards, facts, finishedShown ? "all" : "shown"), finishedShown),
    [cards, facts, finishedShown],
  );
  // What Show finished would add: counted against the Board as it shows with them hidden.
  const hidden = useMemo(
    () => hiddenWorkerCount(cards, boardRows(railRows(cards, facts), false)),
    [cards, facts],
  );
  const entries = useMemo(() => railEntries(rows, state.groups), [rows, state.groups]);
  // Each lane as wide as its cards need; in a pane too narrow for that, a list by station.
  const counts = useMemo(() => laneCounts(rows), [rows]);
  const width = usePaneWidth(root);
  const listed = width !== undefined && width < lanesMinWidth(counts);
  // Every open editor keeps its group's local draft mounted, even after another row takes focus.
  const [editingGroups, setEditingGroups] = useState<ReadonlySet<string>>(() => new Set());
  const waiting = useBoardWaiting(state);
  const bandOpen = useBoardBand((s) => s.open[workspaceId] === true) && waiting.count > 0;
  const band = useRef<HTMLElement>(null);
  useEffect(() => {
    if (bandOpen) band.current?.scrollIntoView({ block: "nearest" });
  }, [bandOpen]);
  const line = (row: RailRow, place?: RowPlace) => (
    <FeatureLine
      key={row.feature}
      row={row}
      stage={state.stages?.[row.feature]}
      needsMark={row.group === undefined}
      repos={state.workspace.projectIds.length > 1}
      asking={asking}
      onOpen={onOpen}
      place={place}
      stacked={listed}
    />
  );
  // A rule under every line but the last, as `divide-y` drew it: the list's last drawn child isn't
  // its last line.
  const placed = (place: RowPlace, index: number): RowPlace =>
    index === entries.length - 1
      ? place
      : { ...place, className: cn(place.className, "border-b border-border/60") };

  return (
    <div
      ref={root}
      tabIndex={-1}
      data-ask-scope
      data-testid="rail-board"
      className="flex min-h-0 flex-1 flex-col outline-none"
    >
      <BoardHeader
        state={state}
        hidden={hidden}
        waiting={waiting.count}
        waitingOpen={bandOpen}
        onWaiting={() => useBoardBand.getState().setOpen(workspaceId, !bandOpen)}
      />
      {/* Failures first: above the lines and what waits on you, and never scrolled away. */}
      <FailuresCard workspaceId={workspaceId} className="shrink-0 px-4 pt-2 pb-1" />
      {/* One scroller for the band and the lines: the band grows to hold what waits on you, its
          questions' choices whole, and scrolls away with the Board rather than in a box of its own. */}
      <div
        data-testid="rail-scroller"
        data-layout={listed ? "stacked" : "lanes"}
        className="min-h-0 flex-1 overflow-y-auto pb-4"
        style={{ "--board-lanes": laneTemplate(counts) } as CSSProperties}
      >
        <Expand open={bandOpen}>
          <section
            ref={band}
            id={WAITING_BAND}
            data-testid="rail-waiting"
            aria-label="Waiting on you"
            className="border-t border-border/60 px-4 py-2"
          >
            {waiting.count > 0 && <WaitingList state={state} waiting={waiting} shown={bandOpen} />}
          </section>
        </Expand>
        {!listed && rows.length > 0 && <LaneHeads counts={counts} />}
        {rows.length === 0 ? (
          <div
            role="status"
            data-testid="rail-empty"
            className="flex flex-col items-center gap-1 p-10 text-center text-sm text-muted-foreground"
          >
            <Columns3
              aria-hidden
              ref={drawOn}
              strokeWidth={1.5}
              className="mb-1 size-6 opacity-70"
            />
            {hidden > 0 ? (
              <>
                {/* Its finished work is in Done, as the sidebar has it; Show finished brings it here. */}
                <p className="text-foreground">Nothing going now</p>
                <p className="text-xs">Finished work is in Done.</p>
              </>
            ) : (
              <>
                <p className="text-foreground">No features yet</p>
                <p className="text-xs">Ask the orchestrator to build one.</p>
              </>
            )}
          </div>
        ) : (
          <GlideList id={`rail-${workspaceId}`}>
            {/* Only the lines near the view draw: a workspace may hold many. */}
            <VirtualRows
              as="ul"
              label="Features"
              bare
              items={entries}
              rowKey={entryKey}
              estimate={LINE_HEIGHT}
              overscan={LINE_OVERSCAN}
              retainedKeys={editingGroups}
            >
              {(entry, index, place) =>
                entry.kind === "line" ? (
                  entry.headed === true ? (
                    <OtherLine place={placed(place, index)}>{line(entry.row)}</OtherLine>
                  ) : (
                    line(entry.row, placed(place, index))
                  )
                ) : (
                  <GroupBand
                    workspaceId={workspaceId}
                    group={entry.group}
                    setStage={setStage}
                    editing={editingGroups.has(entryKey(entry))}
                    onEditingChange={(editing) =>
                      setEditingGroups((previous) => {
                        const next = new Set(previous);
                        if (editing) next.add(entryKey(entry));
                        else next.delete(entryKey(entry));
                        return next;
                      })
                    }
                    place={placed(place, index)}
                  >
                    {entry.group.rows.map((row) => line(row))}
                  </GroupBand>
                )
              }
            </VirtualRows>
          </GlideList>
        )}
      </div>
      <div className="shrink-0 pb-3">
        <AskStack workspaceId={workspaceId} focused />
      </div>
    </div>
  );
}

/** The Board: the workspace as feature lines, with the ask stack docked below. */
export function BoardView({ workspaceId }: ViewProps) {
  // The frame offers Board only with a workspace to show.
  const state = useWorkspaces().find((each) => each.workspace.id === workspaceId);
  if (state === undefined) return null;
  return <RailBoard state={state} />;
}
