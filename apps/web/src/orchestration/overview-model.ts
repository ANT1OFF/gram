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
  planText,
} from "@gram/contracts";

import { workerTone, type RailTone } from "./rail-model";
import type { WorkspaceStatus } from "./tree-model";
import type { WorkerActivity } from "./wait-model";

// The overview sidebar: one line per workspace, the
// one the window is on opened into its features and their live workers. Everything a worker row
// says is its feature card's: the station, the now line and the PRs. Only who asks comes from the
// asks the stack shows. No React.

/** What a row's now line says while its worker waits on an ask. */
export const ASKS_YOU = "asks you";

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

/** States a worker has left the overview in: finished, or parked. ⌘J's Done today lists the finished. */
const GONE = new Set<FeatureCardWorker["state"]>(["merged", "delivered", "done", "archived"]);

/** Whether a card's worker is live by its own state, and so may be in the overview. */
const isLiveWorker = (worker: FeatureCardWorker): boolean =>
  !GONE.has(worker.state) && worker.station !== "merged";

/** A worker whose thread is at work right now, as the threads the window has show it. */
export interface RunningWorker {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly feature: string;
}

/**
 * The overview's features, in the cards' order: each feature with a live worker or a held brief,
 * its live workers in the card's order. `askKeys` maps a worker to the ask of its in the stack.
 *
 * `ledger` is the threads the workspace's ledger still has, once it is read. A worker closed with
 * its worktree leaves the ledger, but its feature's card keeps it as it last was (a card whose
 * feature left the ledger stays as it was), so only a worker the ledger has is live. Its station
 * is then the least advanced of those, so a closed worker's last station doesn't hold the feature.
 *
 * `running` is the workers at work right now. One is live whatever its card says: a worker still
 * running a release step after its feature was delivered, or one its card doesn't have yet. A
 * running worker no card has goes under its feature, after the cards' features.
 */
export const overviewFeatures = (
  cards: readonly FeatureCard[],
  askKeys: ReadonlyMap<ThreadId, string>,
  ledger?: ReadonlySet<ThreadId>,
  running: readonly RunningWorker[] = [],
  heldIds: ReadonlySet<ThreadId> = new Set(),
  activities: Readonly<Record<string, WorkerActivity>> = {},
  reports: ReadonlyMap<ThreadId, ReportNext> = new Map(),
  tones: Readonly<Record<string, RailTone>> = {},
): readonly OverviewFeature[] => {
  const runningIds = new Set(running.map((worker) => worker.threadId));
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
    };
  };
  const shown = new Set<ThreadId>();
  const features = cards.flatMap((card) => {
    const live = card.workers.filter(
      (worker) =>
        runningIds.has(worker.threadId) ||
        (isLiveWorker(worker) && (ledger === undefined || ledger.has(worker.threadId))),
    );
    // A running worker its card has as finished is at work again.
    const atWork = live.map((worker) =>
      runningIds.has(worker.threadId) && !isLiveWorker(worker)
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
  row: Pick<OverviewWorkerRow, "askKey" | "state" | "failed" | "activity" | "tone">,
  live: RowLive,
): RailTone =>
  row.tone ??
  workerTone({
    asking: row.askKey !== undefined,
    state: row.state,
    failed: row.failed,
    status: live.status,
    working: live.working,
    activity: row.activity,
  });

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
export const overviewSummary = (
  state: OverviewState,
  { working, asks }: { readonly working: number; readonly asks: number },
): string => {
  const parts = [
    ...(state === "paused" || state === "parked" ? [state] : []),
    ...(working > 0 ? [`${working} working`] : []),
    ...(asks > 0 ? [`${asks} ${asks === 1 ? "ask" : "asks"}`] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : state;
};

/** An orchestrator's line, folded or open: its dot, and whether it pulses. */
export interface OrchestratorLine {
  readonly dot: string;
  readonly pulse: boolean;
}

/**
 * An orchestrator's line, whatever its number of workers: amber while something waits on the user,
 * hollow while paused or parked, the working colour while it or any of its workers works (the
 * dot pulsing as a working worker's does), else idle.
 */
export const orchestratorLine = (
  state: OverviewState,
  { working, asks }: { readonly working: number; readonly asks: number },
): OrchestratorLine => {
  const held = state === "paused" || state === "parked";
  const busy = !held && (state === "working" || working > 0);
  return {
    dot:
      asks > 0
        ? "bg-status-needs"
        : held
          ? "border border-muted-foreground bg-transparent"
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
    ...(state === "working" && summary.working > 0 ? [] : [state]),
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
 * Whether a workspace's tile in the compact rail has its working ring: its orchestrator works, as
 * the state word says, or works on with workers at work while an ask waits (the word then says
 * nothing of work, the ask badge saying it needs you). Paused or parked, it rests.
 */
export const tileWorking = (state: OverviewState, working: number): boolean =>
  state === "working" || (state === "idle" && working > 0);

/**
 * A workspace's tile in the compact rail: the first two letters or digits of its name, as written,
 * "?" for a name with none.
 */
export const tileLetters = (name: string): string =>
  [...name]
    .filter((char) => /[\p{L}\p{N}]/u.test(char))
    .slice(0, 2)
    .join("") || "?";
