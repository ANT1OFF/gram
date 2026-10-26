import type {
  BudgetMeters,
  FinishedWorker,
  OpenPrRow,
  OrchestratorLedger,
  ReviewRequest,
  ThreadId,
  WorkerLedgerEntry,
  WorkspaceId,
} from "@gram/contracts";

import { prFactsOfListPr } from "@/components/pr-facts";
import { prRefText, type PrFacts } from "@/components/pr-marks-model";
import { listPrGlyph } from "@/reviews/pr-display";
import { DEFAULT_PR_OPTIONS, selectPrs } from "@/reviews/pr-list-model";
import {
  currentLimit,
  LIMIT_PROVIDERS,
  limitWarns,
  type LimitProvider,
  type UsageLimit,
  type UsageLimits,
} from "@/stores/usage-limits";
import { limitPercent, PROVIDER_SHORT, resetText } from "@/usage/limit-format";

import { finishedWhen, workersByTab, type WorkerLiveFacts, type WorkerRow } from "./workers-model";

// The overview sidebar's extras: its Pull requests and
// Done today sections and the usage meters and worker slots at its foot. Pure, so the column says
// what the lists, ⌘J and the title bar's meter say, and is tested without a browser.

/** A pull request as the overview's compact row has it. */
export interface OverviewPrRow {
  /** `review` waits on the user's review; `yours` is the user's own open PR. */
  readonly kind: "review" | "yours";
  readonly key: string;
  readonly title: string;
  /** `owner/repo#n`. */
  readonly pr: string;
  /** `repo#n`, the repo by its short name. */
  readonly ref: string;
  readonly author: string | undefined;
  readonly url: string;
  /** Its glyph, and its word. */
  readonly glyph: ReturnType<typeof listPrGlyph>;
  /** Everything the row knows of it, for the PR vocabulary's marks. */
  readonly facts: PrFacts;
  /** The thread that owns it, for one of the user's own. */
  readonly owner?: ThreadId | undefined;
}

const authorOf = (pr: { readonly author?: string; readonly isBot?: boolean }) =>
  pr.isBot === true ? pr.author?.replace(/\[bot\]$/, "") : pr.author;

/**
 * The review requests and then the user's own open PRs, each latest first. A list placed nowhere (`hidden`) is left out here too.
 */
export const overviewPrRows = (
  requests: readonly ReviewRequest[],
  own: readonly OpenPrRow[],
  shown: { readonly reviews: boolean; readonly own: boolean },
): OverviewPrRow[] => [
  ...(shown.reviews ? selectPrs(requests, DEFAULT_PR_OPTIONS) : []).map((pr): OverviewPrRow => ({
    kind: "review",
    key: `review:${prRefText(pr)}`,
    pr: prRefText(pr),
    title: pr.title || prRefText(pr),
    ref: prRefText(pr, { compact: true }),
    author: authorOf(pr),
    url: pr.url,
    glyph: listPrGlyph(pr),
    facts: prFactsOfListPr(pr),
  })),
  ...(shown.own ? selectPrs(own, DEFAULT_PR_OPTIONS) : []).map((pr): OverviewPrRow => ({
    kind: "yours",
    key: `yours:${prRefText(pr)}`,
    pr: prRefText(pr),
    title: pr.title || prRefText(pr),
    ref: prRefText(pr, { compact: true }),
    author: authorOf(pr),
    url: pr.url,
    glyph: listPrGlyph(pr),
    facts: prFactsOfListPr(pr),
    owner: pr.owner,
  })),
];

/** The line under a PR's title: `repo#n · author`. */
export const prSubLine = (row: Pick<OverviewPrRow, "ref" | "author">): string =>
  row.author === undefined || row.author === "" ? row.ref : `${row.ref} · ${row.author}`;

/** One workspace's facts for Done today. */
export interface DoneTodaySource {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly ledger: Pick<OrchestratorLedger, "features"> | undefined;
  readonly finished: readonly FinishedWorker[] | undefined;
}

/** A worker that finished today, as the overview's Done today row has it. */
export interface DoneTodayRow {
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  /** Merged, else done (delivered, archived, or cleaned up). */
  readonly merged: boolean;
  /** Epoch ms its work ended. */
  readonly finishedAt: number;
  /** `14:12`, on a 24-hour clock. */
  readonly time: string;
  /** `agent-platform · merged api#412`. */
  readonly sub: string;
}

const prRef = (pr: { readonly repo: string; readonly number: number } | undefined) =>
  pr === undefined ? "" : ` ${prRefText(pr, { compact: true })}`;

/** What became of a finished worker, with its PR: `merged api#412`, `done`, `cleaned up`. */
const outcome = (
  row: WorkerRow,
  entry: WorkerLedgerEntry | undefined,
  finished: FinishedWorker | undefined,
): string => {
  const merged = row.glyph === "merged";
  if (finished !== undefined) {
    const pr = finished.prs.find((each) => each.merged === true) ?? finished.prs[0];
    return merged ? `merged${prRef(pr)}` : `cleaned up${prRef(pr)}`;
  }
  const word = merged ? "merged" : row.glyph === "archived" ? "archived" : "done";
  return `${word}${prRef(entry?.pr)}`;
};

/**
 * Every workspace's Done today, as ⌘J lists each (`workersByTab`), in one list, latest first; each
 * row says which workspace it is in and what became of it.
 */
export const doneTodayRows = (
  sources: readonly DoneTodaySource[],
  facts: WorkerLiveFacts,
): DoneTodayRow[] =>
  sources
    .flatMap((source) => {
      const tabs = workersByTab(source.ledger, facts, source.finished ?? []);
      const entries = new Map(
        source.ledger?.features.flatMap((f) => f.workers.map((w) => [w.threadId, w] as const)),
      );
      const finished = new Map(source.finished?.map((w) => [w.threadId, w] as const));
      return tabs.doneToday.flatMap((feature) =>
        feature.rows.map((row): DoneTodayRow => {
          const at = row.finishedAt ?? facts.now;
          return {
            threadId: row.threadId,
            workspaceId: source.workspaceId,
            title: row.title,
            merged: row.glyph === "merged",
            finishedAt: at,
            time: finishedWhen(at, facts.now),
            sub: `${source.name} · ${outcome(
              row,
              row.cleanedUp === true ? undefined : entries.get(row.threadId),
              row.cleanedUp === true ? finished.get(row.threadId) : undefined,
            )}`,
          };
        }),
      );
    })
    .toSorted((a, b) => b.finishedAt - a.finishedAt);

/** A provider's 5-hour meter at the overview's foot. */
export interface FootMeter {
  readonly provider: LimitProvider;
  /** `Claude`, `Codex`. */
  readonly name: string;
  readonly percent: number;
  /** When the window resets, on a 24-hour clock; absent when no reading says. */
  readonly resets: string | undefined;
  /** At or past the share the title bar's meter warns at. */
  readonly warns: boolean;
  /** The reading itself, for the bar. */
  readonly limit: UsageLimit;
}

/** The 5-hour meters of the providers with a current reading, from the title bar meter's store. */
export const footMeters = (limits: UsageLimits, now: number): FootMeter[] =>
  LIMIT_PROVIDERS.flatMap((provider) => {
    const limit = currentLimit(limits[provider]?.fiveHour, now);
    if (limit === undefined) return [];
    return [
      {
        provider,
        name: PROVIDER_SHORT[provider],
        percent: limitPercent(limit.utilization),
        resets: limit.resetsAt === undefined ? undefined : resetText(limit.resetsAt, now),
        warns: limitWarns(limit),
        limit,
      },
    ];
  });

/** The most pips the slots row draws; a bigger cap still counts in words. */
export const MAX_SLOT_PIPS = 12;

/** The workspace's worker slots: how many are taken of its cap, and the briefs held for later. */
export interface WorkerSlots {
  readonly live: number;
  readonly cap: number;
  readonly held: number;
  /** One per slot up to `MAX_SLOT_PIPS`, taken ones first. */
  readonly pips: readonly boolean[];
  /** `6 of 8 · 1 held`; the held part only with some held. */
  readonly text: string;
}

export const workerSlots = (
  budget: Pick<BudgetMeters, "liveWorkers" | "maxConcurrentWorkers">,
  held: number,
): WorkerSlots => {
  const cap = Math.max(0, budget.maxConcurrentWorkers);
  const live = Math.max(0, budget.liveWorkers);
  return {
    live,
    cap,
    held,
    pips: Array.from({ length: Math.min(cap, MAX_SLOT_PIPS) }, (_, i) => i < live),
    text: `${live} of ${cap}${held > 0 ? ` · ${held} held` : ""}`,
  };
};
