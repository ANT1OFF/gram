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
  /** Four words or fewer, the card's. */
  readonly now: string;
  readonly tone: RailTone;
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
 * The workspace's feature lines, in the cards' order with finished lines last. Archived workers
 * leave the line, and a feature with no other worker leaves the board, unless it has a brief held;
 * with `archived` shown they stay, as finished.
 */
export const railRows = (
  cards: readonly FeatureCard[],
  facts: RailFacts,
  archived = false,
): readonly RailRow[] => {
  const titles = new Map(
    cards.flatMap((card) => card.workers.map((worker) => [worker.threadId, worker.title] as const)),
  );
  const rows = cards.flatMap((card): RailRow[] => {
    const workers = archived
      ? card.workers
      : card.workers.filter((worker) => worker.state !== "archived");
    const held = card.held ?? [];
    if (workers.length === 0 && held.length === 0) return [];
    const cells = emptyCells();
    let reach = 0;
    for (const worker of workers) {
      reach = Math.max(reach, FEATURE_STATIONS.indexOf(worker.station));
      cells[worker.station].push({
        threadId: worker.threadId,
        title: worker.title,
        now: worker.now,
        tone: railTone(worker, facts),
        pr: worker.prs[0],
        overlaps: worker.overlapsWith.flatMap((id) => {
          const title = titles.get(id);
          return title === undefined ? [] : [title];
        }),
        overlapFiles: worker.overlapFiles,
      });
    }
    const tones = Object.values(cells).flatMap((cell) => cell.map((worker) => worker.tone));
    return [
      {
        feature: card.feature,
        card,
        group: card.group,
        // Only a held brief: it is about to be.
        state: leastAdvanced(workers.map((worker) => worker.state)) ?? "briefed",
        projects: [
          ...new Set([...workers.map((worker) => worker.project), ...held.map((h) => h.project)]),
        ],
        reach,
        needs: tones.includes("needs"),
        finished:
          held.length === 0 &&
          !planGoesOn(card.stage) &&
          workers.every(
            (worker) => DONE.has(worker.state) && facts.ongoing?.has(worker.threadId) !== true,
          ),
        cells,
        held,
      },
    ];
  });
  return [...rows.filter((row) => !row.finished), ...rows.filter((row) => row.finished)];
};

/** The advisory overlap in words: who the worker shares files with, and which; none without. */
export const overlapHint = (worker: Pick<RailWorker, "overlaps" | "overlapFiles">) =>
  worker.overlaps.length === 0
    ? undefined
    : `Shares files with ${worker.overlaps.join(", ")}${
        worker.overlapFiles.length === 0 ? "" : `: ${worker.overlapFiles.join(", ")}`
      }`;

/** Workers the line leaves out until archived work is shown: the header's Show archived count. */
export const archivedCount = (cards: readonly FeatureCard[]): number =>
  cards.reduce(
    (sum, card) => sum + card.workers.filter((worker) => worker.state === "archived").length,
    0,
  );

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

/** One entry of the Board's list: a feature line, or a group's band over its lines. */
export type RailEntry =
  | { readonly kind: "line"; readonly row: RailRow }
  | { readonly kind: "group"; readonly group: RailGroup };

const band = (group: RailGroup): RailEntry => ({ kind: "group", group });

/**
 * The lines dealt into their groups (`FeatureCard.group`), each band where its first line stood:
 * bands still going lead, in the workspace's order with their features in the order they joined,
 * finished ones last, then the lines in no group as `railRows` ordered them, then the finished bands. A group the
 * workspace doesn't list yet still gets a band, so nothing is dropped while the two disagree; one
 * with no line left keeps its band only while its plan has steps to come.
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
  return [
    ...bands.filter((group) => !group.finished).map(band),
    ...rows.flatMap((row): RailEntry[] => (row.group === undefined ? [{ kind: "line", row }] : [])),
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
