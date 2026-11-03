import {
  FEATURE_STATIONS,
  stageHasRemainingSteps,
  type FeatureCard,
  type FeatureGroup,
  type FeatureCardHeld,
  type FeatureCardPr,
  type FeatureCardWorker,
  type FeatureStage,
  type FeatureStation,
  type ThreadId,
  type ThreadStatus,
  type WorkerState,
} from "@gram/contracts";

import { leastAdvanced } from "./board-model";
import type { WorkerActivity } from "./wait-model";
import type { WaitingOn } from "./waiting-on";
import { workerShown } from "./worker-shown";

// The Board view's feature lines: one row per feature card, its
// workers placed on the five stations the card gives them. Stations come from the card
// (`stationOf` on the server); nothing here works one out again. No React.

/**
 * What a worker's chip says at a glance. Waiting is busy on CI, a review or another automation;
 * attention is stopped where the worker has to act and nothing armed will bring it back.
 */
export type RailTone = "needs" | "attention" | "error" | "working" | "waiting" | "idle" | "merged";

export interface RailWorker {
  readonly threadId: ThreadId;
  readonly title: string;
  /** Four words or fewer, the card's; what it waits on's label while it waits (`waiting`). */
  readonly now: string;
  readonly tone: RailTone;
  /** What it waits on (`workerWaitings`), as the sidebar and ⌘J say it; its hint is the chip's hover. */
  readonly waiting?: WaitingOn | undefined;
  /** Its first PR, shown beside its name. */
  readonly pr: FeatureCardPr | undefined;
  /** Titles of the workers whose changed files meet this one's: advisory, from the card. */
  readonly overlaps: readonly string[];
  readonly overlapFiles: readonly string[];
}

export interface RailRow {
  readonly feature: string;
  /** The card the line is drawn from, which keys the helper's one sentence on it. */
  readonly card: FeatureCard;
  /** The group it runs in as one effort with others, if any. */
  readonly group: string | undefined;
  /** That of its least advanced worker on the line: what its group's band is made of. */
  readonly state: WorkerState;
  /** The projects its workers change, in order, each once. */
  readonly projects: readonly string[];
  /** The furthest station any of its workers reached: how far the line is drawn. */
  readonly reach: number;
  /** Whether any of its workers waits on you. */
  readonly needs: boolean;
  /** Every worker merged or delivered: the line is done. */
  readonly finished: boolean;
  /**
   * Its work is over and it has left the Board for Done: none of its workers shows by the
   * sidebar's rule (`workerShown`) and it has no brief held. Show finished brings it back.
   */
  readonly settled: boolean;
  /**
   * What the line is called: its feature when it draws several workers, else its worker's title,
   * else its first held brief's, else its feature.
   */
  readonly title: string;
  readonly cells: Readonly<Record<FeatureStation, readonly RailWorker[]>>;
  /** Its briefs held until a usage limit resets, drawn on Briefed beside its workers. */
  readonly held: readonly FeatureCardHeld[];
}

const NEEDS = new Set<FeatureCardWorker["state"]>(["needsUser", "question", "blocked"]);
const DONE = new Set<FeatureCardWorker["state"]>(["merged", "delivered", "archived"]);

/** What the view knows beside the cards: who has an open ask, and each thread's live status. */
export interface RailFacts {
  readonly asking: ReadonlySet<ThreadId>;
  readonly status: (threadId: ThreadId) => ThreadStatus | undefined;
  /**
   * Workers the ledger says still have work going though their state is over: a run it monitors, a
   * wake, a request (`workerHasOngoingWork`). Their line isn't finished.
   */
  readonly ongoing?: ReadonlySet<ThreadId> | undefined;
  /** Each ledger worker's activity (`workerActivities`), as Quiet and the sidebar read it. */
  readonly activity?: Readonly<Record<string, WorkerActivity>> | undefined;
  /**
   * Each live worker's tone (`workerTones`), the one every view reads; a worker it lacks, one the
   * ledger no longer has or not yet read, takes its tone from its card.
   */
  readonly tones?: Readonly<Record<string, RailTone>> | undefined;
  /**
   * The workers the ledger still has and whether each one's work is over (`ledgerWorkersOver`),
   * once it is read: which of them show is `workerShown`, the sidebar's rule too.
   */
  readonly over?: ReadonlyMap<ThreadId, boolean> | undefined;
  /** Workers at work now (`workingWorkerThreads`); a line shows them whatever their cards say. */
  readonly running?: ReadonlySet<ThreadId> | undefined;
  /** What each worker at rest waits on (`workerWaitings`), the sidebar's and ⌘J's words. */
  readonly waiting?: Readonly<Record<string, WaitingOn>> | undefined;
}

/** A card's plan with steps still to come: its line isn't finished, whatever its workers say. */
const planGoesOn = (stage: FeatureCard["stage"]): boolean =>
  stage?.plan !== undefined &&
  stage.plan.includes(stage.current) &&
  stage.current !== stage.plan.at(-1);

/** What the window knows of one worker, for its tone. */
export interface ToneFacts {
  /** An ask of its waits in the stack. */
  readonly asking: boolean;
  /** Its card's (or the ledger's) state. */
  readonly state?: FeatureCardWorker["state"] | undefined;
  readonly failed: boolean;
  /** Its thread's live status. */
  readonly status?: ThreadStatus | undefined;
  /** Its thread does something now (`threadWorking`): its turn, or work running under it. */
  readonly working?: boolean | undefined;
  /** What the ledger says it does (`workerActivities`). */
  readonly activity?: WorkerActivity | undefined;
}

/**
 * A worker's tone, the one selector the Board's chips and the overview sidebar's rows and counts
 * read: an ask or a failure first, then the end of the road, then whether it works right now, then
 * what the shared activity says of it at rest: waiting on automation, needing attention, or idle.
 */
export const workerTone = (facts: ToneFacts): RailTone => {
  const { state, status, activity } = facts;
  if (facts.asking || (state !== undefined && NEEDS.has(state))) return "needs";
  if (facts.failed) return "error";
  if (state !== undefined && DONE.has(state)) return "merged";
  if (status === "needsApproval" || status === "needsInput") return "needs";
  if (status === "running" || status === "starting" || facts.working === true) return "working";
  return activity === "working"
    ? "working"
    : activity === "automation"
      ? "waiting"
      : activity === "attention"
        ? "attention"
        : "idle";
};

/**
 * Tones a wait is said beside (`workerWaitings`): waiting on automation, at rest, or finished with
 * something still to come (a watched release run). Never beside work, an ask or a failure.
 */
export const calmTone = (tone: RailTone): boolean =>
  tone === "waiting" || tone === "idle" || tone === "merged";

/** A chip's tone: the worker's live tone (`workerTones`), else its card's by `workerTone`. */
export const railTone = (worker: FeatureCardWorker, facts: RailFacts): RailTone =>
  facts.tones?.[worker.threadId] ??
  workerTone({
    asking: facts.asking.has(worker.threadId),
    state: worker.state,
    failed: worker.flag === "error",
    status: facts.status(worker.threadId),
    activity: facts.activity?.[worker.threadId],
  });

/** A tone as a status dot: one colour per tone wherever a worker's dot is drawn. */
export const TONE_DOT: Readonly<Record<RailTone, string>> = {
  needs: "bg-status-needs",
  attention: "bg-status-needs",
  error: "bg-destructive",
  working: "bg-status-working",
  // Busy on CI or a review rather than a turn: the working colour, hollow.
  waiting: "border border-status-working bg-transparent",
  idle: "bg-status-idle",
  merged: "bg-merged",
};

const emptyCells = (): Record<FeatureStation, RailWorker[]> => ({
  briefed: [],
  working: [],
  checks: [],
  review: [],
  merged: [],
});

/**
 * Which of a line's workers it draws: those that show (`workerShown`, the sidebar's rule) on the
 * Board; every one but the archived in a feature's sheet; every one with Show finished.
 */
export type RailDraw = "shown" | "unarchived" | "all";

/**
 * The workspace's feature lines, in the cards' order with finished lines last, each drawing its
 * workers by `draw`. A line none of whose workers shows and with no brief held has left the Board
 * for Done (`settled`); a feature whose workers are all archived has no line unless all are drawn.
 *
 * A line is named by its only worker's title, or by its feature when it draws several.
 */
export const railRows = (
  cards: readonly FeatureCard[],
  facts: RailFacts,
  draw: RailDraw = "shown",
): readonly RailRow[] => {
  const titles = new Map(
    cards.flatMap((card) => card.workers.map((worker) => [worker.threadId, worker.title] as const)),
  );
  // A running thread its status says runs counts as at work, as the sidebar's does.
  const running = new Set(facts.running);
  for (const card of cards) {
    for (const worker of card.workers) {
      const status = facts.status(worker.threadId);
      if (status === "running" || status === "starting") running.add(worker.threadId);
    }
  }
  const shownFacts = { running, asking: facts.asking, over: facts.over };
  const rows = cards.flatMap((card): RailRow[] => {
    // Its workers, the archived ones only with all drawn; of them, those it draws.
    const workers =
      draw === "all" ? card.workers : card.workers.filter((worker) => worker.state !== "archived");
    const shown = card.workers.filter((worker) => workerShown(worker, shownFacts));
    const drawn = draw === "shown" ? shown : workers;
    const held = card.held ?? [];
    if (workers.length === 0 && held.length === 0) return [];
    const cells = emptyCells();
    let reach = 0;
    for (const worker of drawn) {
      reach = Math.max(reach, FEATURE_STATIONS.indexOf(worker.station));
      const tone = railTone(worker, facts);
      // Said only of a calm chip, as the sidebar's row says it.
      const waiting = calmTone(tone) ? facts.waiting?.[worker.threadId] : undefined;
      cells[worker.station].push({
        threadId: worker.threadId,
        title: worker.title,
        now: waiting?.label ?? worker.now,
        tone,
        ...(waiting === undefined ? {} : { waiting }),
        pr: worker.prs[0],
        overlaps: worker.overlapsWith.flatMap((id) => {
          const title = titles.get(id);
          return title === undefined ? [] : [title];
        }),
        overlapFiles: worker.overlapFiles,
      });
    }
    const tones = Object.values(cells).flatMap((cell) => cell.map((worker) => worker.tone));
    const finished =
      held.length === 0 &&
      !planGoesOn(card.stage) &&
      workers.every(
        (worker) => DONE.has(worker.state) && facts.ongoing?.has(worker.threadId) !== true,
      );
    // A line that has left for Done is named as it last was, by all its workers.
    const named = drawn.length > 0 ? drawn : workers;
    return [
      {
        feature: card.feature,
        card,
        group: card.group,
        // Only a held brief: it is about to be.
        state: leastAdvanced(workers.map((worker) => worker.state)) ?? "briefed",
        projects: [
          ...new Set([...named.map((worker) => worker.project), ...held.map((h) => h.project)]),
        ],
        reach,
        needs: tones.includes("needs"),
        finished,
        // The sidebar's rule: no worker left to show, and no brief held.
        settled: shown.length === 0 && held.length === 0,
        title:
          named.length > 1 ? card.feature : (named[0]?.title ?? held[0]?.title ?? card.feature),
        cells,
        held,
      },
    ];
  });
  return [...rows.filter((row) => !row.finished), ...rows.filter((row) => row.finished)];
};

/**
 * The lines the Board shows: with finished work hidden, a line whose work is over (`settled`)
 * leaves it for Done; with it shown, every line stays.
 */
export const boardRows = (rows: readonly RailRow[], finishedShown: boolean): readonly RailRow[] =>
  finishedShown ? rows : rows.filter((row) => !row.settled);

/**
 * How many workers the Board leaves out while finished work is hidden: the header's Show finished
 * count. Every worker on the cards, less those its lines show.
 */
export const hiddenWorkerCount = (
  cards: readonly FeatureCard[],
  shown: readonly RailRow[],
): number =>
  cards.reduce((sum, card) => sum + card.workers.length, 0) -
  shown.reduce(
    (sum, row) => sum + Object.values(row.cells).reduce((n, cell) => n + cell.length, 0),
    0,
  );

/** The advisory overlap in words: who the worker shares files with, and which; none without. */
export const overlapHint = (worker: Pick<RailWorker, "overlaps" | "overlapFiles">) =>
  worker.overlaps.length === 0
    ? undefined
    : `Shares files with ${worker.overlaps.join(", ")}${
        worker.overlapFiles.length === 0 ? "" : `: ${worker.overlapFiles.join(", ")}`
      }`;

/** Several features run as one effort: the band over their lines, with the whole's stage. */
export interface RailGroup {
  readonly group: string;
  /** That of its least advanced line; none while it has no line, only a plan still to follow. */
  readonly state: WorkerState | undefined;
  readonly stage: FeatureStage | undefined;
  readonly rows: readonly RailRow[];
  /** Every line of it finished: the band folds to one line until opened. */
  readonly finished: boolean;
}

/**
 * One entry of the Board's list: a feature line, or a group's band over its lines. `headed` marks
 * the first line in no group under a band: it draws the Other heading over itself, so the lines
 * after a band never read as the band's. The heading is part of its line's entry rather than one of
 * its own, as Tab moves through the list by entries and a heading has nothing to stop on.
 */
export type RailEntry =
  | { readonly kind: "line"; readonly row: RailRow; readonly headed?: true }
  | { readonly kind: "group"; readonly group: RailGroup };

const band = (group: RailGroup): RailEntry => ({ kind: "group", group });

/**
 * The lines dealt into their groups (`FeatureCard.group`), each band where its first line stood:
 * bands still going lead, in the workspace's order with their features in the order they joined,
 * then the lines in no group as `railRows` ordered them, under an Other heading when a band is
 * above them, then the finished bands. A group the workspace doesn't list yet still gets a band, so
 * nothing is dropped while the two disagree; one with no line left keeps its band only while its
 * plan has steps to come.
 */
export const railEntries = (
  rows: readonly RailRow[],
  groups: Readonly<Record<string, FeatureGroup>> | undefined,
): readonly RailEntry[] => {
  const listed = Object.keys(groups ?? {});
  const names = [
    ...new Set([...listed, ...rows.flatMap((row) => (row.group === undefined ? [] : [row.group]))]),
  ];
  const bands = names.flatMap((group): RailGroup[] => {
    const order = groups?.[group]?.features ?? [];
    const rank = (row: RailRow) => {
      const index = order.indexOf(row.feature);
      return index < 0 ? order.length : index;
    };
    // In the order they joined, finished lines last, as everywhere on the Board.
    const members = rows
      .filter((row) => row.group === group)
      .toSorted((a, b) => Number(a.finished) - Number(b.finished) || rank(a) - rank(b));
    const stage = groups?.[group]?.stage;
    if (members.length === 0 && !stageHasRemainingSteps(stage)) return [];
    return [
      {
        group,
        state: leastAdvanced(members.map((row) => row.state)),
        stage,
        rows: members,
        finished: members.length > 0 && members.every((row) => row.finished),
      },
    ];
  });
  const going = bands.filter((group) => !group.finished).map(band);
  const loose = rows.filter((row) => row.group === undefined);
  return [
    ...going,
    ...loose.map((row, index): RailEntry =>
      index === 0 && going.length > 0 ? { kind: "line", row, headed: true } : { kind: "line", row },
    ),
    ...bands.filter((group) => group.finished).map(band),
  ];
};

/** Every group a feature can be moved to: the workspace's, then any only a card names yet. */
export const groupNames = (
  groups: Readonly<Record<string, FeatureGroup>> | undefined,
  cards: readonly Pick<FeatureCard, "group">[],
): readonly string[] => [
  ...new Set([
    ...Object.keys(groups ?? {}),
    ...cards.flatMap((card) => (card.group === undefined ? [] : [card.group])),
  ]),
];

/**
 * The fold key of a group's band, in `layout.workspacesCollapsedNodes`:
 * a band still going is listed while folded, a finished one while open, so each starts as it should.
 */
export const groupFoldKey = (workspaceId: string, group: Pick<RailGroup, "group" | "finished">) =>
  group.finished
    ? `board:${workspaceId}/finished:${group.group}`
    : `board:${workspaceId}/group:${group.group}`;

/** Whether a band is folded, given whether its key is listed. */
export const groupFolded = (group: Pick<RailGroup, "finished">, listed: boolean): boolean =>
  group.finished ? !listed : listed;
