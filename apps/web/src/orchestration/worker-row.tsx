import { PreviewCard } from "@base-ui/react/preview-card";
import type { ThreadId } from "@gram/contracts";
import { useParams } from "@tanstack/react-router";
import {
  AlarmClock,
  Bot,
  CircleArrowUp,
  Cpu,
  Flag,
  Gauge,
  GitBranch,
  HardDrive,
  Hourglass,
  LaptopMinimalCheck,
  Link2,
  MessageCircleQuestion,
  Snail,
  Snowflake,
  Tag,
  Timer,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";

import { AgentIcon, agentLabel } from "@/agents/agent-display";
import { keyLabel } from "@/keyboard/registry";
import { agoText, formatRelative, formatStamp } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { PendingRing, Swap } from "@/motion";
import { CARD_SURFACE } from "@/reviews/pr-display";
import { useOpenThread } from "@/shell/thread-switcher";
import { activityLine, SETTLED_AFTER_MS, threadStatusOf } from "@/sidebar/status";
import { useThreadsStore } from "@/stores/threads";
import { workerPauseHint } from "@/thread/orchestration-model";
import { useThreadHeadline } from "@/thread/plan-ui";
import { threadDragProps, WorkerRowMenuItems, rowMenuKeys } from "@/thread/row-menu";
import { type MachineMark } from "@/thread/machine-mark";
import {
  MachineMarker,
  useMachineMark,
  useThreadHost,
  useThreadSent,
} from "@/thread/machine-marker";

import { useWorkspaceAsks } from "./ask-stack";
import { keepBeside, useBesideStore } from "./beside-store";
import { PrChip } from "./feature-card";
import {
  edgeWords,
  featureAddsToTitle,
  nowLineShown,
  plainActivity,
  plainRunning,
  rowTone,
  rowWaiting,
  steplessLine,
  waitShort,
  workLineText,
  type OverviewWorkerRow,
  type ReportNext,
} from "./overview-model";
import { shownPrNumbers, useWorkerPrChips, WorkerPrChips } from "./overview-pr-chips";
import {
  CURRENT_ROW,
  ROW,
  ROW_STATUS,
  ROW_TITLE,
  ROW_TRAIL,
  RowMenu,
  SETTLED,
  STOP,
} from "./overview-section";
import { peek } from "./peek-store";
import {
  ANSWERED,
  edgeBesidePrs,
  nowBesidePrs,
  TONE_DOT,
  workerStarting,
  type RailTone,
} from "./rail-model";
import { RAIL_TONES } from "./rail-tones";
import { StatusDot } from "./status-dot";
import { STARTING, type DotState } from "./status-words";
import { threadWorking } from "./tree-model";
import { PAUSE_WORD, useWorkerPause, WorkerPauseMark, type WorkerPauseState } from "./worker-pause";
import { besideRuns, watchedRuns, type WaitGlyph, type WaitingOn } from "./waiting-on";

type ThreadsState = ReturnType<typeof useThreadsStore.getState>;

/** ⌘/Ctrl on a click: keep the worker beside its orchestrator's chat. */
export const besideKey = (event: Pick<MouseEvent, "metaKey" | "ctrlKey">) =>
  event.metaKey || event.ctrlKey;

const busyThread = (s: ThreadsState, threadId: ThreadId): boolean => {
  const summary = s.byId[threadId];
  return summary !== undefined && threadWorking(summary, s.statusDetail[threadId]);
};

/**
 * What a thread at work is doing, in plain words (`plainActivity`): what kind of thing it runs,
 * never the command or a path. With nothing of its own running, the work left running under it.
 */
export const workLineOf = (s: ThreadsState, threadId: ThreadId): string | undefined => {
  const summary = s.byId[threadId];
  if (summary === undefined) return undefined;
  const activity = activityLine(summary.status, s.statusDetail[threadId], summary.activity);
  const display = threadStatusOf(summary, s.statusDetail[threadId]);
  if (!display.working && display.running === undefined) return undefined;
  if (activity !== undefined) return plainActivity(activity);
  return display.running === undefined ? display.title : plainRunning(display.label);
};

/**
 * What a thread at work is doing, as its row says it: its plan's step and what it runs, else what
 * it runs. An orchestrator has no plan headline, so its line is always what it runs. A needs-you
 * headline is left to the ask stack and the row's glyph.
 */
export const useWorkLine = (
  threadId: ThreadId,
  report?: ReportNext | undefined,
): string | undefined => {
  const { headline } = useThreadHeadline(threadId, plainActivity);
  const running = useThreadsStore((s) => workLineOf(s, threadId));
  const planAt = useThreadsStore((s) => s.byId[threadId]?.plan?.updatedAt);
  return workLineText(headline, planAt, report, running);
};

/**
 * A worker, in either list: a click opens it, where any ask it has shows, ⌥-click peeks and
 * ⌘/Ctrl-click keeps it beside; a right-click (or Shift+F10) opens its menu, and it drags onto a
 * grid pane. Its title line ends in its agent's mark, always; a second line, when it has something
 * to say, holds its PR chips and its words (an ask's question, a failure, a wait's reason, what it
 * is doing) and how long ago it last did something, with its dot a bar beside both. Its name and
 * hover card keep the rest. In the compact rail's flyout it has no hover card of its own
 * (`card={false}`), the flyout being one.
 *
 * `wide` is the right pane's Workers list: the same mark, title, agent, PR chips, words and age, in
 * the same order, with the age on the title's line, the words wrapped to two lines rather than
 * cut, and under them a last line with its plan's steps and the docs it wrote. A worker that
 * asks you to pick between pictures shows the first two under that.
 */
export function WorkerRow({
  row,
  feature,
  updatedAt,
  card = true,
  wide,
  current,
  onOpen,
  at,
  mark,
}: {
  row: OverviewWorkerRow;
  feature: string;
  updatedAt: number;
  card?: boolean;
  /**
   * The right pane's wide row, with the parts only it draws (`worker-row-wide.tsx`): passed in, so
   * the sidebar's row, on the first paint, doesn't load them.
   */
  wide?: WideParts | undefined;
  /** Whether it is drawn current; the thread open in the main view when left out. */
  current?: boolean;
  /** What a click (or ⌘⏎) does in place of opening it in the main view; ⌥-click still peeks. */
  onOpen?: (event: Pick<MouseEvent<HTMLElement>, "metaKey" | "ctrlKey">) => void;
  /** When it last moved, for a worker whose thread is gone (its record's finish). */
  at?: number | undefined;
  /** Its mark, where a finished worker's says more than its tone (done, archived). */
  mark?: DotState | undefined;
}) {
  const openThread = useOpenThread();
  const parts = wide;
  const isWide = parts !== undefined;
  const viewed = useParams({
    strict: false,
    select: (params) => params.threadId === row.threadId,
  });
  const isCurrent = current ?? viewed;
  const lastActivity = useThreadsStore((s) => s.byId[row.threadId]?.thread.lastActivityAt);
  const agent = useThreadsStore((s) => s.byId[row.threadId]?.thread.model?.agent);
  const status = useThreadsStore((s) => s.byId[row.threadId]?.status);
  const unread = useThreadsStore((s) => s.byId[row.threadId]?.thread.unread === true);
  const busy = useThreadsStore((s) => busyThread(s, row.threadId));
  const pause = useWorkerPause(row.threadId, status, row.held);
  const asking = row.askKey !== undefined;
  const question = useAskQuestion(row.askKey);
  const tone = rowTone(row, { status, working: busy });
  const dot = TONE_DOT[tone];
  const working = tone === "working";
  const waiting = rowWaiting(row, tone);
  const runs = watchedRuns(waiting);
  const lineWait = besideRuns(waiting);
  const now = useNow(true, undefined, 60_000);
  const ageAt = at ?? lastActivity;
  const settled =
    tone === "idle" &&
    pause === undefined &&
    lastActivity !== undefined &&
    now - lastActivity >= SETTLED_AFTER_MS;
  const starting =
    tone === "working" && workerStarting({ asking, state: row.state, failed: row.failed, status });
  const routine = working && !starting && !asking && !row.failed && row.now !== ANSWERED;
  const workLine = useWorkLine(row.threadId, row.report);
  const doing = routine && workLine !== undefined ? steplessLine(workLine) : undefined;
  const hostId = useThreadHost(row.threadId);
  const sent = useThreadSent(row.threadId);
  const machine = useMachineMark(hostId, sent);
  const edgeSays =
    starting || (routine ? doing !== undefined : waiting !== undefined || nowLineShown(row));
  const prChips = useWorkerPrChips(row.threadId, row.prs);
  const startedAt = useThreadsStore((s) => s.byId[row.threadId]?.thread.createdAt);
  const hasChips = prChips.length > 0 || runs.length > 0;
  const room = useRef<HTMLSpanElement>(null);
  const roomAt = useRoomAt(room, isWide && hasChips);
  const openOwnPr =
    isWide && onOpen !== undefined
      ? () => {
          onOpen(PLAIN_OPEN);
          useBesideStore.getState().setTab("pr");
        }
      : undefined;
  const twoLines = edgeSays || (!isWide && prChips.length > 0);
  const said =
    question !== undefined ? asksYouLine(question) : (doing ?? waiting?.label ?? row.now);
  const facts = [
    row.title,
    ...(unread ? ["unread"] : []),
    ...(pause === undefined ? [] : [PAUSE_WORD[pause.state]]),
    starting ? STARTING : said,
    ...(machine === undefined ? [] : [machine.words]),
    ...(agent === undefined ? [] : [agentLabel(agent)]),
    ...(ageAt === undefined ? [] : [`last active ${agoText(ageAt, now)}`]),
    ...(startedAt === undefined ? [] : [`started ${formatStamp(startedAt)}`]),
  ];
  const preview = usePickedPreview(isWide);
  const onClick = (event: MouseEvent<HTMLElement>) => {
    preview.picked();
    if (event.altKey) {
      peek({ kind: "worker", threadId: row.threadId, title: row.title }, event.currentTarget);
    } else if (onOpen !== undefined) onOpen(event);
    else if (besideKey(event)) keepBeside(row.threadId, openThread);
    else openThread(row.threadId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    rowMenuKeys(event);
    if (onOpen === undefined || event.defaultPrevented) return;
    if (event.key !== "Enter" || !besideKey(event)) return;
    event.preventDefault();
    onOpen(event);
  };
  const props = {
    type: "button" as const,
    [STOP]: "",
    "data-testid": isWide ? "workers-panel-row" : "overview-worker",
    "data-thread-id": row.threadId,
    "data-tone": tone,
    "data-asking": asking || undefined,
    "data-unread": unread || undefined,
    "aria-current": isCurrent || undefined,
    "aria-label": facts.join(", "),
    title: card
      ? undefined
      : `${facts.join(" · ")}${waiting === undefined ? "" : `\n${waiting.hint}`}`,
    "aria-keyshortcuts": "Shift+F10",
    onClick,
    onKeyDown,
    ...threadDragProps(row.threadId),
    className: cn(
      ROW,
      WORKER_ROW,
      twoLines && TWO_LINE_ROW,
      isWide && WIDE_ROW,
      CURRENT_ROW,
      settled && SETTLED,
    ),
  };
  const shownPrs = shownPrNumbers(prChips, true);
  const words = starting ? (
    <span
      data-testid="overview-worker-starting"
      className="min-w-0 truncate text-meta text-muted-foreground"
    >
      {STARTING}
    </span>
  ) : doing !== undefined ? (
    <span
      data-testid="overview-worker-doing"
      className={cn("min-w-0 text-meta text-muted-foreground", isWide ? WRAPPED : "truncate")}
    >
      {doing}
    </span>
  ) : waiting !== undefined ? (
    lineWait !== undefined && (
      <WaitingLine
        waiting={lineWait}
        testId="overview-worker-waiting"
        prs={shownPrs}
        wrap={isWide}
      />
    )
  ) : (
    <WorkerNow
      row={row}
      asking={asking}
      question={question}
      tone={tone}
      prs={shownPrs}
      wrap={isWide}
    />
  );
  const age = ageAt !== undefined && (
    <span
      data-testid="overview-worker-age"
      title={`Last active ${formatStamp(ageAt)}`}
      className={cn(
        "shrink-0 text-muted-foreground tabular-nums",
        isWide ? "text-meta" : "ml-auto pl-1",
      )}
    >
      {formatRelative(ageAt, now)}
    </span>
  );
  const foot =
    parts === undefined ? null : (
      <parts.Foot threadId={row.threadId} done={tone === "merged"} ghost />
    );
  const body = (
    <>
      <StatusDot
        state={mark ?? tone}
        data-testid="overview-worker-dot"
        data-tone={tone}
        data-tall={twoLines || isWide || undefined}
        className={isWide ? WIDE_DOT : twoLines ? TALL_DOT : DOT}
      />
      <span
        data-testid="overview-worker-title"
        className={cn(ROW_TITLE, "text-foreground", unread && UNREAD_TITLE)}
      >
        {row.title}
      </span>
      <span className={cn(ROW_TRAIL, WORKER_TRAIL, isWide && "max-w-none")}>
        <MachineMarker
          hostId={hostId}
          sent={sent}
          show={edgeSays && !isWide ? "glyph" : "name"}
          hover="none"
          testId="overview-worker-machine"
        />
        {pause !== undefined && <WorkerPauseMark pause={pause} />}
        {agent !== undefined && (
          <span data-testid="overview-worker-agent" className="flex shrink-0">
            <AgentIcon agent={agent} className="size-icon-row" />
          </span>
        )}
        {isWide && age}
      </span>
      {isWide
        ? (edgeSays || hasChips) && (
            <span
              data-testid="overview-worker-line"
              className="col-span-2 col-start-2 flex min-w-0 flex-wrap items-start gap-x-1.5 gap-y-0.5 text-meta"
            >
              {hasChips && (
                <WorkerPrChips
                  threadId={row.threadId}
                  cardPrs={row.prs}
                  chips={prChips}
                  runs={runs}
                  dense
                  ghost
                  ghostRef={room}
                  foldMerged
                  className="h-lh shrink-0 items-center"
                />
              )}
              {edgeSays && (
                <span className="flex min-w-0 flex-1 basis-24 items-start gap-x-1.5">{words}</span>
              )}
            </span>
          )
        : twoLines && (
            <span data-testid="overview-worker-line" className={ROW_STATUS}>
              <span className="flex h-lh min-w-0 flex-1 flex-wrap content-start items-center gap-x-1.5 overflow-hidden">
                <WorkerPrChips
                  threadId={row.threadId}
                  cardPrs={row.prs}
                  chips={prChips}
                  runs={runs}
                  dense
                  ghost
                  foldMerged
                  className="h-lh shrink-0 items-center"
                />
                {edgeSays && (
                  <span className="flex h-lh min-w-0 flex-1 basis-14 items-center">{words}</span>
                )}
              </span>
              {age}
            </span>
          )}
      {foot}
    </>
  );
  const chips =
    parts !== undefined ? (
      <>
        {hasChips && roomAt !== undefined && (
          <WorkerPrChips
            threadId={row.threadId}
            cardPrs={row.prs}
            chips={prChips}
            runs={runs}
            card={card}
            dense
            foldMerged
            className={WIDE_CHIPS}
            style={roomAt}
            onOpenOwn={openOwnPr}
          />
        )}
        <parts.Foot threadId={row.threadId} done={tone === "merged"} />
      </>
    ) : (
      twoLines &&
      hasChips && (
        <WorkerPrChips
          threadId={row.threadId}
          cardPrs={row.prs}
          chips={prChips}
          runs={runs}
          card={card}
          dense
          foldMerged
          className={WORKER_CHIPS}
        />
      )
    );
  const pictures =
    parts !== undefined && row.askKey !== undefined ? <parts.Pictures askKey={row.askKey} /> : null;
  if (!card) {
    return (
      <RowMenu menu={<WorkerRowMenuItems threadId={row.threadId} />}>
        <button {...props}>{body}</button>
        {chips}
        {pictures}
      </RowMenu>
    );
  }
  return (
    <RowMenu menu={<WorkerRowMenuItems threadId={row.threadId} />}>
      <PreviewCard.Root open={preview.open} onOpenChange={preview.onOpenChange}>
        <PreviewCard.Trigger
          delay={250}
          render={<button {...props} />}
          onMouseLeave={preview.onMouseLeave}
          onBlur={preview.onBlur}
        >
          {body}
        </PreviewCard.Trigger>
        <PreviewCard.Portal>
          <PreviewCard.Positioner
            side={isWide ? "left" : "right"}
            align="start"
            sideOffset={8}
            className="isolate z-50"
          >
            <PreviewCard.Popup
              data-testid="overview-worker-card"
              data-surface="overlay"
              className={cn(CARD_SURFACE, "flex w-72 flex-col gap-1.5 p-3 text-reading")}
            >
              <WorkerCard
                row={row}
                feature={feature}
                agent={agent}
                lastActivity={lastActivity ?? at ?? updatedAt}
                startedAt={startedAt}
                dot={dot}
                tone={tone}
                asking={asking}
                pause={pause}
                waiting={waiting}
                machine={machine}
              />
            </PreviewCard.Popup>
          </PreviewCard.Positioner>
        </PreviewCard.Portal>
      </PreviewCard.Root>
      {chips}
      {pictures}
    </RowMenu>
  );
}

/** What the wide row's last line takes. */
export interface WideFootProps {
  readonly threadId: ThreadId;
  /** Finished: its plan is over, and its steps say nothing. */
  readonly done: boolean;
  /** Drawn to hold its room inside the row's button, unseen. */
  readonly ghost?: boolean;
}

function useRoomAt(
  room: RefObject<HTMLElement | null>,
  on: boolean,
): { top: number; left: number } | undefined {
  const [at, setAt] = useState<{ top: number; left: number } | undefined>(undefined);
  useLayoutEffect(() => {
    const el = room.current;
    if (!on || el === null) return;
    const measure = () =>
      setAt((was) =>
        was?.top === el.offsetTop && was.left === el.offsetLeft
          ? was
          : { top: el.offsetTop, left: el.offsetLeft },
      );
    measure();
  });
  return on ? at : undefined;
}

/** The parts only the pane's wide row draws: its last line, and an ask's pictures. */
export interface WideParts {
  readonly Foot: ComponentType<WideFootProps>;
  readonly Pictures: ComponentType<{ readonly askKey: string }>;
}

/** "Asks you: put the sheet under Help or under Settings?" */
export const asksYouLine = (question: string): string => `Asks you: ${question}`;

const WRAPPED = "line-clamp-2 break-words";

const WIDE_ROW = "py-1.5 text-body hover:bg-accent";

const WIDE_DOT = "row-span-3 h-auto min-h-6 w-1 self-stretch justify-self-center rounded-full";

function useAskQuestion(askKey: string | undefined): string | undefined {
  const asks = useWorkspaceAsks();
  if (askKey === undefined) return undefined;
  for (const each of asks) {
    const ask = each.asks.find((a) => a.key === askKey);
    if (ask === undefined) continue;
    return (
      ask.worker?.question.question ??
      [ask.lead, ask.command].filter((part) => part !== undefined && part !== "").join(" ")
    );
  }
  return undefined;
}

function usePickedPreview(hoverOnly = false) {
  const [open, setOpen] = useState(false);
  const hoverQuiet = useRef(false);
  const focusQuiet = useRef(false);
  return {
    open,
    picked: () => {
      hoverQuiet.current = true;
      focusQuiet.current = true;
      setOpen(false);
    },
    onOpenChange: (next: boolean, details: PreviewCard.Root.ChangeEventDetails) => {
      if (next && details.reason === "trigger-hover" && hoverQuiet.current) return;
      if (next && details.reason === "trigger-focus" && (hoverOnly || focusQuiet.current)) return;
      setOpen(next);
    },
    onMouseLeave: () => {
      hoverQuiet.current = false;
    },
    onBlur: () => {
      focusQuiet.current = false;
    },
  };
}

const NO_PRS: readonly { readonly number: number }[] = [];

/** A title marked unread (Mark unread, or an agent's `set_unread`): heavier, until it is opened. */
export const UNREAD_TITLE = "font-semibold text-foreground";

/** A worker's line while its agent session opens, before its first turn runs. */

/** A row's 8 px dot, centred in its mark column on the row's one line. */
export const DOT = "size-2 justify-self-center";

/**
 * A two-line worker's dot: a 4 px bar beside both its lines, in its state's colour, so the two read
 * as one row with no connector between them.
 */
export const TALL_DOT =
  "row-span-2 h-auto min-h-6 w-1 self-stretch justify-self-center rounded-full";

/** A worker row keeps its marks in a third column on the phone too, its second line under them. */
export const WORKER_ROW = "in-data-phone-drawer:grid-cols-[0.625rem_minmax(0,1fr)_auto]";

/** A two-line worker row: room above and below its lines. */
export const TWO_LINE_ROW = "py-1";

/** Its marks at the title line's edge, never a line of their own on the phone. */
export const WORKER_TRAIL = "in-data-phone-drawer:col-start-3 in-data-phone-drawer:justify-end";

const PLAIN_OPEN = { metaKey: false, ctrlKey: false } as const;

const WIDE_CHIPS =
  "pointer-events-none absolute flex h-lh items-center text-meta *:pointer-events-auto";

const WORKER_CHIPS =
  "pointer-events-none absolute bottom-1 left-6 flex h-lh items-center text-meta in-data-phone-drawer:left-7.5 *:pointer-events-auto";

function WorkerNow({
  row,
  asking,
  question,
  tone,
  prs = NO_PRS,
  wrap = false,
}: {
  row: OverviewWorkerRow;
  asking: boolean;
  question?: string | undefined;
  tone: RailTone;
  prs?: readonly { readonly number: number }[];
  wrap?: boolean;
}) {
  const cut = wrap ? "line-clamp-2 break-words" : "truncate";
  if (!nowLineShown(row)) {
    return (
      <span
        data-testid="overview-worker-state"
        className={cn("min-w-0 text-meta text-muted-foreground", cut)}
      >
        {RAIL_TONES[tone].label}
      </span>
    );
  }
  const words =
    question !== undefined ? asksYouLine(question) : nowBesidePrs(edgeWords(row.now), prs);
  return (
    <Swap
      swapKey={words}
      className={cn(
        "min-w-0 text-meta",
        cut,
        asking ? "text-status-needs" : row.failed ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <span data-testid="overview-worker-now" className={cut}>
        {words}
      </span>
    </Swap>
  );
}

function WorkerCardStep({ row }: { row: OverviewWorkerRow }) {
  const step = useWorkLine(row.threadId, row.report);
  if (step === undefined) return null;
  return (
    <p data-testid="overview-worker-card-step" className="text-meta text-muted-foreground">
      {step}
    </p>
  );
}

function WorkerCard({
  row,
  feature,
  agent,
  lastActivity,
  startedAt,
  dot,
  tone,
  asking,
  pause,
  waiting,
  machine,
}: {
  row: OverviewWorkerRow;
  feature: string;
  agent: string | undefined;
  lastActivity: number;
  startedAt: number | undefined;
  dot: string;
  tone: RailTone;
  asking: boolean;
  pause: WorkerPauseState | undefined;
  waiting: WaitingOn | undefined;
  machine: MachineMark | undefined;
}) {
  const time = formatStamp(lastActivity);
  const context = [
    ...(agent === undefined ? [] : [agentLabel(agent)]),
    ...(featureAddsToTitle(feature, row.title) ? [feature] : []),
  ];
  return (
    <>
      {context.length > 0 && (
        <p data-testid="overview-worker-card-feature" className="text-meta text-muted-foreground">
          {context.join(" · ")}
        </p>
      )}
      <p data-testid="overview-worker-card-title" className="font-medium">
        {row.title}
      </p>
      <p className="flex min-w-0 items-start gap-1.5 text-meta">
        <span className="flex h-lh shrink-0 items-center">
          <span
            aria-hidden
            title={RAIL_TONES[tone].label}
            className={cn("size-1.5 rounded-full", dot)}
          />
        </span>
        <span data-testid="overview-worker-card-station" className="shrink-0 text-foreground/80">
          {row.stationLabel}
        </span>
        <span
          data-testid="overview-worker-card-now"
          className={cn(
            "min-w-0 flex-1 break-words",
            asking ? "text-foreground" : row.failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {waiting === undefined ? row.now : waitShort(waiting.label)}
        </span>
        <time
          data-testid="overview-worker-card-time"
          dateTime={new Date(lastActivity).toISOString()}
          title={`Last activity ${time}`}
          className="shrink-0 text-muted-foreground tabular-nums"
        >
          {time}
        </time>
      </p>
      {tone === "working" && !asking && !row.failed && <WorkerCardStep row={row} />}
      {startedAt !== undefined && (
        <p data-testid="overview-worker-card-started" className="text-meta text-muted-foreground">
          Started {formatStamp(startedAt)}
        </p>
      )}
      {waiting !== undefined && <WaitingList waiting={waiting} />}
      {pause !== undefined && (
        <p
          data-testid="overview-worker-card-paused"
          className="flex items-center gap-1.5 text-meta text-muted-foreground"
        >
          <WorkerPauseMark pause={pause} />
          {workerPauseHint(pause.state, pause.at)}
        </p>
      )}
      {row.pr !== undefined && (
        <span className="flex">
          <PrChip pr={row.pr} threadId={row.threadId} />
        </span>
      )}
      {machine !== undefined && (
        <p
          data-testid="overview-worker-card-machine"
          className={cn(
            "text-meta whitespace-pre-line",
            machine.state === undefined ? "text-muted-foreground" : "text-foreground/80",
          )}
        >
          {machine.hint}
        </p>
      )}
      <p className="mt-0.5 flex gap-3 border-t border-border pt-1.5 text-meta text-muted-foreground">
        <span>Click · open</span>
        <span>{keyLabel("⌥-click")} · peek</span>
        <span>{keyLabel("⌘-click")} · beside</span>
      </p>
    </>
  );
}

const WAIT_GLYPH: Readonly<Record<WaitGlyph, LucideIcon>> = {
  ci: PendingRing,
  localCheck: LaptopMinimalCheck,
  review: Bot,
  merge: Timer,
  dependency: Link2,
  limit: Gauge,
  run: Workflow,
  timer: AlarmClock,
  triage: MessageCircleQuestion,
  branch: GitBranch,
  thread: Flag,
  ciQueued: Snail,
  load: Cpu,
  disk: HardDrive,
  freeze: Snowflake,
  release: Tag,
  version: CircleArrowUp,
  condition: Hourglass,
};

/**
 * What a worker or an orchestrator at rest waits on, at its row's edge, as calm as an idle row
 * beside the row's hollow dot that already says it waits: the wait's glyph and its key token, the
 * PR or the time ("#397", "08:10"), or its glyph alone for a condition ("a release is published"),
 * where it has them (`WaitEdge`), else its short words without "Waiting" (`waitShort`). Its label
 * and its whole words are its hover; the whole list is on the row's card.
 */
export function WaitingLine({
  waiting,
  testId,
  prs = NO_PRS,
  wrap = false,
}: {
  waiting: WaitingOn;
  testId: string;
  /** PRs its row's chips show, left out of its words. */
  prs?: readonly { readonly number: number }[];
  /** The pane's wide row: its words whole, wrapped to two lines, beside the wait's glyph. */
  wrap?: boolean;
}) {
  const edge = wrap ? undefined : edgeBesidePrs(waiting.edge, prs);
  const Glyph = edge === undefined ? undefined : WAIT_GLYPH[edge.glyph];
  const detail = waiting.reasons[0]?.detail;
  return (
    <Swap
      swapKey={waiting.label}
      className={cn("min-w-0 text-meta text-muted-foreground", wrap ? "" : "truncate")}
    >
      <span
        data-testid={testId}
        data-kind={waiting.kind}
        data-glyph={edge?.glyph}
        title={detail === undefined ? waiting.label : `${waiting.label}\n${detail}`}
        className={cn("flex min-w-0 gap-1", wrap ? "items-start" : "items-center")}
      >
        {Glyph !== undefined && <Glyph aria-hidden className="size-icon-chip shrink-0" />}
        <span
          className={cn(
            wrap ? "line-clamp-2 break-words" : "truncate",
            edge !== undefined && "tabular-nums",
          )}
        >
          {edge === undefined
            ? nowBesidePrs(wrap ? waiting.label : waitShort(waiting.label), prs)
            : edge.token}
        </span>
      </span>
    </Swap>
  );
}

function WaitingList({ waiting }: { waiting: WaitingOn }) {
  return (
    <ul
      data-testid="overview-worker-card-waits"
      className="flex flex-col gap-0.5 text-meta text-muted-foreground"
    >
      {waiting.reasons.map((reason, i) => (
        <li key={i} data-kind={reason.kind} className="flex min-w-0 gap-1.5">
          <Hourglass aria-hidden className="mt-0.75 size-icon-chip shrink-0" />
          <span className="min-w-0">{reason.detail}</span>
        </li>
      ))}
    </ul>
  );
}
