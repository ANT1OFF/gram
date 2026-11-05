import { Menu } from "@base-ui/react/menu";
import {
  FEATURE_STATIONS,
  STATION_LABELS,
  workerHasOngoingWork,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import { useLocation } from "@tanstack/react-router";
import {
  ChevronRight,
  CircleAlert,
  CircleDot,
  Ellipsis,
  GitMerge,
  Hourglass,
  Pencil,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { returnFocusTo, useOpener } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";
import { ExpandPresence, Spinner } from "@/motion";
import { useOpenThread } from "@/shell/thread-switcher";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { useSame } from "@/stores/use-same";
import { Dialog, DialogShell } from "@/thread/dialog-shell";
import { useViewStore } from "@/views/view-store";

import { useAnsweredWorkers } from "./needs-you-store";
import { startOrchestratorMessage } from "./ask-about";
import { useWorkspaceAsks } from "./ask-stack";
import { PrChip } from "./feature-card";
import { openFeatureSheet, useFeatureSheet } from "./feature-sheet-store";
import {
  aboutFeature,
  featureSheet,
  FEATURE_MENU,
  featureMenuLabel,
  type FeatureMenuItem,
  type FeatureMenuState,
} from "./feature-sheet-model";
import { askKeysByThread } from "./ask-model";
import { featureQuestions } from "./question-card-model";
import { WorkerQuestionHistory, WorkerQuestionList } from "./question-entry";
import { groupNames, type RailFacts, type RailRow, type RailTone } from "./rail-model";
import { StageEditor } from "./stage-editor";
import { groupSlug } from "./stage-model";
import { StageStepper } from "./stage-stepper";
import { useSetGroup, useSetStage } from "./use-board-actions";
import { useFeatureCards, useFeatureSummary } from "./use-feature-cards";
import { useOrchestratorLedger, useWorkspaces } from "./use-orchestration";
import { StatusDot } from "./status-dot";
import { STATUS_WORDS } from "./status-words";
import { useWorkerWaitings } from "./use-waiting-on";
import { useWorkersListStore } from "./workers-list";
import { workingWorkerThreads } from "./tree-model";
import { ledgerWorkersOver, workerActivities, workerTones } from "./workers-model";

// A feature you can open and act on:
// a sheet from the right with its stations, PRs and workers, opened from its Board line or its card
// in the stream, and the feature's menu: Open, Ask about it, Pause (Resume), Rename, Archive.

/** A chip's tone as an icon, on the Board and in the sheet. */
export const RAIL_TONES: Readonly<
  Record<RailTone, { icon: LucideIcon; tone: string; label: string }>
> = {
  needs: { icon: CircleAlert, tone: "text-status-needs-mark", label: STATUS_WORDS.needs },
  attention: { icon: CircleDot, tone: "text-status-idle", label: STATUS_WORDS.attention },
  error: { icon: CircleAlert, tone: "text-destructive", label: STATUS_WORDS.error },
  working: { icon: Spinner, tone: "text-status-working", label: STATUS_WORDS.working },
  waiting: { icon: Hourglass, tone: "text-status-working", label: STATUS_WORDS.waiting },
  idle: { icon: CircleDot, tone: "text-status-idle", label: STATUS_WORDS.idle },
  merged: { icon: GitMerge, tone: "text-merged", label: STATUS_WORDS.merged },
};

/** Who has an open ask in the workspace's stack, and each thread's live status. */
export function useRailFacts(workspaceId: WorkspaceId | undefined): RailFacts {
  const all = useWorkspaceAsks();
  const cards = useFeatureCards(workspaceId);
  const workers = useMemo(
    () => cards.flatMap((card) => card.workers.map((worker) => worker.threadId)),
    [cards],
  );
  // The status of the workers on the cards only: a change to any other thread, or to anything
  // but a worker's status, leaves the Board still.
  const statuses = useThreadsStore(
    useSame((s) =>
      Object.fromEntries(workers.map((threadId) => [threadId, s.byId[threadId]?.status])),
    ),
  );
  const ledger = useOrchestratorLedger(workspaceId).data;
  // What each worker does at rest, by the selector Quiet and the sidebar share: only a change to
  // what it reads moves the Board.
  const activity = useThreadsStore(
    useSame((s) => workerActivities(ledger, s.byId, s.statusDetail)),
  );
  // Which workers show is the sidebar's rule (`workerShown`): the ledger's, while their work isn't
  // over by Done's rule; one a card keeps after it closed is gone. And who is at work now.
  const over = useThreadsStore(
    useSame((s) => (ledger === undefined ? undefined : ledgerWorkersOver(ledger, s.byId))),
  );
  const running = useThreadsStore(
    useSame(
      (s) =>
        new Set(
          workspaceId === undefined
            ? []
            : workingWorkerThreads(s.byId, s.statusDetail, workspaceId).map((t) => t.thread.id),
        ),
    ),
  );
  // Merged or delivered workers the ledger still sees at work, so their line isn't done yet.
  const ongoing = useMemo(
    () =>
      new Set(
        (ledger?.features ?? []).flatMap((feature) =>
          feature.workers.flatMap((worker) =>
            workerHasOngoingWork(worker) ? [worker.threadId] : [],
          ),
        ),
      ),
    [ledger],
  );
  // Who an ask in the stack is from, so its chip says so too: the ask itself lives once, below.
  const asking = useMemo(
    () =>
      new Set(
        askKeysByThread(all.find((each) => each.workspaceId === workspaceId)?.asks ?? []).keys(),
      ),
    [all, workspaceId],
  );
  // Who was answered here and isn't heard from yet: no longer asking, on its way back to work.
  const answered = useAnsweredWorkers();
  // Each live worker's tone, by the selector the sidebar, ⌘J and Quiet read too.
  const tones = useThreadsStore(
    useSame(
      (s) =>
        workerTones(
          ledger,
          workspaceId === undefined
            ? []
            : workingWorkerThreads(s.byId, s.statusDetail, workspaceId).map((t) => t.thread.id),
          { byId: s.byId, statusDetail: s.statusDetail, asking, answered },
        ).tones,
    ),
  );
  // What each one at rest waits on, in the sidebar's and ⌘J's words.
  const waiting = useWorkerWaitings(ledger, asking);
  return useMemo(
    () => ({
      asking,
      answered,
      ongoing,
      activity,
      tones,
      over,
      running,
      waiting,
      // A thread on no card isn't drawn here; it reads as it stands, as before.
      status: (threadId) =>
        Object.hasOwn(statuses, threadId)
          ? statuses[threadId]
          : useThreadsStore.getState().byId[threadId]?.status,
    }),
    [asking, answered, ongoing, activity, tones, over, running, waiting, statuses],
  );
}

/** A worker's name opens it; ⌘-click keeps it beside the chat, as ⌘\ does. */
export function useOpenWorker() {
  const open = useOpenThread();
  return (threadId: ThreadId, event: MouseEvent) => {
    useFeatureSheet.getState().close(false);
    if (event.metaKey || event.ctrlKey) {
      const layout = useLayoutStore.getState();
      if (layout.grid.preset === "1") layout.toggleSplit(threadId);
      else layout.openInPane(threadId, 1);
      useViewStore.getState().setView("chat");
      return;
    }
    useWorkersListStore.getState().opened(threadId);
    open(threadId);
  };
}

const notifyError = (title: string, error: unknown) =>
  useThreadsStore
    .getState()
    .applyEvent({ type: "notify", kind: "error", title, body: errorMessage(error) });

/** What the feature's menu does, wherever it shows. */
function useFeatureActions(workspaceId: WorkspaceId) {
  const api = useApi();
  const open = useOpenThread();
  const state = useWorkspaces().find((each) => each.workspace.id === workspaceId);
  const orchestrator = state?.workspace.orchestratorThreadId;
  const cards = useFeatureCards(workspaceId);
  const groups = useMemo(() => groupNames(state?.groups, cards), [state?.groups, cards]);
  const setGroup = useSetGroup(workspaceId);
  return {
    /** Every group a feature can be moved to. */
    groups,
    /** Each feature's stage, from the workspace. */
    stages: state?.stages,
    setGroup,
    /** Starts a message to the orchestrator about the feature, in Chat; nothing is sent. */
    ask:
      orchestrator === undefined
        ? undefined
        : (row: RailRow) => {
            useFeatureSheet.getState().close(false);
            useViewStore.getState().setView("chat");
            startOrchestratorMessage(orchestrator, aboutFeature(row), open);
          },
    archive: (feature: string) => {
      api.archiveFeature(workspaceId, feature).then(
        () => useFeatureSheet.getState().close(),
        (error: unknown) => notifyError(`Couldn't archive ${feature}`, error),
      );
    },
    /** Pauses the feature, or resumes it when it is paused. */
    togglePause: (feature: string, paused: boolean) => {
      api
        .setFeaturePaused(workspaceId, feature, !paused)
        .catch((error: unknown) =>
          notifyError(`Couldn't ${paused ? "resume" : "pause"} ${feature}`, error),
        );
    },
  };
}

/** Rename…: the feature's new slug, refused with the server's reason; the sheet follows it. */
function RenameFeatureDialog({
  workspaceId,
  feature,
  onClose,
}: {
  workspaceId: WorkspaceId;
  feature: string;
  onClose: () => void;
}) {
  const api = useApi();
  const [name, setName] = useState(feature);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const next = name.trim();
  const submit = async () => {
    if (next === "" || pending) return;
    if (next === feature) return onClose();
    setPending(true);
    try {
      const to = await api.renameFeature(workspaceId, feature, next);
      const sheet = useFeatureSheet.getState();
      if (sheet.open && sheet.target?.feature === feature) openFeatureSheet(workspaceId, to);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setPending(false);
    }
  };
  return (
    <DialogShell
      testId="feature-rename-dialog"
      title="Rename feature"
      description="The orchestrator is told the new name. Branches keep theirs."
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          aria-label="Feature name"
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-reading outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError(undefined);
          }}
        />
        {error && (
          <p role="alert" className="text-reading text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
            Cancel
          </Dialog.Close>
          <Button type="submit" size="sm" disabled={next === "" || pending}>
            Rename
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}

/** New group…: names a group for the feature, shown as the slug the server will keep. */
function NewGroupDialog({
  feature,
  setGroup,
  onClose,
}: {
  feature: string;
  setGroup: (feature: string, group: string | undefined) => Promise<boolean>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const slug = groupSlug(name);
  const submit = async () => {
    if (slug === undefined || pending) return;
    setPending(true);
    if (await setGroup(feature, slug)) onClose();
    else setPending(false);
  };
  return (
    <DialogShell
      testId="feature-new-group-dialog"
      title="New group"
      description={`Groups ${feature} with others run as one effort, such as a release.`}
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          aria-label="Group name"
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          placeholder="release-0-4"
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-reading outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
            Cancel
          </Dialog.Close>
          <Button type="submit" size="sm" disabled={slug === undefined || pending}>
            {slug === undefined || slug === name ? "Move" : `Move to ${slug}`}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}

/** "Paused", beside a feature's name on the Board and in its sheet. */
export function PausedBadge({ testId }: { testId: string }) {
  return (
    <span
      data-testid={testId}
      className="shrink-0 rounded-sm bg-muted px-1.5 text-meta font-normal text-muted-foreground"
    >
      Paused
    </span>
  );
}

const MENU_POPUP =
  "z-50 min-w-40 origin-(--transform-origin) rounded-md border border-edge bg-popover p-1 text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";
const MENU_SEPARATOR = "my-1 h-px bg-border";
const MENU_ITEM =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-meta outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:row-cursor";

/** The feature's menu; in its own sheet, without Open. */
export function FeatureMenu({
  row,
  inSheet = false,
  className,
}: {
  row: RailRow;
  inSheet?: boolean;
  className?: string;
}) {
  const actions = useFeatureActions(row.card.workspaceId);
  const paused = row.card.paused === true;
  const staged = actions.stages?.[row.feature] !== undefined;
  const [renaming, setRenaming] = useState(false);
  const [grouping, setGrouping] = useState(false);
  const run: Record<FeatureMenuItem, (() => void) | undefined> = {
    Open: () => openFeatureSheet(row.card.workspaceId, row.feature),
    "Ask about it": actions.ask === undefined ? undefined : () => actions.ask?.(row),
    // The editor lives in the sheet, which this opens, or is already.
    "Set stage": () =>
      inSheet
        ? useFeatureSheet.getState().editStage(true)
        : openFeatureSheet(row.card.workspaceId, row.feature, true),
    // A submenu: its items run themselves.
    "Move to group": undefined,
    Pause: () => actions.togglePause(row.feature, paused),
    Rename: () => setRenaming(true),
    Archive: () => actions.archive(row.feature),
  };
  return (
    <>
      {renaming && (
        <RenameFeatureDialog
          workspaceId={row.card.workspaceId}
          feature={row.feature}
          onClose={() => setRenaming(false)}
        />
      )}
      {grouping && (
        <NewGroupDialog
          feature={row.feature}
          setGroup={actions.setGroup}
          onClose={() => setGrouping(false)}
        />
      )}
      <FeatureMenuList
        row={row}
        inSheet={inSheet}
        state={{ paused, staged }}
        run={run}
        groups={actions.groups}
        onMove={(group) => void actions.setGroup(row.feature, group)}
        onNewGroup={() => setGrouping(true)}
        className={className}
      />
    </>
  );
}

function FeatureMenuList({
  row,
  inSheet,
  state,
  run,
  groups,
  onMove,
  onNewGroup,
  className,
}: {
  row: RailRow;
  inSheet: boolean;
  state: FeatureMenuState;
  run: Record<FeatureMenuItem, (() => void) | undefined>;
  groups: readonly string[];
  /** Into a group, or out of its own with `undefined`. */
  onMove: (group: string | undefined) => void;
  onNewGroup: () => void;
  className: string | undefined;
}) {
  const others = groups.filter((group) => group !== row.group);
  return (
    <Menu.Root>
      <Menu.Trigger
        data-testid="feature-menu"
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`${row.feature} menu`}
            title={`${row.feature} menu`}
            className={className}
          />
        }
      >
        <Ellipsis />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="isolate z-50">
          <Menu.Popup
            data-surface="overlay"
            data-testid="feature-menu-popup"
            className={MENU_POPUP}
          >
            {FEATURE_MENU.filter((item) => !(inSheet && item === "Open")).map((item) =>
              item === "Move to group" ? (
                <Menu.SubmenuRoot key={item}>
                  <Menu.SubmenuTrigger
                    data-testid="feature-menu-group"
                    className={cn(MENU_ITEM, "data-[popup-open]:bg-accent")}
                  >
                    {featureMenuLabel(item, state)}
                    <ChevronRight aria-hidden className="ml-auto size-icon-chip" />
                  </Menu.SubmenuTrigger>
                  <Menu.Portal>
                    <Menu.Positioner side="right" alignOffset={-4} className="isolate z-50">
                      <Menu.Popup
                        data-surface="overlay"
                        data-testid="feature-group-menu"
                        aria-label="Move to group"
                        className={MENU_POPUP}
                      >
                        {others.map((group) => (
                          <Menu.Item
                            key={group}
                            className={MENU_ITEM}
                            onClick={() => onMove(group)}
                          >
                            {group}
                          </Menu.Item>
                        ))}
                        {others.length > 0 && <Menu.Separator className={MENU_SEPARATOR} />}
                        <Menu.Item className={MENU_ITEM} onClick={onNewGroup}>
                          New group…
                        </Menu.Item>
                        {row.group !== undefined && (
                          <Menu.Item className={MENU_ITEM} onClick={() => onMove(undefined)}>
                            Remove from {row.group}
                          </Menu.Item>
                        )}
                      </Menu.Popup>
                    </Menu.Positioner>
                  </Menu.Portal>
                </Menu.SubmenuRoot>
              ) : (
                <Menu.Item
                  key={item}
                  className={MENU_ITEM}
                  disabled={run[item] === undefined}
                  onClick={() => run[item]?.()}
                >
                  {featureMenuLabel(item, state)}
                </Menu.Item>
              ),
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function SheetBody({
  workspaceId,
  feature,
  titleId,
}: {
  workspaceId: WorkspaceId;
  feature: string;
  titleId: string;
}) {
  const cards = useFeatureCards(workspaceId);
  const facts = useRailFacts(workspaceId);
  const card = cards.find((each) => each.feature === feature);
  const sheet = useMemo(
    () => (card === undefined ? undefined : featureSheet(card, facts)),
    [card, facts],
  );
  const onOpen = useOpenWorker();
  const close = useFeatureSheet((s) => s.close);
  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <h2 id={titleId} className="min-w-0 truncate text-title">
          {feature}
        </h2>
        {sheet !== undefined && sheet.needs > 0 && (
          <span
            data-testid="feature-sheet-needs"
            className="shrink-0 rounded-sm border border-status-needs-mark/60 px-1.5 text-meta text-status-needs tabular-nums"
          >
            {sheet.needs} need you
          </span>
        )}
        {card?.paused === true && <PausedBadge testId="feature-sheet-paused" />}
        <span className="flex-1" />
        {sheet !== undefined && <FeatureMenu row={sheet.row} inSheet />}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Close"
          title="Close"
          onClick={() => close()}
        >
          <X />
        </Button>
      </header>
      {sheet === undefined ? (
        <p role="status" className="p-5 text-reading text-muted-foreground">
          No workers left on it.
        </p>
      ) : (
        <SheetContent workspaceId={workspaceId} sheet={sheet} onOpen={onOpen} />
      )}
    </>
  );
}

const SHEET_LABEL = "text-meta font-medium text-muted-foreground";

/** Where the feature stands in its plan, which a click on a step moves, and the plan's editor. */
function StageSection({ workspaceId, feature }: { workspaceId: WorkspaceId; feature: string }) {
  const stage = useWorkspaces().find((each) => each.workspace.id === workspaceId)?.stages?.[
    feature
  ];
  const setStage = useSetStage(workspaceId);
  const editing = useFeatureSheet((s) => s.editingStage);
  const editStage = useFeatureSheet((s) => s.editStage);
  return (
    <section aria-label="Stage" data-testid="feature-sheet-stage" className="flex flex-col gap-1.5">
      <h3 className="flex items-center gap-2">
        <span className={SHEET_LABEL}>Stage</span>
        {!editing && (
          <button
            type="button"
            data-testid="feature-sheet-plan"
            onClick={() => editStage(true)}
            className="inline-flex items-center gap-1 rounded-sm text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Pencil aria-hidden className="size-icon-row" />
            {stage === undefined ? "Set stage" : "Edit plan"}
          </button>
        )}
      </h3>
      {stage !== undefined ? (
        <StageStepper
          stage={stage}
          subject={feature}
          onSelect={(name) => {
            if (name !== stage.stage) void setStage({ feature }, { stage: name });
          }}
        />
      ) : (
        !editing && <p className="text-meta text-muted-foreground">None set.</p>
      )}
      <ExpandPresence open={editing}>
        <StageEditor
          subject={feature}
          stage={stage}
          onSave={(input) => setStage({ feature }, input)}
          onCancel={() => editStage(false)}
        />
      </ExpandPresence>
    </section>
  );
}

/**
 * The feature's worker questions: those forwarded to the user, answered in the ask sheet, then the rest
 * with who answered and when (docs/design/worker-questions.md).
 */
function QuestionsSection({ workspaceId, feature }: { workspaceId: WorkspaceId; feature: string }) {
  const ledger = useOrchestratorLedger(workspaceId).data;
  const questions = useMemo(() => featureQuestions(ledger, feature), [ledger, feature]);
  if (questions.length === 0) return null;
  const forwarded = questions.filter((question) => question.stage === "forwarded");
  const rest = questions.filter((question) => question.stage !== "forwarded");
  return (
    <section
      aria-label="Questions"
      data-testid="feature-sheet-questions"
      className="flex flex-col gap-1.5"
    >
      <h3 className={SHEET_LABEL}>Questions</h3>
      {forwarded.length > 0 && (
        <WorkerQuestionList questions={forwarded} workspaceId={workspaceId} compact />
      )}
      {rest.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rest.map((question) => (
            <li key={question.id}>
              <WorkerQuestionHistory question={question} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SheetContent({
  workspaceId,
  sheet,
  onOpen,
}: {
  workspaceId: WorkspaceId;
  sheet: NonNullable<ReturnType<typeof featureSheet>>;
  onOpen: (threadId: ThreadId, event: MouseEvent) => void;
}) {
  const summary = useFeatureSummary(sheet.row.card);
  const label = SHEET_LABEL;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 text-reading">
      <ol
        aria-label="Stations"
        data-testid="feature-sheet-stations"
        className="grid grid-cols-5 gap-1 text-center text-meta"
      >
        {FEATURE_STATIONS.map((station, index) => (
          <li
            key={station}
            data-station={station}
            data-count={sheet.counts[station]}
            className={cn(
              "flex flex-col items-center gap-0.5 border-t-2 pt-1.5",
              index <= sheet.row.reach ? "border-muted-foreground" : "border-border",
            )}
          >
            <span className="text-muted-foreground">{STATION_LABELS[station]}</span>
            <b
              className={cn(
                "text-reading font-medium tabular-nums",
                sheet.counts[station] === 0 && "text-muted-foreground/60",
              )}
            >
              {sheet.counts[station]}
            </b>
          </li>
        ))}
      </ol>
      {summary !== undefined && (
        <p data-testid="feature-sheet-summary" className="text-foreground/80">
          {summary}
        </p>
      )}
      <StageSection workspaceId={workspaceId} feature={sheet.row.feature} />
      <QuestionsSection workspaceId={workspaceId} feature={sheet.row.feature} />
      {sheet.prs.length > 0 && (
        <section aria-label="Pull requests" className="flex flex-col gap-1.5">
          <h3 className={label}>Pull requests</h3>
          <ul className="flex flex-col gap-1">
            {sheet.prs.map(({ pr, by }) => (
              <li
                key={`${pr.repo}#${pr.number}`}
                data-testid="feature-sheet-pr"
                className="flex min-w-0 items-center gap-2 text-meta"
              >
                <PrChip pr={pr} />
                <span className="min-w-0 truncate text-muted-foreground">{by}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label="Workers" className="flex flex-col gap-1.5">
        <h3 className={label}>Workers</h3>
        <ul className="flex flex-col gap-0.5">
          {sheet.workers.map((worker) => {
            const tone = RAIL_TONES[worker.tone];
            return (
              <li
                key={worker.threadId}
                data-testid="feature-sheet-worker"
                data-thread-id={worker.threadId}
                data-tone={worker.tone}
                className="flex min-w-0 items-center gap-2 text-meta"
              >
                <StatusDot state={worker.tone} label={tone.label} />
                <button
                  type="button"
                  onClick={(event) => onOpen(worker.threadId, event)}
                  className="min-w-0 truncate rounded-sm text-left font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {worker.title}
                </button>
                <span
                  title={worker.waiting?.hint}
                  className="ml-auto min-w-0 shrink-0 truncate text-muted-foreground"
                >
                  {worker.now}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

const FEATURE_SHEET_TEST_ID = "feature-sheet";

/** The feature sheet, mounted once. Esc, the close button or going anywhere else closes it. */
export function FeatureSheet() {
  const open = useFeatureSheet((s) => s.open);
  const target = useFeatureSheet((s) => s.target);
  const close = useFeatureSheet((s) => s.close);
  const opener = useOpener(open);
  const titleId = useId();
  useCloseOnNavigate(open, close);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          data-testid={FEATURE_SHEET_TEST_ID}
          data-surface="overlay"
          data-feature={target?.feature}
          aria-labelledby={titleId}
          // Asking about it or opening a worker moves focus on purpose.
          finalFocus={() =>
            useFeatureSheet.getState().returnFocus ? returnFocusTo(opener)() : false
          }
          className="fixed inset-y-2 end-2 z-50 flex w-[min(28rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-lg border border-edge bg-popover text-popover-foreground shadow-overlay outline-none transition-[translate,opacity] duration-(--dur-move-base) ease-(--ease-out) data-[ending-style]:translate-x-6 data-[ending-style]:opacity-0 data-[starting-style]:translate-x-6 data-[starting-style]:opacity-0"
        >
          {target !== undefined && (
            <SheetBody
              workspaceId={target.workspaceId}
              feature={target.feature}
              titleId={titleId}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Closes the sheet when the route changes under it. */
function useCloseOnNavigate(open: boolean, close: () => void) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const openedAt = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!open) {
      openedAt.current = undefined;
      return;
    }
    if (openedAt.current === undefined) openedAt.current = pathname;
    else if (openedAt.current !== pathname) close();
  }, [open, pathname, close]);
}
