import type { ThreadId, WorkspaceId, WorkspaceState } from "@gram/contracts";
import { Columns3 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { EmptyState } from "@/components/empty-state";
import { usePhone } from "@/lib/use-phone";
import { cn } from "@/lib/utils";
import { VirtualRows, type RowPlace } from "@/lib/virtual-rows";
import { GlideList } from "@/motion";
import { askKeysByThread } from "@/orchestration/ask-model";
import { UndoLine } from "@/inbox/inbox-line";
import { showInboxAsk } from "@/inbox/inbox-store";
import { useWorkspaceAsks } from "@/orchestration/ask-stack";
import { FailuresCard } from "@/orchestration/failures-card";
import { useOpenWorker, useRailFacts } from "@/orchestration/feature-sheet";
import {
  boardRows,
  hiddenWorkerCount,
  railEntries,
  railRows,
  type RailEntry,
  type RailRow,
} from "@/orchestration/rail-model";
import { useMessageOrchestrator } from "@/orchestration/message-orchestrator";
import { useSetStage } from "@/orchestration/use-board-actions";
import { useFeatureCards } from "@/orchestration/use-feature-cards";
import { useWorkspaces } from "@/orchestration/use-orchestration";
import { useLayoutStore } from "@/stores/layout";

import { GroupBand } from "./board-group";

import { DoneBand, doneRows } from "./board-done";
import { PhoneBoard } from "./board-phone";
import { GridHeads, GridLine } from "./board-grid";
import { BoardHeader } from "./board-header";
import { useViewStore } from "./view-store";

// The Board view: the workspace as feature lines, and the ask stack docked below: a compact grid,
// a row per feature (board-grid.tsx). Its header carries the workspace's controls and what waits on
// you; lines carry their stage and gather under their group's band; unresolved failures stand in a
// card above them all.

/** What a view is given: the workspace the window is on, if any. */
export interface ViewProps {
  readonly workspaceId: WorkspaceId | undefined;
}

/** The first line in no group under the bands, headed, so it doesn't read as the band's above it. */
function OtherLine({ place, children }: { place: RowPlace; children: ReactNode }) {
  return (
    <li {...place}>
      <p
        data-testid="rail-other"
        className="bg-card/40 px-4 py-2 text-reading font-medium text-muted-foreground"
      >
        Other
      </p>
      <ul aria-label="Features in no group">{children}</ul>
    </li>
  );
}

/** A grid row's height before it draws: a feature with one worker. */
const GRID_LINE_HEIGHT = 56;
/** Lines drawn past each edge of the view: a line is tall, so a few cover a fast scroll. */
const LINE_OVERSCAN = 3;

const entryKey = (entry: RailEntry) =>
  entry.kind === "line" ? `line:${entry.row.feature}` : `group:${entry.group.group}`;

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
  const messageOrchestrator = useMessageOrchestrator();
  // A worker that asks is a click from its ask in the Inbox; ⌘-click or ⌥-click still opens it.
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
      showInboxAsk(ask.key);
      return;
    }
    openWorker(threadId, event);
  };
  const setStage = useSetStage(workspaceId);
  const rows = useMemo(
    () => boardRows(railRows(cards, facts, finishedShown ? "all" : "shown"), finishedShown),
    [cards, facts, finishedShown],
  );
  // Under the lines, what has left them for Done, while finished work is hidden.
  const done = useMemo(
    () => (finishedShown ? [] : doneRows(railRows(cards, facts, "all"))),
    [cards, facts, finishedShown],
  );
  // What Show finished would add: counted against the Board as it shows with them hidden.
  const hidden = useMemo(
    () => hiddenWorkerCount(cards, boardRows(railRows(cards, facts), false)),
    [cards, facts],
  );
  const entries = useMemo(() => railEntries(rows, state.groups), [rows, state.groups]);
  // A phone: a card per task, as the grid's columns don't fit its width.
  const phone = usePhone();
  // Every open editor keeps its group's local draft mounted, even after another row takes focus.
  const [editingGroups, setEditingGroups] = useState<ReadonlySet<string>>(() => new Set());
  // Rows name their repos only when they differ: a workspace whose work is all in one repo (or
  // that has one) says nothing a row would repeat on every line.
  const repos = useMemo(() => new Set(rows.flatMap((row) => row.projects)).size > 1, [rows]);
  const line = (row: RailRow, place?: RowPlace) => (
    <GridLine
      key={row.feature}
      row={row}
      stage={state.stages?.[row.feature]}
      needsMark={row.group === undefined}
      repos={repos}
      asking={asking}
      onOpen={onOpen}
      place={place}
    />
  );
  // A rule under every line but the last, as `divide-y` drew it: the list's last drawn child isn't
  // its last line.
  const placed = (place: RowPlace, index: number): RowPlace =>
    index === entries.length - 1
      ? place
      : {
          ...place,
          className: cn(place.className, "border-b border-border/60"),
        };

  return (
    <div
      ref={root}
      tabIndex={-1}
      data-ask-scope
      data-testid="rail-board"
      className="flex min-h-0 flex-1 flex-col outline-none"
    >
      <BoardHeader state={state} hidden={hidden} />
      {/* Failures first: above the lines and what waits on you, and never scrolled away. */}
      <FailuresCard workspaceId={workspaceId} className="shrink-0 px-4 pt-2 pb-1" />
      <div
        data-testid="rail-scroller"
        data-layout={phone ? "phone" : "grid"}
        className="min-h-0 flex-1 overflow-y-auto pb-2"
      >
        {phone && (rows.length > 0 || done.length > 0) ? (
          <PhoneBoard rows={rows} done={done} asking={asking} onOpen={onOpen} />
        ) : (
          <div>
            {rows.length > 0 && <GridHeads />}
            {rows.length === 0 ? (
              hidden > 0 ? (
                // Its finished work is in Done, as the sidebar has it; Show finished brings it here.
                <EmptyState
                  testId="rail-empty"
                  icon={Columns3}
                  title="Nothing going now"
                  line="Finished work is in Done."
                  action={{
                    label: `Show finished (${hidden})`,
                    onClick: () => useLayoutStore.getState().toggleBoardArchived(workspaceId),
                  }}
                />
              ) : (
                <EmptyState
                  testId="rail-empty"
                  icon={Columns3}
                  title="No features yet"
                  line="Each task the orchestrator takes on becomes a feature here, with its workers and PRs."
                  action={{
                    label: "Message the orchestrator",
                    onClick: () => messageOrchestrator(workspaceId),
                  }}
                />
              )
            ) : (
              <GlideList id={`rail-${workspaceId}`}>
                {/* Only the lines near the view draw: a workspace may hold many. */}
                <VirtualRows
                  as="ul"
                  label="Features"
                  bare
                  items={entries}
                  rowKey={entryKey}
                  estimate={GRID_LINE_HEIGHT}
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
            <DoneBand workspaceId={workspaceId} rows={done} repos={repos} onOpen={onOpen} />
          </div>
        )}
      </div>
      <UndoLine testId="board-undo" />
    </div>
  );
}

/** The Board: the workspace as feature lines; what it needs from you is in the Inbox. */
export function BoardView({ workspaceId }: ViewProps) {
  // The frame offers Board only with a workspace to show.
  const state = useWorkspaces().find((each) => each.workspace.id === workspaceId);
  if (state === undefined) return null;
  return <RailBoard state={state} />;
}
