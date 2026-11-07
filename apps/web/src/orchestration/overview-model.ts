import {
  STATION_LABELS,
  cardStationOf,
  type FeatureCard,
  type FeatureCardHeld,
  type FeatureCardPr,
  type FeatureCardWorker,
  type FeatureStation,
  type PlanHeadline,
  type ThreadId,
  type ThreadStatus,
  activityGist,
  planText,
} from "@gram/contracts";

import type { RowStatus } from "@/sidebar/status";

import { briefTitle, type NeedsYouItem } from "./needs-you-items";
import { ANSWERED, calmTone, workerTone, type RailTone } from "./rail-model";
import { OVER_STATES, workerShown } from "./worker-shown";
import type { WorkspaceStatus } from "./tree-model";
import type { WorkerActivity } from "./wait-model";
import type { WaitingOn } from "./waiting-on";

// The overview sidebar: one line per workspace, the
// one the window is on opened into its features and their live workers. Everything a worker row
// says is its feature card's: the station, the now line and the PRs. Only who asks comes from the
// asks the stack shows. No React.

/** What a row's now line says while its worker waits on an ask. */
export const ASKS_YOU = "asks you";

/**
 * `cards` with the workers answered from here (`useAnsweredWorkers`) said as answered: the server
 * still has them waiting until the answer reaches the worker, a few seconds after Send (Undo holds
 * it), so their now line says the answer is on its way and their state no longer asks.
 */
export const answeredCards = (
  cards: readonly FeatureCard[],
  answered: ReadonlySet<ThreadId>,
): readonly FeatureCard[] => {
  if (answered.size === 0) return cards;
  let changed = false;
  const next = cards.map((card) => {
    if (!card.workers.some((worker) => answered.has(worker.threadId))) return card;
    changed = true;
    return {
      ...card,
      workers: card.workers.map((worker) =>
        answered.has(worker.threadId)
          ? {
              ...worker,
              now: ANSWERED,
              state:
                worker.state === "needsUser" || worker.state === "question"
                  ? ("working" as const)
                  : worker.state,
            }
          : worker,
      ),
    };
  });
  return changed ? next : cards;
};

/** A worker's last report, as far as its step line reads it. */
export interface ReportNext {
  /** Epoch ms. */
  readonly at: number;
  /** The next step it gave with its evidence, if it gave one. */
  readonly nextStep?: string | undefined;
}

export interface OverviewWorkerRow {
  readonly threadId: ThreadId;
  readonly title: string;
  /** Its card's state: a worker running again after its card had it finished is working. */
  readonly state: FeatureCardWorker["state"];
  /** The card's now line, or `ASKS_YOU` while an ask of its waits in the stack. */
  readonly now: string;
  readonly station: FeatureStation;
  readonly stationLabel: string;
  readonly failed: boolean;
  /** The key of the ask in the stack it waits on. */
  readonly askKey: string | undefined;
  /** Its first PR, with its checks. */
  readonly pr: FeatureCardPr | undefined;
  /** Every PR its card has, in the card's order. */
  readonly prs: readonly FeatureCardPr[];
  /** The user holds it: they wrote to it, and haven't handed it back. */
  readonly held: boolean;
  /** What the ledger says it does (`workerActivities`); absent until the ledger is read. */
  readonly activity?: WorkerActivity | undefined;
  /** Its live tone (`workerTones`); absent until the ledger is read or it is at work. */
  readonly tone?: RailTone | undefined;
  /** Its last report, from the ledger. */
  readonly report?: ReportNext | undefined;
  /** What it waits on at rest (`workerWaitings`), as the Board and ⌘J say it. */
  readonly waiting?: WaitingOn | undefined;
}

export interface OverviewFeature {
  readonly feature: string;
  /** The card's station, the least advanced of its live workers'. */
  readonly station: FeatureStation;
  readonly rows: readonly OverviewWorkerRow[];
  /** Briefs of the feature held until a usage limit resets, soonest first. */
  readonly held: readonly FeatureCardHeld[];
  /** When the card last changed: the rows' last activity when the thread's own isn't known. */
  readonly updatedAt: number;
}

/** Whether a card's worker has finished by its own state: a running one is then at work again. */
const finishedByCard = (worker: FeatureCardWorker): boolean =>
  OVER_STATES.has(worker.state) || worker.station === "merged";

/** A worker whose thread is at work right now, as the threads the window has show it. */
export interface RunningWorker {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly feature: string;
}

/**
 * The overview's features, in the cards' order: each feature with a worker that shows or a held
 * brief, the workers that show in the card's order. `askKeys` maps a worker to the ask of its in
 * the stack.
 *
 * Which workers show is `workerShown`, the Board's rule too. `over` is the workers the workspace's
 * ledger still has and whether each one's work is over (`ledgerWorkersOver`), once it is read. A
 * worker closed with its worktree leaves the ledger, but its feature's card keeps it as it last
 * was, so only a worker the ledger has shows. The feature's station is the least advanced of those
 * that show, so a closed worker's last station doesn't hold it.
 *
 * `running` is the workers at work right now. One shows whatever its card says: a worker still
 * running a release step after its feature was delivered, or one its card doesn't have yet. A
 * running worker no card has goes under its feature, after the cards' features.
 */
export const overviewFeatures = (
  cards: readonly FeatureCard[],
  askKeys: ReadonlyMap<ThreadId, string>,
  over?: ReadonlyMap<ThreadId, boolean>,
  running: readonly RunningWorker[] = [],
  heldIds: ReadonlySet<ThreadId> = new Set(),
  activities: Readonly<Record<string, WorkerActivity>> = {},
  reports: ReadonlyMap<ThreadId, ReportNext> = new Map(),
  tones: Readonly<Record<string, RailTone>> = {},
  waits: Readonly<Record<string, WaitingOn>> = {},
): readonly OverviewFeature[] => {
  const runningIds = new Set(running.map((worker) => worker.threadId));
  const shownFacts = { running: runningIds, asking: new Set(askKeys.keys()), over };
  const row = (
    worker: Pick<
      FeatureCardWorker,
      "threadId" | "title" | "now" | "station" | "state" | "flag" | "prs"
    >,
  ): OverviewWorkerRow => {
    const askKey = askKeys.get(worker.threadId);
    return {
      threadId: worker.threadId,
      title: worker.title,
      state: worker.state,
      now: askKey === undefined ? worker.now : ASKS_YOU,
      station: worker.station,
      stationLabel: STATION_LABELS[worker.station],
      failed: worker.flag === "error",
      askKey,
      pr: worker.prs[0],
      prs: worker.prs,
      held: heldIds.has(worker.threadId),
      activity: activities[worker.threadId],
      tone: tones[worker.threadId],
      report: reports.get(worker.threadId),
      waiting: askKey === undefined ? waits[worker.threadId] : undefined,
    };
  };
  const shown = new Set<ThreadId>();
  const features = cards.flatMap((card) => {
    const live = card.workers.filter((worker) => workerShown(worker, shownFacts));
    // A running worker its card has as finished is at work again.
    const atWork = live.map((worker) =>
      runningIds.has(worker.threadId) && finishedByCard(worker)
        ? { ...worker, station: "working" as const, state: "working" as const, now: "working" }
        : worker,
    );
    for (const worker of atWork) shown.add(worker.threadId);
    const rows = atWork.map(row);
    const held = card.held ?? [];
    return rows.length === 0 && held.length === 0
      ? []
      : [
          {
            feature: card.feature,
            station: rows.length === 0 ? card.station : cardStationOf(atWork),
            rows,
            held,
            updatedAt: card.updatedAt,
          },
        ];
  });
  // By id, so rows no card has keep their places as their activity comes in.
  const extras = running.toSorted((a, b) => (a.threadId < b.threadId ? -1 : 1));
  for (const worker of extras) {
    if (shown.has(worker.threadId)) continue;
    shown.add(worker.threadId);
    const extra = row({ ...worker, now: "working", station: "working", state: "working", prs: [] });
    const at = features.findIndex((each) => each.feature === worker.feature);
    const into = features[at];
    if (into === undefined) {
      features.push({
        feature: worker.feature,
        station: "working",
        rows: [extra],
        held: [],
        updatedAt: 0,
      });
    } else {
      features[at] = { ...into, rows: [...into.rows, extra] };
    }
  }
  return features;
};

/** One line under a workspace in the overview: a live worker, or a brief held for a limit. */
export type OverviewItem =
  | {
      readonly kind: "worker";
      readonly row: OverviewWorkerRow;
      /** The feature it works on, for its hover card. */
      readonly feature: string;
      /** Its feature card's last change, for its hover card. */
      readonly updatedAt: number;
    }
  | { readonly kind: "held"; readonly held: FeatureCardHeld; readonly feature: string };

/**
 * Where a tone sorts in the overview: what needs the user, then what works, then what waits on
 * automation, then the rest.
 */
const TONE_RANK: Readonly<Record<RailTone, number>> = {
  needs: 0,
  attention: 0,
  error: 0,
  working: 1,
  waiting: 2,
  idle: 3,
  merged: 4,
};

/**
 * The overview's workers under their orchestrator, with no feature between them: needs you first,
 * then working, then waiting on CI or a review, then the rest, each band in the cards' order; the
 * held briefs last. `toneOf` is each row's tone as its dot shows it (`rowTone`).
 */
export const overviewItems = (
  features: readonly OverviewFeature[],
  toneOf: (row: OverviewWorkerRow) => RailTone = (row) => rowTone(row, { working: false }),
): readonly OverviewItem[] => {
  const workers = features.flatMap((feature) =>
    feature.rows.map((row): OverviewItem => ({
      kind: "worker",
      row,
      feature: feature.feature,
      updatedAt: feature.updatedAt,
    })),
  );
  const rank = (item: OverviewItem) => (item.kind === "worker" ? TONE_RANK[toneOf(item.row)] : 5);
  const held = features.flatMap((feature) =>
    feature.held.map((each): OverviewItem => ({
      kind: "held",
      held: each,
      feature: feature.feature,
    })),
  );
  return [...workers.toSorted((a, b) => rank(a) - rank(b)), ...held];
};

/**
 * The server's activity line ("Running grep -n x src/a.ts", "Reading /Users/…/a.ts", "Thinking")
 * in the overview's plain words: what kind of thing it does ("Running a command", "Reading code",
 * "Thinking"), never the command or a path. The words are the Board's (`activityGist`).
 */
export const plainActivity = (activity: string): string => {
  const gist = activityGist(activity);
  return gist === "" ? gist : `${gist[0]!.toUpperCase()}${gist.slice(1)}`;
};

/**
 * Work running under a resting thread in plain words: "Running: a background shell" reads
 * "Running a background shell", without the list of what each one runs.
 */
export const plainRunning = (label: string): string => label.replace(/^Running: /, "Running ");

/** What the window knows live of a row's thread, beside its card. */
export interface RowLive {
  readonly status?: ThreadStatus | undefined;
  /** Its turn, or work under it, runs now (`threadWorking`). */
  readonly working: boolean;
}

/**
 * A worker row's tone: its live tone (`workerTones`), the one the Board, ⌘J and Quiet read; before
 * the ledger is read, its card's by `workerTone`.
 */
export const rowTone = (
  row: Pick<OverviewWorkerRow, "askKey" | "state" | "failed" | "activity" | "tone"> &
    Partial<Pick<OverviewWorkerRow, "now">>,
  live: RowLive,
): RailTone =>
  row.tone ??
  workerTone({
    asking: row.askKey !== undefined,
    answered: row.now === ANSWERED,
    state: row.state,
    failed: row.failed,
    status: live.status,
    working: live.working,
    activity: row.activity,
  });

/**
 * What a worker row says it waits on: its wait while its tone is calm (`calmTone`), never beside
 * an ask, a failure or work.
 */
export const rowWaiting = (
  row: Pick<OverviewWorkerRow, "waiting" | "askKey" | "failed">,
  tone: RailTone,
): WaitingOn | undefined =>
  row.askKey === undefined && !row.failed && calmTone(tone) ? row.waiting : undefined;

/**
 * A worker's dot on its feature card, by its station: a failure, merged, briefed, else at work. The
 * card shows where each worker stands, not what it does this minute, which the tone says.
 */
export const stationDotClass = (station: FeatureStation, failed: boolean): string =>
  failed
    ? "bg-destructive"
    : station === "merged"
      ? "bg-merged"
      : station === "briefed"
        ? "bg-muted-foreground/50"
        : "bg-status-working";

/** Now lines that only say what a row's dot says. */
const DOT_WORDS: ReadonlySet<string> = new Set(["working", "briefed", "in review", "idle"]);

/**
 * Whether a worker row spends its second line on its now line: for an ask, a failure, or anything
 * that says more than its dot. The rest stays in its name and hover card.
 */
export const nowLineShown = (row: Pick<OverviewWorkerRow, "now" | "askKey" | "failed">): boolean =>
  row.askKey !== undefined || row.failed || !DOT_WORDS.has(row.now);

/**
 * What a worker row's step line says: its plan's headline, else what it runs. A plan's next step
 * older than the worker's last report gives way to the report's own, or to what it runs when the
 * report gave none, so the line never contradicts what the worker last said. A needs-you headline
 * is left to the ask stack and the row's dot.
 */
export const workLineText = (
  headline: Pick<PlanHeadline, "phase" | "text"> | undefined,
  planAt: number | undefined,
  report: ReportNext | undefined,
  running: string | undefined,
): string | undefined => {
  if (headline === undefined || headline.phase === "needsYou") return running;
  const stepped = headline.phase === "next" || headline.phase === "followUp";
  if (stepped && report !== undefined && report.at > (planAt ?? 0)) {
    return report.nextStep === undefined ? running : `Next: ${planText(report.nextStep)}`;
  }
  return headline.text;
};

/** A plan headline's step count, "Step 2 of 4", and the " · " after it. */
const STEP_COUNT = /^Step \d+ of \d+(?: · |$)/;

/**
 * A sidebar row's step line without the plan's step count: "Step 2 of 4 · Reading code" reads
 * "Reading code". The whole line stays on the row's hover. A count with nothing after it reads
 * "Working".
 */
export const steplessLine = (text: string): string => {
  if (!STEP_COUNT.test(text)) return text;
  const rest = text.replace(STEP_COUNT, "");
  return rest === "" ? "Working" : rest;
};

/** What a workspace's orchestrator is doing, in a word or two. */
export type OverviewState = "paused" | "parked" | "working" | "in review" | "idle";

/**
 * A workspace's state word: paused while its pause holds (a budget, a limit, the user), else its
 * status as the sidebar's lanes have it. Needing you is said by the ask count, not a word.
 */
export const overviewState = (
  status: WorkspaceStatus | undefined,
  paused: boolean,
): OverviewState =>
  paused
    ? "paused"
    : status === "parked"
      ? "parked"
      : status === "working"
        ? "working"
        : status === "inReview"
          ? "in review"
          : "idle";

/**
 * A workspace's summary in the compact rail: "2 working · 1 ask", the parts it has; its state word
 * when it has neither, and the word alone while it is paused or parked.
 */
/** A state as a word on screen: a parked workspace is one whose orchestrator was archived. */
export const stateWord = (state: OverviewState): string =>
  state === "parked" ? "archived" : state;

export const overviewSummary = (
  state: OverviewState,
  { working, asks }: { readonly working: number; readonly asks: number },
): string => {
  const parts = [
    ...(state === "paused" || state === "parked" ? [stateWord(state)] : []),
    ...(working > 0 ? [`${working} working`] : []),
    ...(asks > 0 ? [`${asks} ${asks === 1 ? "ask" : "asks"}`] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : stateWord(state);
};

/** An orchestrator's line, folded or open: its dot, and whether it pulses. */
export interface OrchestratorLine {
  readonly dot: string;
  readonly pulse: boolean;
}

/**
 * An orchestrator's line, whatever its number of workers: a dashed ring while paused or parked (the
 * legend's held, as a held brief's), the working
 * colour while it or any of its workers works (the dot pulsing as a working worker's does), else
 * idle. What waits on the user is the line's count, its one amber marker, so the dot never is.
 */
export const orchestratorLine = (
  state: OverviewState,
  { working, asks }: { readonly working: number; readonly asks: number },
): OrchestratorLine => {
  const held = state === "paused" || state === "parked";
  const busy = !held && (state === "working" || working > 0);
  return {
    dot: held
      ? "border border-dashed border-muted-foreground bg-transparent"
      : busy
        ? "bg-status-working"
        : "bg-status-idle",
    pulse: busy && asks === 0,
  };
};

/** What an orchestrator's line says of its workers, folded or open. */
export interface FoldedSummary {
  /** Its live workers. */
  readonly live: number;
  /** How many of them are at work now. */
  readonly working: number;
  /** What waits on the user there, the orchestrator's own and its workers'. */
  readonly asks: number;
}

/** An orchestrator's summary in words: "3 workers · 1 working · 2 need you". */
export const foldedSummaryText = ({ live, working, asks }: FoldedSummary): string =>
  [
    `${live} ${live === 1 ? "worker" : "workers"}`,
    ...(working > 0 ? [`${working} working`] : []),
    ...(asks > 0 ? [`${asks} ${asks === 1 ? "needs" : "need"} you`] : []),
  ].join(" · ");

/** Whether an orchestrator's line keeps its state word: it does not work, whatever its dot says. */
export const stateWordShown = (state: OverviewState): boolean =>
  state === "paused" || state === "parked";

/**
 * All an orchestrator's line leaves to its hover and its name, its state first unless the count says
 * it: "paused · 3 workers · 1 working · 2 need you · Worker slots 6 of 8 · 1 held".
 */
export const orchestratorHover = (
  state: OverviewState,
  summary: FoldedSummary,
  slots: string | undefined,
): string =>
  [
    ...(state === "working" && summary.working > 0 ? [] : [stateWord(state)]),
    foldedSummaryText(summary),
    ...(slots === undefined ? [] : [`Worker slots ${slots}`]),
  ].join(" · ");

/**
 * What a key on an orchestrator's line does to its fold, as a tree row's arrows do: ← folds an
 * open one, → opens a folded one. Anything else, or with a modifier, leaves it (undefined).
 */
export const foldByKey = (
  event: Pick<KeyboardEvent, "key" | "altKey" | "metaKey" | "ctrlKey" | "shiftKey">,
  folded: boolean,
): boolean | undefined => {
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return undefined;
  if (event.key === "ArrowLeft" && !folded) return true;
  if (event.key === "ArrowRight" && folded) return false;
  return undefined;
};

/**
 * Whether a list of workers runs more than one agent, so each row's agent mark says something its
 * neighbours don't. With one agent for all (or none known), the state dot alone marks each row and
 * the agent is on its hover.
 */
export const mixedAgents = (agents: Iterable<string | undefined>): boolean => {
  let first: string | undefined;
  for (const agent of agents) {
    if (agent === undefined) continue;
    if (first === undefined) first = agent;
    else if (agent !== first) return true;
  }
  return false;
};

/**
 * Whether a workspace's tile in the compact rail has its working ring: its orchestrator works, as
 * the state word says, or works on with workers at work while an ask waits (the word then says
 * nothing of work, the ask badge saying it needs you). Paused or parked, it rests.
 */
export const tileWorking = (state: OverviewState, working: number): boolean =>
  state === "working" || (state === "idle" && working > 0);

/**
 * A solo row's status with what the Inbox lists it for (`threadNeed`): a thread at rest that needs
 * you says so in the item's words and tone (red for a failure, amber otherwise) instead of
 * "Stopped", so the row, the pill and the Inbox agree. A row already saying it needs you, or at
 * work, keeps its own words.
 */
export const soloDisplay = (
  display: RowStatus,
  need: Pick<NeedsYouItem, "kind" | "title"> | undefined,
): RowStatus => {
  if (
    need === undefined ||
    display.working ||
    display.running !== undefined ||
    display.tone === "text-status-needs" ||
    display.tone === "text-destructive"
  ) {
    return display;
  }
  const label = briefTitle(need);
  return {
    ...display,
    tone: need.kind === "failure" ? "text-destructive" : "text-status-needs",
    label,
    title: label,
  };
};
