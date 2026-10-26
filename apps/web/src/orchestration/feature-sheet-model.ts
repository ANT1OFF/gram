import {
  FEATURE_STATIONS,
  type FeatureCard,
  type FeatureCardPr,
  type FeatureStation,
  type ThreadId,
} from "@gram/contracts";

import { railRows, type RailFacts, type RailRow, type RailWorker } from "./rail-model";

// A feature opened from the Board or the stream: how
// many workers stand on each station, its PRs and its workers. Drawn from the card's Board line
// (`railRows`), so the sheet and the line never disagree. No React.

interface LinePr {
  readonly pr: FeatureCardPr;
  /** The title of the worker that opened it. */
  readonly by: string;
}

export interface FeatureSheet {
  readonly row: RailRow;
  /** Workers on each station, archived ones left out as the line leaves them out. */
  readonly counts: Readonly<Record<FeatureStation, number>>;
  /** Its workers in station order, the line's chips. */
  readonly workers: readonly RailWorker[];
  readonly prs: readonly LinePr[];
  /** Workers waiting on you. */
  readonly needs: number;
}

const prKey = (pr: FeatureCardPr) => `${pr.repo}#${pr.number}`;

const settled = (pr: FeatureCardPr) => pr.state === "merged" || pr.state === "closed";

/** A line's workers in station order, its chips. */
const lineWorkers = (row: RailRow): readonly RailWorker[] =>
  FEATURE_STATIONS.flatMap((station) => row.cells[station]);

/** Each PR of the line's workers once, with who opened it: open ones first, settled ones last. */
const linePrs = (row: RailRow): readonly LinePr[] => {
  const live = new Set<ThreadId>(lineWorkers(row).map((worker) => worker.threadId));
  const seen = new Set<string>();
  const prs: LinePr[] = [];
  for (const worker of row.card.workers) {
    if (!live.has(worker.threadId)) continue;
    for (const pr of worker.prs) {
      if (seen.has(prKey(pr))) continue;
      seen.add(prKey(pr));
      prs.push({ pr, by: worker.title });
    }
  }
  return [...prs.filter(({ pr }) => !settled(pr)), ...prs.filter(({ pr }) => settled(pr))];
};

/** The sheet for `card`, or `undefined` once every worker of it is archived. */
export const featureSheet = (card: FeatureCard, facts: RailFacts): FeatureSheet | undefined => {
  const [row] = railRows([card], facts);
  if (row === undefined) return undefined;
  const workers = lineWorkers(row);
  const counts = Object.fromEntries(
    FEATURE_STATIONS.map((station) => [station, row.cells[station].length]),
  ) as Record<FeatureStation, number>;
  return {
    row,
    counts,
    workers,
    prs: linePrs(row),
    needs: workers.filter((worker) => worker.tone === "needs").length,
  };
};

/**
 * The opening of a message to the orchestrator about a feature: its name, where its workers stand
 * by the `[thread <id>]` references the orchestrator knows them by, and its PRs. The user finishes
 * the question; nothing is sent.
 */
export const aboutFeature = (row: RailRow): string => {
  const workers = lineWorkers(row).map(
    (worker) => `"${worker.title}" [thread ${worker.threadId}] ${worker.now}`,
  );
  const prs = linePrs(row).map(({ pr }) => `${prKey(pr)}${pr.state === "merged" ? " merged" : ""}`);
  return `About the feature ${row.feature}: ${workers.join("; ")}.${
    prs.length === 0 ? "" : ` PRs: ${prs.join(", ")}.`
  }\n\n`;
};

/** A feature's menu, in order; the menu cap test keeps it to `MENU_CAP` short labels. */
export const FEATURE_MENU = [
  "Open",
  "Ask about it",
  "Set stage",
  "Move to group",
  "Pause",
  "Rename",
  "Archive",
] as const;
export type FeatureMenuItem = (typeof FEATURE_MENU)[number];

/** What decides an item's words: whether the feature is paused, staged or in a group. */
export interface FeatureMenuState {
  readonly paused: boolean;
  readonly staged: boolean;
}

/**
 * What an item reads as: Pause is Resume on a feature the user paused, and Set stage is Edit plan
 * on one that has a stage; both open a form, so they say so.
 */
export const featureMenuLabel = (item: FeatureMenuItem, state: FeatureMenuState): string =>
  item === "Pause" && state.paused
    ? "Resume"
    : item === "Set stage"
      ? state.staged
        ? "Edit plan…"
        : "Set stage…"
      : item;
