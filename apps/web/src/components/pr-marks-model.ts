import type { ChecksRollup } from "@gram/contracts";
import {
  ArrowDown,
  Ban,
  Bot,
  BotMessageSquare,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  CirclePause,
  CircleX,
  GitMerge,
  GitMergeConflict,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Link2,
  MessageSquare,
  MessageSquareWarning,
  OctagonX,
  Timer,
  UserRoundCheck,
  UserRoundSearch,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { RingSpinner } from "@/motion/spinner";

// Gram's one visual vocabulary for pull requests: what a PR's state, its checks, its review and its
// merge look like, wherever a PR is drawn. A mark is an icon and a tone, so shape carries the state
// without colour; its words go in the tooltip and the accessible name. No React beyond the icons.

export interface PrMarkDisplay {
  readonly icon: LucideIcon;
  readonly tone: string;
}

/** A mark with its words: a few for beside the icon, and the full sentence for its tooltip. */
export interface PrMark<K extends string = string> {
  readonly kind: K;
  /** Capitalised, a word or three: "Checks failing". */
  readonly word: string;
  /** The tooltip's line, with the detail the word leaves out; the word when there is none. */
  readonly detail: string;
}

// ---------------------------------------------------------------------------------------------
// State: open, draft, merged, closed, as GitHub draws them
// ---------------------------------------------------------------------------------------------

export type PrLifecycle = "open" | "draft" | "merged" | "closed";

export const PR_STATE_DISPLAY: Record<PrLifecycle, PrMarkDisplay> = {
  open: { icon: GitPullRequest, tone: "text-success" },
  draft: { icon: GitPullRequestDraft, tone: "text-muted-foreground" },
  merged: { icon: GitMerge, tone: "text-merged" },
  closed: { icon: GitPullRequestClosed, tone: "text-destructive" },
};

const STATE_WORD: Record<PrLifecycle, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

/** What a PR's state is read from: a badge (`OPEN`), a ledger row (`open`) or a card. */
export interface PrLifecycleSource {
  readonly state?: "OPEN" | "MERGED" | "CLOSED" | "open" | "merged" | "closed" | undefined;
  readonly isDraft?: boolean | undefined;
  /**
   * False: the PR's head isn't this branch, so a merged or closed PR of a reused branch name reads
   * as open rather than painting a phantom "Merged".
   */
  readonly headMatches?: boolean | undefined;
}

export function prLifecycleOf(pr: PrLifecycleSource): PrLifecycle {
  const state = pr.state?.toLowerCase();
  if (pr.headMatches !== false && state === "merged") return "merged";
  if (pr.headMatches !== false && state === "closed") return "closed";
  return pr.isDraft === true ? "draft" : "open";
}

export const prStateMarkOf = (pr: PrLifecycleSource): PrMark<PrLifecycle> => {
  const kind = prLifecycleOf(pr);
  return { kind, word: STATE_WORD[kind], detail: STATE_WORD[kind] };
};

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

/** `fixing`: failing, and the PR's worker will act on it (CI ownership), so not the user's. */
export type ChecksMarkKind = ChecksRollup | "fixing" | "unknown";

/**
 * Pending turns on the shared clock, so it holds still under Reduced or Off motion; the rest are
 * still. Fixing is informational, in the working tone, never red.
 */
export const CHECKS_DISPLAY: Record<ChecksMarkKind, PrMarkDisplay> = {
  pending: { icon: RingSpinner, tone: "text-status-working" },
  passing: { icon: CircleCheck, tone: "text-success" },
  failing: { icon: CircleX, tone: "text-destructive" },
  fixing: { icon: Wrench, tone: "text-status-working" },
  none: { icon: CircleMinus, tone: "text-muted-foreground" },
  unknown: { icon: CircleHelp, tone: "text-muted-foreground" },
};

const CHECKS_WORD: Record<ChecksMarkKind, string> = {
  pending: "Checks running",
  passing: "Checks passing",
  failing: "Checks failing",
  fixing: "Checks failing",
  none: "No checks",
  unknown: "Checks unknown",
};

export function checksMarkOf(
  checks: ChecksRollup | undefined,
  { fixing = false, required = false }: { fixing?: boolean; required?: boolean } = {},
): PrMark<ChecksMarkKind> {
  const kind: ChecksMarkKind =
    checks === undefined ? "unknown" : checks === "failing" && fixing ? "fixing" : checks;
  const word = CHECKS_WORD[kind];
  const scoped = required && kind !== "none" && kind !== "unknown";
  const said = scoped ? word.replace("Checks", "Required checks") : word;
  return {
    kind,
    word,
    detail: kind === "fixing" ? `${said}; its worker is fixing them` : said,
  };
}

// ---------------------------------------------------------------------------------------------
// Review: people's decision, and the review bot's
// ---------------------------------------------------------------------------------------------

export type ReviewMarkKind = "waiting" | "approved" | "changes" | "threads";

export const REVIEW_DISPLAY: Record<ReviewMarkKind, PrMarkDisplay> = {
  waiting: { icon: UserRoundSearch, tone: "text-muted-foreground" },
  approved: { icon: UserRoundCheck, tone: "text-success" },
  changes: { icon: MessageSquareWarning, tone: "text-warning" },
  threads: { icon: MessageSquare, tone: "text-warning" },
};

export interface ReviewSource {
  /** GitHub's `reviewDecision`. */
  readonly reviewDecision?: string | undefined;
  /** Who a review is still asked of, by login or team. */
  readonly reviewRequests?: readonly { readonly name: string }[] | undefined;
  /** People whose standing review asks for changes. */
  readonly changesRequestedBy?: readonly string[] | undefined;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** People's review of an open PR; `undefined` when nobody has decided or been asked. */
export function reviewMarkOf(pr: ReviewSource): PrMark<ReviewMarkKind> | undefined {
  const requested = pr.reviewRequests ?? [];
  switch (pr.reviewDecision) {
    case "APPROVED":
      return { kind: "approved", word: "Approved", detail: "Approved" };
    case "CHANGES_REQUESTED": {
      const by = pr.changesRequestedBy ?? [];
      return {
        kind: "changes",
        word: "Changes requested",
        detail: by.length === 0 ? "Changes requested" : `Changes requested by ${by.join(", ")}`,
      };
    }
    case "REVIEW_REQUIRED":
      return {
        kind: "waiting",
        word: "Review required",
        detail:
          requested.length === 0
            ? "Waiting on an approving review"
            : `Waiting on ${requested.map((request) => request.name).join(", ")}`,
      };
  }
  if (requested.length === 0) return undefined;
  return {
    kind: "waiting",
    word: "Review requested",
    detail: `Waiting on ${requested.map((request) => request.name).join(", ")}`,
  };
}

/** People's open threads, which a decision doesn't speak for. */
export const reviewThreadsMarkOf = (count: number): PrMark<ReviewMarkKind> | undefined =>
  count <= 0
    ? undefined
    : {
        kind: "threads",
        word: plural(count, "thread"),
        detail: `Reviewers: ${plural(count, "open thread")}`,
      };

/**
 * The review bot's marks, as `reviewStatusOf` names its kinds: a round running, blockers, its
 * verdict on the head, open findings, and quiet (on the PR, nothing open or not yet reviewed).
 */
export type BotMarkKind =
  | "inFlight"
  | "blockers"
  | "approved"
  | "changesRequested"
  | "findings"
  | "reviewerThreads"
  | "quiet";

/**
 * The review bot asks for changes on the head: open blockers, or its verdict, and no new round under
 * way (one would be `inFlight`). The one test of it, for a badge's review, a list row's bot and a
 * ledger row alike, each read as a bot mark first.
 */
export const botAsksChanges = (bot: { readonly kind: string } | undefined): boolean =>
  bot?.kind === "blockers" || bot?.kind === "changesRequested";

export const BOT_DISPLAY: Record<BotMarkKind, PrMarkDisplay> = {
  quiet: { icon: Bot, tone: "text-muted-foreground" },
  inFlight: { icon: RingSpinner, tone: "text-muted-foreground" },
  blockers: { icon: Bot, tone: "text-destructive" },
  approved: { icon: BotMessageSquare, tone: "text-success" },
  changesRequested: { icon: Bot, tone: "text-destructive" },
  findings: { icon: Bot, tone: "text-warning" },
  reviewerThreads: REVIEW_DISPLAY.threads,
};

// ---------------------------------------------------------------------------------------------
// Merge readiness
// ---------------------------------------------------------------------------------------------

/**
 * What stands between an open PR and its merge, or what will merge it:
 * - `conflicts` with its base, `refused` by GitHub on this head, `behind` a base that requires
 *   up-to-date branches, `blocked` on required reviews or checks, `unstable` optional checks failing;
 * - `held` by a `merge_when_ready` hold, `waiting` on a `depends_on` PR to merge first;
 * - `armed`: `merge_when_ready` will merge it once it is ready;
 * - `mergeable`: GitHub would merge it now.
 */
export type MergeMarkKind =
  | "conflicts"
  | "refused"
  | "held"
  | "waiting"
  | "behind"
  | "blocked"
  | "unstable"
  | "armed"
  | "mergeable";

export const MERGE_DISPLAY: Record<MergeMarkKind, PrMarkDisplay> = {
  conflicts: { icon: GitMergeConflict, tone: "text-destructive" },
  refused: { icon: OctagonX, tone: "text-destructive" },
  held: { icon: CirclePause, tone: "text-muted-foreground" },
  waiting: { icon: Link2, tone: "text-muted-foreground" },
  behind: { icon: ArrowDown, tone: "text-warning" },
  blocked: { icon: Ban, tone: "text-warning" },
  unstable: { icon: CircleAlert, tone: "text-warning" },
  armed: { icon: Timer, tone: "text-merged" },
  mergeable: { icon: GitMerge, tone: "text-success" },
};

export interface PrRefSource {
  /** `owner/repo`. */
  readonly repo: string;
  readonly number: number;
}

/** A `merge_when_ready` intent, as the thread's binding or the ledger row has it. */
export interface MergeIntentSource {
  readonly hold?: string | undefined;
  readonly heldBy?: "orchestrator" | "thread" | undefined;
  readonly after?: readonly PrRefSource[] | undefined;
  /** GitHub refused a merge of the current head. */
  readonly refused?: boolean | undefined;
}

export interface MergeSource extends PrLifecycleSource {
  /** GitHub's `mergeStateStatus`. */
  readonly mergeState?: string | undefined;
  readonly baseRef?: string | undefined;
  /** Absent when nobody asked for `merge_when_ready`. */
  readonly intent?: MergeIntentSource | undefined;
  /** Its `depends_on` PRs; one known merged or closed no longer holds it. */
  readonly dependsOn?:
    | readonly (PrRefSource & {
        readonly state?: string | undefined;
        readonly mergeAfter?: false | undefined;
      })[]
    | undefined;
}

/** `owner/repo#N`, or `repo#N` compact, the owner left to the tooltip. */
export const prRefText = (pr: PrRefSource, { compact = false } = {}): string =>
  `${compact ? (pr.repo.split("/").pop() ?? pr.repo) : pr.repo}#${pr.number}`;

/** The PR's page: its own URL when known, else GitHub's for `owner/repo` and number. */
export const prUrlOf = (pr: PrRefSource & { readonly url?: string | undefined }): string =>
  pr.url ?? `https://github.com/${pr.repo}/pull/${pr.number}`;

/** The PRs a merge still waits on, each once: `after`, then the dependencies not known settled. */
export function mergeWaitsOn(pr: MergeSource): readonly PrRefSource[] {
  const out: PrRefSource[] = [];
  const add = (ref: PrRefSource) => {
    const same = (seen: PrRefSource) =>
      seen.number === ref.number && seen.repo.toLowerCase() === ref.repo.toLowerCase();
    if (!out.some(same)) out.push({ repo: ref.repo, number: ref.number });
  };
  for (const ref of pr.intent?.after ?? []) add(ref);
  for (const dependency of pr.dependsOn ?? []) {
    const state = dependency.state?.toLowerCase();
    if (state === "merged" || state === "closed") continue;
    // Without an armed merge a dependency still holds the work, whether or not a merge waits on it.
    if (pr.intent !== undefined && dependency.mergeAfter === false) continue;
    add(dependency);
  }
  return out;
}

const waitsText = (refs: readonly PrRefSource[]) => refs.map((ref) => prRefText(ref)).join(", ");

/**
 * Every fact about an open PR's merge, worst first: conflicts, a refused merge, a hold, a
 * dependency, then what GitHub's merge state says, then an armed merge, else mergeable. Merged,
 * closed and draft PRs get none.
 */
export function mergeMarksOf(pr: MergeSource): readonly PrMark<MergeMarkKind>[] {
  if (prLifecycleOf(pr) !== "open") return [];
  const base = pr.baseRef ?? "its base";
  const intent = pr.intent;
  const waits = mergeWaitsOn(pr);
  const marks: PrMark<MergeMarkKind>[] = [];
  const add = (kind: MergeMarkKind, word: string, detail: string) =>
    marks.push({ kind, word, detail });
  if (pr.mergeState === "DIRTY") add("conflicts", "Conflicts", `Conflicts with ${base}`);
  if (intent?.refused === true) {
    add(
      "refused",
      "Merge refused",
      "GitHub refused the merge of this head; tried again once it moves",
    );
  }
  if (intent?.hold !== undefined) {
    const by = intent.heldBy === "orchestrator" ? " by the orchestrator" : "";
    add("held", "Held", `Merge held${by}: ${intent.hold}`);
  }
  if (waits.length > 0) {
    add(
      "waiting",
      "Waiting",
      `${intent === undefined ? "Depends on" : "Merges after"} ${waitsText(waits)}`,
    );
  }
  if (pr.mergeState === "BEHIND") add("behind", "Out of date", `Behind ${base}`);
  // An armed merge waits out what blocks it; without one, say what does.
  if (pr.mergeState === "BLOCKED" && intent === undefined) {
    add("blocked", "Blocked", "Required reviews or checks are missing");
  }
  if (pr.mergeState === "UNSTABLE") {
    add("unstable", "Unstable", "Checks that aren't required are failing");
  }
  if (intent !== undefined) add("armed", "Merges when ready", "Merges when ready");
  else if (marks.length === 0 && (pr.mergeState === "CLEAN" || pr.mergeState === "HAS_HOOKS")) {
    add("mergeable", "Mergeable", `Can merge into ${base}`);
  }
  return marks;
}

/**
 * The one mark for where an open PR's merge stands: the worst of `mergeMarksOf`, its detail saying
 * them all, so its tooltip is complete. `undefined` when there is nothing to say.
 */
export function mergeMarkOf(pr: MergeSource): PrMark<MergeMarkKind> | undefined {
  const marks = mergeMarksOf(pr);
  const first = marks[0];
  if (first === undefined) return undefined;
  return { ...first, detail: marks.map((mark) => mark.detail).join("\n") };
}

// ---------------------------------------------------------------------------------------------
// The rest of a PR's facts

/** `+120 −14 · 6 files`, each part only when known; `undefined` when none is. */
export function diffText(diff: {
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
  readonly changedFiles?: number | undefined;
}): string | undefined {
  const parts: string[] = [];
  if (diff.additions !== undefined) parts.push(`+${diff.additions.toLocaleString("en")}`);
  if (diff.deletions !== undefined) parts.push(`−${diff.deletions.toLocaleString("en")}`);
  const lines = parts.join(" ");
  const files = diff.changedFiles === undefined ? undefined : plural(diff.changedFiles, "file");
  const text = [lines, files].filter((part) => part !== undefined && part !== "").join(" · ");
  return text === "" ? undefined : text;
}

// ---------------------------------------------------------------------------------------------
// A whole PR
// ---------------------------------------------------------------------------------------------

/** Everything a surface may know of one PR; each mark is drawn from what is there. */
export interface PrFacts extends MergeSource, ReviewSource, PrRefSource {
  readonly title?: string | undefined;
  /** Its head branch, for the tooltip. */
  readonly branch?: string | undefined;
  /** Every check; absent until a lookup lands. */
  readonly checks?: ChecksRollup | undefined;
  /** The checks that gate the merge, which the mark shows when known. */
  readonly requiredChecks?: ChecksRollup | undefined;
  /** Its worker will fix failing checks (`workerOwnsCiFix`). */
  readonly ciFixing?: boolean | undefined;
  /** The review bot's status, as `reviewStatusOf` reads it. */
  readonly bot?:
    | { readonly kind: BotMarkKind; readonly label: string; readonly text: string }
    | undefined;
  /** People's unresolved threads. */
  readonly peopleThreads?: number | undefined;
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
  readonly changedFiles?: number | undefined;
}

export interface PrMarks {
  readonly state: PrMark<PrLifecycle>;
  /** Absent once merged or closed, and while nothing is known of them. */
  readonly checks: PrMark<ChecksMarkKind> | undefined;
  readonly review: PrMark<ReviewMarkKind> | undefined;
  readonly threads: PrMark<ReviewMarkKind> | undefined;
  readonly bot: PrMark<BotMarkKind> | undefined;
  readonly merge: PrMark<MergeMarkKind> | undefined;
  /** Each merge fact on its own, for a card's lines. */
  readonly mergeAll: readonly PrMark<MergeMarkKind>[];
  /** `+120 −14 · 6 files`. */
  readonly diff: string | undefined;
}

/**
 * A PR's marks. A settled PR (merged or closed) shows its state only: its checks, review and merge
 * are done with. The bot's quiet status is left to places with room for words.
 */
export function prMarksOf(pr: PrFacts): PrMarks {
  const state = prStateMarkOf(pr);
  const settled = state.kind === "merged" || state.kind === "closed";
  const gating = pr.checks === undefined ? undefined : (pr.requiredChecks ?? pr.checks);
  const checks =
    settled || gating === undefined
      ? undefined
      : checksMarkOf(gating, {
          fixing: pr.ciFixing === true,
          required: pr.requiredChecks !== undefined,
        });
  const bot =
    settled || pr.bot === undefined
      ? undefined
      : { kind: pr.bot.kind, word: pr.bot.text, detail: pr.bot.label };
  return {
    state,
    checks,
    review: settled ? undefined : reviewMarkOf(pr),
    threads:
      settled || pr.bot?.kind === "reviewerThreads"
        ? undefined
        : reviewThreadsMarkOf(pr.peopleThreads ?? 0),
    bot,
    merge: mergeMarkOf(pr),
    mergeAll: mergeMarksOf(pr),
    diff: diffText(pr),
  };
}

/** The PR's tooltip: its title and ref, its branch, then a line per mark. */
export function prTooltipOf(pr: PrFacts, marks: PrMarks = prMarksOf(pr)): string {
  const ref = prRefText(pr);
  const head = pr.title === undefined || pr.title === "" ? ref : `${ref} ${pr.title}`;
  return [
    head,
    ...(pr.branch === undefined ? [] : [`Branch ${pr.branch}`]),
    marks.state.detail,
    ...[marks.checks, marks.review, marks.threads, marks.bot, marks.merge].flatMap((mark) =>
      mark === undefined ? [] : mark.detail.split("\n"),
    ),
    ...(marks.diff === undefined ? [] : [marks.diff]),
  ].join("\n");
}
