import {
  briefOf,
  changedFilesOf,
  checksOf,
  ledgerPrsOf,
  type FinishedWorkerFile,
  type GramUIMessage,
  type PrCheckRun,
  type PrDetail,
  type WorkerLedgerEntry,
  type WorkerPr,
} from "@gram/contracts";

import {
  prLifecycleOf,
  prRefText,
  reviewMarkOf,
  type PrLifecycle,
} from "@/components/pr-marks-model";

import { lastCommandOf } from "./last-command";
import { prWait } from "./wait-model";

// What a peek shows of a worker or a PR: only the lines Gram has facts for, and none it would have to guess. Pure, so it is tested
// without a browser.

/** How many checks and files a peek names before "N more". */
const PEEK_LIST_MAX = 3;

const samePr = (
  a: { readonly repo: string; readonly number: number },
  b: { readonly repo: string; readonly number: number },
) => a.number === b.number && a.repo.toLowerCase() === b.repo.toLowerCase();

/** The worker's ledger PR that a chip names, from any of its repos. */
export const ledgerPrOf = (
  entry: Pick<WorkerLedgerEntry, "pr" | "morePrs" | "alsoIn"> | undefined,
  target: { readonly repo: string; readonly number: number },
): WorkerPr | undefined =>
  entry === undefined ? undefined : ledgerPrsOf(entry).find((pr) => samePr(pr, target));

/**
 * The thread's PR detail when it is the PR asked about: `git.prDetail` answers for the worker's own
 * PR only, and a worker with more than one says nothing here about the others.
 */
export const detailFor = (
  detail: PrDetail | undefined,
  target: { readonly repo: string; readonly number: number },
): PrDetail | undefined => {
  if (detail === undefined || detail.number !== target.number) return undefined;
  const repo = /github\.com\/([^/]+\/[^/]+)\/pull\//i.exec(detail.url)?.[1];
  return repo === undefined || repo.toLowerCase() === target.repo.toLowerCase()
    ? detail
    : undefined;
};

export type PeekTone = "success" | "danger" | "pending" | undefined;

export interface PrPeek {
  readonly title?: string | undefined;
  /** As `prLifecycleOf` reads it: a draft only where the detail says so. */
  readonly state?: PrLifecycle | undefined;
  readonly url?: string | undefined;
  readonly checks?: { readonly text: string; readonly tone: PeekTone } | undefined;
  /** People's review, as the PR vocabulary's mark says it whole (`reviewMarkOf`). */
  readonly review?: string | undefined;
  readonly waitsOn?: string | undefined;
  readonly change?:
    | { readonly additions: number; readonly deletions: number; readonly files: number }
    | undefined;
  /** The first few checks, failing ones first. */
  readonly runs: readonly PrCheckRun[];
  readonly moreRuns: number;
  /** What the merge waits on, in a sentence, while it is open. */
  readonly note?: string | undefined;
}

const RUN_RANK: Record<PrCheckRun["status"], number> = {
  failing: 0,
  pending: 1,
  passing: 2,
  neutral: 3,
};

const ROLLUP: Record<string, { text: string; tone: PeekTone }> = {
  passing: { text: "Passing", tone: "success" },
  failing: { text: "Failing", tone: "danger" },
  pending: { text: "Running", tone: "pending" },
};

const checksLine = (detail: PrDetail | undefined, pr: WorkerPr | undefined): PrPeek["checks"] => {
  if (detail !== undefined && detail.checksTotal > 0) {
    const failing = detail.checkRuns.filter((run) => run.status === "failing").length;
    if (failing > 0) return { text: `${failing} of ${detail.checksTotal} failing`, tone: "danger" };
    return {
      text: `${detail.checksPassed} of ${detail.checksTotal} passed`,
      tone: detail.checksPassed === detail.checksTotal ? "success" : "pending",
    };
  }
  const rollup = checksOf(pr?.checks);
  return rollup === undefined ? undefined : ROLLUP[rollup];
};

const reviewLine = (detail: PrDetail | undefined, pr: WorkerPr | undefined): string | undefined =>
  reviewMarkOf({
    reviewDecision: detail?.reviewDecision || pr?.reviewDecision,
    reviewRequests: detail?.reviewRequests ?? pr?.reviewRequests,
    changesRequestedBy: pr?.changesRequestedBy,
  })?.detail;

/** The PRs it waits to merge after, those not merged yet. */
const waitsOnLine = (pr: WorkerPr | undefined): string | undefined => {
  const open = (pr?.dependsOn ?? []).filter(
    (dependency) => dependency.mergeAfter !== false && dependency.state !== "merged",
  );
  return open.length === 0
    ? undefined
    : open.map((dependency) => prRefText(dependency, { compact: true })).join(", ");
};

/** A PR's sheet: its detail where the worker's thread has it, the ledger's badge facts otherwise. */
export const prPeekOf = (pr: WorkerPr | undefined, detail: PrDetail | undefined): PrPeek => {
  const source = detail ?? pr;
  const state = source?.state === undefined ? undefined : prLifecycleOf(source);
  const runs = (detail?.checkRuns ?? []).toSorted(
    (a, b) => RUN_RANK[a.status] - RUN_RANK[b.status],
  );
  const wait = pr !== undefined && (state === "open" || state === "draft") ? prWait(pr) : undefined;
  return {
    title: detail?.title,
    state,
    url: detail?.url ?? (pr?.url?.startsWith("https://") === true ? pr.url : undefined),
    checks: checksLine(detail, pr),
    review: reviewLine(detail, pr),
    waitsOn: waitsOnLine(pr),
    change:
      detail === undefined
        ? undefined
        : {
            additions: detail.additions,
            deletions: detail.deletions,
            files: detail.changedFiles,
          },
    runs: runs.slice(0, PEEK_LIST_MAX),
    moreRuns: Math.max(0, runs.length - PEEK_LIST_MAX),
    // The dependency line already says what it waits on.
    note: wait === undefined || wait.tag === "dependency" ? undefined : wait.detail,
  };
};

export interface WorkerPeek {
  /** The first words it was given, only when its whole transcript is loaded. */
  readonly brief?: string | undefined;
  readonly files: readonly FinishedWorkerFile[];
  readonly moreFiles: number;
  /** Files changed by count alone, when the transcript loaded isn't the whole of it. */
  readonly changedFiles?: number | undefined;
  readonly command?: { readonly command: string; readonly running: boolean } | undefined;
  /** Its latest report's words. */
  readonly report?: string | undefined;
}

/**
 * A worker's peek: its brief, the files its edits changed, its last command and its latest report.
 * `earlier` is the feed's: older history isn't loaded, so its first message isn't the brief and its
 * edits aren't all of them; the ledger's count of changed files stands in.
 */
export const workerPeekOf = (
  messages: readonly GramUIMessage[],
  earlier: boolean,
  entry: Pick<WorkerLedgerEntry, "lastReport" | "changedFiles"> | undefined,
): WorkerPeek => {
  const files = earlier ? [] : changedFilesOf(messages);
  const last = lastCommandOf(messages);
  return {
    brief: earlier ? undefined : briefOf(messages),
    files: files.slice(0, PEEK_LIST_MAX),
    moreFiles: Math.max(0, files.length - PEEK_LIST_MAX),
    changedFiles: earlier && (entry?.changedFiles ?? 0) > 0 ? entry?.changedFiles : undefined,
    command: last === undefined ? undefined : { command: last.command, running: last.running },
    report: entry?.lastReport?.summary,
  };
};
