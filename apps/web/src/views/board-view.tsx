import type { ThreadId, WorkspaceId, WorkspaceState } from "@gram/contracts";
import { Columns3 } from "lucide-react";
import { useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { EmptyState } from "@/components/empty-state";
import { useSubscription } from "@/lib/effects";
import { usePhone } from "@/lib/use-phone";
import { cn } from "@/lib/utils";
import { VirtualRows, type RowPlace } from "@/lib/virtual-rows";
import { GlideList } from "@/motion";
import { askKeysByThread } from "@/orchestration/ask-model";
import { UndoLine } from "@/inbox/inbox-line";
import { showInboxAsk } from "@/inbox/inbox-store";
import { useWorkspaceAsks } from "@/orchestration/ask-stack";
import { FailuresCard } from "@/orchestration/failures-card";
import { NoCiNote } from "@/orchestration/no-ci-note";
import { useOpenWorker, useRailFacts } from "@/orchestration/feature-sheet";
import {
  boardRows,
  hiddenWorkerCount,
  railEntries,
  railRows,
  type RailEntry,
  type RailRow,
} from "@/orchestration/rail-model";
import {
  boardClashes,
  boardPeople,
  ownersOf,
  ownersText,
  personByWorker,
  personName,
  rowsFor,
  sharedBoard,
  type PersonKey,
} from "@/orchestration/board-people";
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
import { ClashLine, PeopleStrip, usePeopleNames } from "./board-people";
import { useViewStore } from "./view-store";

/** What a view is given: the workspace the window is on, if any. */
export interface ViewProps {
  readonly workspaceId: WorkspaceId | undefined;
}

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

const GRID_LINE_HEIGHT = 56;
const LINE_OVERSCAN = 3;

const entryKey = (entry: RailEntry) =>
  entry.kind === "line" ? `line:${entry.row.feature}` : `group:${entry.group.group}`;

const takesFocusOnOpen = (active: Element | null) =>
  active === null ||
  active === document.body ||
  active.closest('[data-testid="view-switcher"], [inert]') !== null;

function RailBoard({ state }: { state: WorkspaceState }) {
  const workspaceId = state.workspace.id;
  const root = useRef<HTMLDivElement>(null);
  useSubscription(() => {
    const take = () => {
      if (takesFocusOnOpen(document.activeElement)) root.current?.focus({ preventScroll: true });
    };
    take();
    return useViewStore.subscribe((view, previous) => {
      if (view.picks !== previous.picks && view.view === "board") take();
    });
  }, []);
  const cards = useFeatureCards(workspaceId);
  const facts = useRailFacts(workspaceId);
  const finishedShown = useLayoutStore((s) => s.boardArchivedShown.includes(workspaceId));
  const openWorker = useOpenWorker();
  const messageOrchestrator = useMessageOrchestrator();
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
  const allRows = useMemo(
    () => boardRows(railRows(cards, facts, finishedShown ? "all" : "shown"), finishedShown),
    [cards, facts, finishedShown],
  );
  const shared = useMemo(() => sharedBoard(allRows), [allRows]);
  const people = usePeopleNames(
    useMemo(() => (shared ? [...new Set(allRows.flatMap(ownersOf))] : []), [allRows, shared]),
  );
  const [picked, setPicked] = useState<PersonKey | undefined>(undefined);
  const pick = shared ? picked : undefined;
  const rows = useMemo(() => rowsFor(allRows, pick), [allRows, pick]);
  const persons = useMemo(() => (shared ? personByWorker(allRows) : undefined), [allRows, shared]);
  const done = useMemo(
    () => (finishedShown ? [] : doneRows(railRows(cards, facts, "all"))),
    [cards, facts, finishedShown],
  );
  const hidden = useMemo(
    () => hiddenWorkerCount(cards, boardRows(railRows(cards, facts), false)),
    [cards, facts],
  );
  const entries = useMemo(() => railEntries(rows, state.groups), [rows, state.groups]);
  const phone = usePhone();
  const [editingGroups, setEditingGroups] = useState<ReadonlySet<string>>(() => new Set());
  const repos = useMemo(() => new Set(rows.flatMap((row) => row.projects)).size > 1, [rows]);
  const ownerOf = (threadId: ThreadId) => {
    const key = persons?.get(threadId);
    return key === undefined ? undefined : personName(key, people);
  };
  const line = (row: RailRow, place?: RowPlace) => (
    <GridLine
      key={row.feature}
      row={row}
      owners={shared ? ownersText(ownersOf(row), people) : undefined}
      ownerOf={shared && ownersOf(row).length > 1 ? ownerOf : undefined}
      stage={state.stages?.[row.feature]}
      needsMark={row.group === undefined}
      repos={repos}
      asking={asking}
      onOpen={onOpen}
      place={place}
    />
  );
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
      <FailuresCard workspaceId={workspaceId} className="shrink-0 px-4 pt-2 pb-1" />
      {shared && !phone && (
        <>
          <ClashLine
            clashes={boardClashes(allRows, people?.you)}
            names={people}
            workspaceId={workspaceId}
            onOpen={onOpen}
            onMessage={messageOrchestrator}
          />
          <PeopleStrip
            people={boardPeople(allRows, people?.you)}
            names={people}
            picked={pick}
            onPick={setPicked}
          />
        </>
      )}
      <NoCiNote workspaceId={workspaceId} className="shrink-0 px-4 pt-1.5 pb-1" />
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
  const state = useWorkspaces().find((each) => each.workspace.id === workspaceId);
  if (state === undefined) return null;
  return <RailBoard state={state} />;
}
