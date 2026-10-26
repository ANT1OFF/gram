// What a model is told about a thread's pull requests: checks, the AI reviewer's verdict and
// people's reviews kept apart, and what blocks the merge. Shared by the server's helper consumers
// so they describe PRs consistently. Pure: it reads a badge and what the caller already holds,
// and asks GitHub nothing.

import {
  approvingBotOnHead,
  mergeReviewPolicyOf,
  type MergeReviewCharter,
} from "./merge-policy.ts";
import type { BabysitState } from "./babysit.ts";
import { samePr, type BoundPr, type Thread } from "./domain.ts";
import {
  mergeStateAllowsMerge,
  prChecksStamp,
  repoFromPrUrl,
  requiredChecksOf,
  type ChecksRollup,
  type GitState,
  type PrCheckRun,
  type PrStatus,
} from "./git.ts";
import { isBotLogin, type ReviewBot, type ReviewVerdict } from "./review.ts";

/** Check runs as some caller last read them for a PR, under the badge state it asked with. */
export interface SeenPrChecks {
  readonly checks: ReadonlyArray<Pick<PrCheckRun, "name" | "status" | "required" | "startedAt">>;
  /** The `prChecksStamp` the read was asked under; absent when none was named. */
  readonly stamp?: string | undefined;
  /** Epoch ms. */
  readonly at: number;
}

/** The most PRs the block describes: the checkout's, then those the thread follows. */
export const PR_CONTEXT_MAX_PRS = 3;
/** The most names any one list carries; the rest are counted. */
export const PR_CONTEXT_MAX_NAMES = 5;
const NAME_MAX_CHARS = 60;
/** The whole `<pr>` block, about 400 tokens, kept apart from the transcript's own budget. */
export const PR_CONTEXT_MAX_CHARS = 1_600;
/**
 * Check names read longer ago than this aren't told. The stamp (head and rollup) can stay the same
 * while they move under it: a running check finishes, a failed one is rerun and passes while
 * another fails. Past it only the rollup is told, with the names unknown.
 */
export const CHECK_NAMES_MAX_AGE_MS = 10 * 60_000;

export type BotVerdict = ReviewVerdict | "notYet" | "unknown";

/** Coarse, so a helper's basis doesn't move every minute a check runs. */
export type PendingFor = "under 10 min" | "10-30 min" | "30-60 min" | "over 1 h" | "over 3 h";

export type MergeBlocker =
  | { readonly kind: "draft" }
  | { readonly kind: "conflicts" }
  | { readonly kind: "requiredCheckFailing" }
  | {
      readonly kind: "changesRequested";
      readonly by: "person" | "bot" | "unknown";
      readonly who?: string;
    }
  | { readonly kind: "approvalMissing" }
  | { readonly kind: "botApprovalMissing" }
  | { readonly kind: "checksPending" }
  | { readonly kind: "checksMissing" }
  | { readonly kind: "behind" }
  | { readonly kind: "held"; readonly reason: string }
  | { readonly kind: "blocked" };

export interface HumanReviewContext {
  readonly who: string;
  readonly verdict: "approved" | "changesRequested";
  /** Submitted on the PR's head commit, not an older one. */
  readonly onHead: boolean;
}

export interface ReviewRequestContext {
  readonly name: string;
  readonly team: boolean;
  readonly codeOwner: boolean;
}

/** One PR as the helper is told it. */
export interface PrContext {
  readonly number: number;
  readonly repo?: string | undefined;
  readonly state: "open" | "draft" | "merged" | "closed";
  /** The badge was carried over failed refreshes. */
  readonly stale: boolean;
  readonly checks: {
    /** The checks that gate the merge: the required ones, or every one where unknown. */
    readonly state: ChecksRollup;
    /** Whether `state` is over the required checks only. */
    readonly requiredKnown: boolean;
    /** Every check, required or not. */
    readonly all: ChecksRollup;
    readonly failing: ReadonlyArray<string>;
    readonly pending: ReadonlyArray<string>;
    /** Names left out of `failing` and `pending` by the cap. */
    readonly more: number;
    /** Checks babysitting reran as possible flakes on this head, still running. */
    readonly rerunning: ReadonlyArray<string>;
    readonly pendingFor?: PendingFor | undefined;
  };
  /** The AI reviewer; absent when no review bot is configured. */
  readonly bot?:
    | {
        readonly name: string;
        readonly verdict: BotVerdict;
        /** The verdict is on the PR's head commit. */
        readonly onHead: boolean;
        readonly reviewing: boolean;
        readonly unresolved: number;
        readonly blockers: number;
      }
    | undefined;
  readonly humans: {
    readonly reviews: ReadonlyArray<HumanReviewContext>;
    readonly requested: ReadonlyArray<ReviewRequestContext>;
    /** People and teams left out by the cap. */
    readonly more: number;
    /** The AI reviewer was asked for a review, as a request. */
    readonly botRequested: boolean;
    /** Unresolved review threads a person started. */
    readonly unresolved: number;
    /** The badge didn't read reviews, so none listed means unknown, not none. */
    readonly unread: boolean;
  };
  /** GitHub's `reviewDecision`. */
  readonly decision?: string | undefined;
  readonly blocking: ReadonlyArray<MergeBlocker>;
  /** GitHub's `mergeStateStatus`. */
  readonly mergeState?: string | undefined;
  readonly armed?:
    | {
        readonly method: string;
        readonly reviewPolicy?: "solo" | "bot" | undefined;
        readonly hold?: string | undefined;
        readonly after: ReadonlyArray<string>;
        /** GitHub refused the merge on this head. */
        readonly refusedOnHead: boolean;
      }
    | undefined;
}

export interface PrContextInput {
  readonly badge: PrStatus;
  /** `owner/repo`. */
  readonly repo?: string | undefined;
  readonly bots: ReadonlyArray<ReviewBot>;
  /** The thread's binding, when it is this PR. */
  readonly bound?: BoundPr | undefined;
  readonly babysit?: Pick<BabysitState, "rerunChecks" | "failedChecks"> | undefined;
  /** The PR's checks as last read, `Pr.seenChecks` on the server. */
  readonly seen?: SeenPrChecks | undefined;
  readonly now: number;
  readonly mergeReviewPolicy?: "solo" | "bot" | undefined;
}

/** A GitHub-supplied string as one short line that can't close the fence. */
const clean = (text: string, max = NAME_MAX_CHARS): string => {
  const line = text
    .replace(/[<>\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** A bot's login as people say it: `example-code-review[bot]` is "example-code-review". */
const botName = (login: string): string => clean(login.replace(/\[bot\]$/i, "").replace(/\*/g, ""));

const pendingFor = (ms: number): PendingFor =>
  ms < 10 * 60_000
    ? "under 10 min"
    : ms < 30 * 60_000
      ? "10-30 min"
      : ms < 60 * 60_000
        ? "30-60 min"
        : ms < 3 * 60 * 60_000
          ? "over 1 h"
          : "over 3 h";

const stateOf = (badge: PrStatus): PrContext["state"] =>
  badge.state === "MERGED"
    ? "merged"
    : badge.state === "CLOSED"
      ? "closed"
      : badge.isDraft
        ? "draft"
        : "open";

const checksOf = (input: PrContextInput): PrContext["checks"] => {
  const { badge, seen, now } = input;
  const head = badge.headRefOid;
  // Names read under another head or rollup describe another state of the PR.
  const same = seen !== undefined && seen.stamp === prChecksStamp(badge) ? seen : undefined;
  const marked = same?.checks.some((check) => check.required === true) === true;
  const gating = (same?.checks ?? []).filter((check) => !marked || check.required === true);
  const fresh = same !== undefined && now - same.at <= CHECK_NAMES_MAX_AGE_MS;
  // Without a fresh read of its own, the names the badge carries, under the same age limit.
  const failing = fresh
    ? gating.filter((c) => c.status === "failing").map((c) => clean(c.name))
    : requiredChecksOf(badge) === "failing" &&
        badge.failingChecks !== undefined &&
        now - badge.failingChecks.readAt <= CHECK_NAMES_MAX_AGE_MS
      ? badge.failingChecks.names.map((name) => clean(name))
      : [];
  const pendingRuns = gating.filter((c) => c.status === "pending");
  const pending = fresh ? pendingRuns.map((c) => clean(c.name)) : [];
  const started = pendingRuns.flatMap((c) => {
    const at = c.startedAt === undefined ? NaN : Date.parse(c.startedAt);
    return Number.isNaN(at) ? [] : [at];
  });
  const state = requiredChecksOf(badge);
  const rerunning =
    head === undefined
      ? []
      : Object.entries(input.babysit?.rerunChecks ?? {})
          .filter(([name, on]) => {
            if (on !== head || input.babysit?.failedChecks[name] === head) return false;
            const known = same?.checks.find((c) => c.name === name);
            return known === undefined ? state === "pending" : known.status === "pending";
          })
          .map(([name]) => clean(name))
          .slice(0, PR_CONTEXT_MAX_NAMES);
  const keptFailing = failing.slice(0, PR_CONTEXT_MAX_NAMES);
  const keptPending = pending.slice(0, Math.max(0, PR_CONTEXT_MAX_NAMES - keptFailing.length));
  return {
    state,
    requiredKnown: badge.requiredChecks !== undefined || marked,
    all: badge.checks,
    failing: keptFailing,
    pending: keptPending,
    more: failing.length + pending.length - keptFailing.length - keptPending.length,
    rerunning,
    ...(state === "pending" && started.length > 0
      ? { pendingFor: pendingFor(now - Math.min(...started)) }
      : {}),
  };
};

const botOf = (input: PrContextInput): PrContext["bot"] => {
  const { badge, bots } = input;
  const review = badge.review;
  const login =
    review?.bots.find((name) => isBotLogin(bots, name)) ?? review?.bots[0] ?? bots[0]?.loginPattern;
  if (login === undefined) return undefined;
  const counts = {
    unresolved: review?.threads.unresolved ?? 0,
    blockers: review?.threads.blockers ?? 0,
  };
  if (review === undefined || review.bots.length === 0) {
    return {
      name: botName(login),
      verdict: badge.reviewUnread === true ? "unknown" : "notYet",
      onHead: false,
      reviewing: review?.roundInFlight ?? false,
      ...counts,
    };
  }
  const onHead = review.verdictOnHead !== undefined || review.reviewedHead;
  const verdict: BotVerdict = onHead
    ? (review.verdictOnHead ?? "commented")
    : (review.latestVerdict ?? "notYet");
  return {
    name: botName(login),
    verdict,
    onHead: onHead && verdict !== "notYet",
    reviewing: review.roundInFlight,
    ...counts,
  };
};

const humansOf = (input: PrContextInput): PrContext["humans"] => {
  const { badge, bots } = input;
  const latest = new Map<string, HumanReviewContext>();
  for (const review of badge.review?.humanReviews ?? []) {
    // The bots were matched when the badge was read; the setting may have changed since.
    if (isBotLogin(bots, review.author)) continue;
    latest.delete(review.author);
    latest.set(review.author, {
      who: clean(review.author),
      verdict: review.verdict,
      onHead: badge.headRefOid !== undefined && review.commitOid === badge.headRefOid,
    });
  }
  const requests = badge.reviewRequests ?? [];
  const people = requests.filter((r) => r.kind === "team" || !isBotLogin(bots, r.name));
  const reviews = [...latest.values()];
  const keptReviews = reviews.slice(-PR_CONTEXT_MAX_NAMES);
  const room = Math.max(0, PR_CONTEXT_MAX_NAMES - keptReviews.length);
  const requested = people.slice(0, room).map((r) => ({
    name: clean(r.name),
    team: r.kind === "team",
    codeOwner: r.codeOwner === true,
  }));
  return {
    reviews: keptReviews,
    requested,
    more: reviews.length - keptReviews.length + people.length - requested.length,
    botRequested: people.length < requests.length,
    unresolved: badge.review?.threads.humanUnresolved ?? 0,
    unread: badge.reviewUnread === true,
  };
};

const blockersOf = (
  ctx: Omit<PrContext, "blocking">,
  input: PrContextInput,
): ReadonlyArray<MergeBlocker> => {
  if (ctx.state !== "open" && ctx.state !== "draft") return [];
  const out: Array<MergeBlocker> = [];
  if (ctx.state === "draft") out.push({ kind: "draft" });
  if (ctx.mergeState === "DIRTY") out.push({ kind: "conflicts" });
  if (ctx.checks.state === "failing") out.push({ kind: "requiredCheckFailing" });
  const person = ctx.humans.reviews.findLast((r) => r.verdict === "changesRequested");
  if (person !== undefined) {
    out.push({ kind: "changesRequested", by: "person", who: person.who });
  } else if (ctx.bot?.verdict === "changesRequested" && ctx.bot.onHead) {
    out.push({ kind: "changesRequested", by: "bot" });
  } else if (ctx.decision === "CHANGES_REQUESTED") {
    out.push({ kind: "changesRequested", by: "unknown" });
  }
  if (ctx.decision === "REVIEW_REQUIRED") out.push({ kind: "approvalMissing" });
  // The workspace may explicitly choose solo; GitHub approvals remain separate.
  if (ctx.armed !== undefined && ctx.armed.reviewPolicy !== "solo") {
    if (
      !(
        ctx.bot?.verdict === "approved" &&
        ctx.bot.onHead &&
        approvingBotOnHead(input.badge, input.bots)
      )
    )
      out.push({ kind: "botApprovalMissing" });
  }
  if (ctx.checks.state === "pending") out.push({ kind: "checksPending" });
  if (ctx.armed?.reviewPolicy === "solo" && ctx.checks.state === "none")
    out.push({ kind: "checksMissing" });
  if (ctx.mergeState === "BEHIND") out.push({ kind: "behind" });
  if (ctx.armed?.hold !== undefined) out.push({ kind: "held", reason: ctx.armed.hold });
  if (out.length === 0 && ctx.mergeState === "BLOCKED") out.push({ kind: "blocked" });
  return out;
};

/** One PR's context, from what the thread already holds of it. */
export const prContextOf = (input: PrContextInput): PrContext => {
  const { badge, bound } = input;
  const intent =
    bound !== undefined && bound.number === badge.number ? bound.mergeWhenReady : undefined;
  const base: Omit<PrContext, "blocking"> = {
    number: badge.number,
    ...(input.repo === undefined ? {} : { repo: input.repo.toLowerCase() }),
    state: stateOf(badge),
    stale: badge.stale !== undefined,
    checks: checksOf(input),
    bot: botOf(input),
    humans: humansOf(input),
    ...(badge.reviewDecision === undefined || badge.reviewDecision === ""
      ? {}
      : { decision: badge.reviewDecision }),
    ...(badge.mergeState === undefined ? {} : { mergeState: badge.mergeState }),
    ...(intent === undefined || badge.state !== "OPEN"
      ? {}
      : {
          armed: {
            method: intent.method,
            ...(input.mergeReviewPolicy === undefined
              ? {}
              : { reviewPolicy: input.mergeReviewPolicy }),
            ...(intent.hold === undefined ? {} : { hold: clean(intent.hold, 80) }),
            after: (intent.after ?? [])
              .slice(0, PR_CONTEXT_MAX_NAMES)
              .map((pr) => clean(`${pr.repo}#${pr.number}`)),
            refusedOnHead: intent.failedOn !== undefined && intent.failedOn === badge.headRefOid,
          },
        }),
  };
  return { ...base, blocking: blockersOf(base, input) };
};

const VERDICT_WORDS: Record<ReviewVerdict, string> = {
  approved: "approved",
  changesRequested: "changes requested",
  commented: "commented",
};

const list = (names: ReadonlyArray<string>, more: number): string =>
  `${names.join(", ")}${more > 0 ? `; ${more} more` : ""}`;

/** What blocks the merge, as words a prompt or a voice can say. */
export const mergeBlockerText = (b: MergeBlocker): string => {
  switch (b.kind) {
    case "draft":
      return "it is a draft";
    case "conflicts":
      return "conflicts with the base branch";
    case "requiredCheckFailing":
      return "a required check is failing";
    case "changesRequested":
      return b.by === "person"
        ? `changes requested by ${b.who ?? "a person"}`
        : b.by === "bot"
          ? "changes requested by the AI reviewer"
          : "changes requested (GitHub's review decision)";
    case "approvalMissing":
      return "a required approval is missing";
    case "botApprovalMissing":
      return "merge_when_ready waits for the AI reviewer to approve this head";
    case "checksMissing":
      return "solo development requires passing CI or Gram's own check of this head";
    case "checksPending":
      return "required checks still running";
    case "behind":
      return "the branch is behind its base";
    case "held":
      return `merge_when_ready is held: ${b.reason}`;
    case "blocked":
      return "branch protection blocks it";
  }
};

const MERGE_WORDS: Record<string, string> = {
  CLEAN: "clean, mergeable",
  UNSTABLE: "mergeable (a check that isn't required is failing or running)",
  DIRTY: "conflicting",
  BLOCKED: "blocked",
  BEHIND: "behind base",
  HAS_HOOKS: "mergeable",
  DRAFT: "draft",
  UNKNOWN: "not yet computed by GitHub",
};

interface Line {
  readonly text: string;
  /** Lower stays longer when the block is cut. */
  readonly rank: number;
}

const prLines = (pr: PrContext): ReadonlyArray<Line> => {
  const where = pr.repo === undefined ? "" : ` (${pr.repo})`;
  const header: Line = {
    text: `PR #${pr.number}${where}: ${pr.state}${pr.stale ? " · GitHub unreachable, this may be out of date" : ""}`,
    rank: 0,
  };
  if (pr.state === "merged" || pr.state === "closed") return [header];
  const lines: Array<Line> = [header];
  const { checks } = pr;
  const allowed = mergeStateAllowsMerge(pr.mergeState);
  lines.push({
    text: `Blocking merge: ${
      pr.blocking.length > 0
        ? pr.blocking.map(mergeBlockerText).join("; ")
        : allowed
          ? "nothing, GitHub would merge it"
          : "nothing known"
    }`,
    rank: 1,
  });

  const label = checks.requiredKnown ? "Required checks" : "Checks";
  const names =
    checks.state === "failing"
      ? checks.failing.length > 0
        ? ` — failing: ${list(checks.failing, checks.more)}`
        : " (names not known)"
      : checks.state === "pending" && checks.pending.length > 0
        ? ` — running: ${list(checks.pending, checks.more)}`
        : "";
  const since = checks.pendingFor === undefined ? "" : `, for ${checks.pendingFor}`;
  lines.push({ text: `${label}: ${checks.state}${since}${names}`, rank: 2 });
  if (checks.requiredKnown && checks.all !== checks.state && checks.all !== "none") {
    lines.push({ text: `Checks that aren't required: some ${checks.all}`, rank: 8 });
  }
  if (checks.rerunning.length > 0) {
    lines.push({ text: `Re-run in progress: ${checks.rerunning.join(", ")}`, rank: 4 });
  }

  const bot = pr.bot;
  if (bot !== undefined) {
    const said =
      bot.verdict === "unknown"
        ? "not read"
        : bot.verdict === "notYet"
          ? "no review yet"
          : `${VERDICT_WORDS[bot.verdict]} ${bot.onHead ? "on head" : "on an older head, not this one"}`;
    const extra = [
      ...(bot.reviewing ? ["reviewing now"] : []),
      ...(bot.unresolved > 0
        ? [
            `${bot.unresolved} open finding${bot.unresolved === 1 ? "" : "s"}${bot.blockers > 0 ? ` (${bot.blockers} blocker${bot.blockers === 1 ? "" : "s"})` : ""}`,
          ]
        : []),
    ];
    lines.push({
      text: `Bot review (${bot.name}): ${said}${extra.length > 0 ? `; ${extra.join("; ")}` : ""}`,
      rank: 3,
    });
  }

  const humans = pr.humans;
  const reviews = humans.reviews.map(
    (r) => `${r.who} — ${VERDICT_WORDS[r.verdict]}${r.onHead ? "" : " (on an older commit)"}`,
  );
  lines.push({
    text: `Human reviews: ${
      reviews.length > 0 ? reviews.join("; ") : humans.unread ? "not read" : "none"
    }${humans.unresolved > 0 ? `; ${humans.unresolved} unresolved thread${humans.unresolved === 1 ? "" : "s"} from people` : ""}`,
    rank: 3,
  });
  if (humans.requested.length > 0 || humans.more > 0) {
    const asked = humans.requested.map(
      (r) => `${r.team ? "team " : ""}${r.name}${r.codeOwner ? " (code owner)" : ""}`,
    );
    lines.push({ text: `Human review requested from: ${list(asked, humans.more)}`, rank: 5 });
  }
  if (humans.botRequested) lines.push({ text: "AI reviewer review requested", rank: 9 });

  if (pr.decision !== undefined) {
    lines.push({ text: `GitHub review decision: ${clean(pr.decision)}`, rank: 6 });
  }
  const merge = [
    pr.mergeState === undefined
      ? "unknown"
      : (MERGE_WORDS[pr.mergeState] ?? clean(pr.mergeState.toLowerCase())),
    ...(pr.armed === undefined
      ? []
      : [
          `merge_when_ready armed (${pr.armed.method}${pr.armed.reviewPolicy === undefined ? "" : `, ${pr.armed.reviewPolicy} review policy`})${pr.armed.after.length > 0 ? ` after ${pr.armed.after.join(", ")}` : ""}${pr.armed.refusedOnHead ? ", GitHub refused it on this head" : ""}`,
        ]),
  ];
  lines.push({ text: `Merge state: ${merge.join("; ")}`, rank: 4 });
  return lines;
};

/**
 * `prs` as the fenced `<pr>` block a helper prompt carries, at most `PR_CONTEXT_MAX_CHARS`: the
 * followed PRs' lines go before the thread's own, and the least telling lines first. `undefined`
 * without a PR. Labelled so the AI reviewer and people can't be read as one another.
 */
export const renderPrContext = (prs: ReadonlyArray<PrContext>): string | undefined =>
  prs.length === 0 ? undefined : ["<pr>", ...prContextLines(prs), "</pr>"].join("\n");

/**
 * `renderPrContext`'s lines without the fence, within `maxChars`, for a prompt that labels its
 * sections another way.
 */
export const prContextLines = (
  prs: ReadonlyArray<PrContext>,
  maxChars: number = PR_CONTEXT_MAX_CHARS,
): ReadonlyArray<string> => {
  const lines = prs
    .slice(0, PR_CONTEXT_MAX_PRS)
    .flatMap((pr, index) => prLines(pr).map((line) => ({ ...line, index })));
  const size = () => lines.reduce((sum, line) => sum + line.text.length + 1, 0);
  while (size() > maxChars && lines.length > 1) {
    let drop = -1;
    lines.forEach((line, i) => {
      if (i === 0) return;
      const worst = lines[drop];
      if (
        worst === undefined ||
        line.index > worst.index ||
        (line.index === worst.index && line.rank >= worst.rank)
      ) {
        drop = i;
      }
    });
    lines.splice(drop, 1);
  }
  return lines.map((line) => line.text);
};

/** What the AI reviewer said, in a few words: "approved on head", "reviewing now". */
const botSaid = (bot: NonNullable<PrContext["bot"]>): string =>
  bot.reviewing
    ? "reviewing now"
    : bot.verdict === "unknown"
      ? "not read"
      : bot.verdict === "notYet"
        ? "no review yet"
        : `${VERDICT_WORDS[bot.verdict]} ${bot.onHead ? "on head" : "an older head"}`;

/**
 * One PR in a line, for a list of threads: "PR #459 open, blocked: a required check is failing (e2e
 * (linux, light-2)); changes requested by riley · AI reviewer: approved on head".
 */
export const briefPrContext = (pr: PrContext): string => {
  const head = `PR #${pr.number} ${pr.state}`;
  if (pr.state === "merged" || pr.state === "closed") return head;
  const checks = pr.checks.state === "passing" ? ", checks passing" : "";
  const blocking = pr.blocking.map((b) =>
    b.kind === "requiredCheckFailing" && pr.checks.failing.length > 0
      ? `${mergeBlockerText(b)} (${list(pr.checks.failing, pr.checks.more)})`
      : mergeBlockerText(b),
  );
  const approvals = pr.humans.reviews.filter((r) => r.verdict === "approved").map((r) => r.who);
  return [
    `${head}${checks}${
      blocking.length > 0
        ? `, blocked: ${blocking.join("; ")}`
        : mergeStateAllowsMerge(pr.mergeState)
          ? ", ready to merge"
          : ""
    }`,
    ...(pr.bot === undefined ? [] : [`AI reviewer: ${botSaid(pr.bot)}`]),
    ...(approvals.length > 0 ? [`approved by ${approvals.join(", ")}`] : []),
  ].join(" · ");
};

/** The badges a thread's PR context describes: its checkout's PR, then the ones it follows. */
export const prContextBadges = (
  git: Pick<GitState, "pr" | "extraPrs"> | undefined,
): ReadonlyArray<PrStatus> =>
  [...(git?.pr === undefined ? [] : [git.pr]), ...(git?.extraPrs ?? [])].slice(
    0,
    PR_CONTEXT_MAX_PRS,
  );

export interface ThreadPrContextInput {
  readonly charter?: MergeReviewCharter | undefined;
  readonly thread: Pick<Thread, "boundPr" | "babysit">;
  readonly git: Pick<GitState, "pr" | "extraPrs"> | undefined;
  readonly bots: ReadonlyArray<ReviewBot>;
  readonly now: number;
  /** The checks some caller last read for a PR, where the caller keeps them. */
  readonly seen?: ((repo: string, number: number) => SeenPrChecks | undefined) | undefined;
}

/** The context of each PR a thread has, its binding's `merge_when_ready` and reruns on the bound one. */
export const threadPrContexts = ({
  thread,
  git,
  bots,
  now,
  seen,
  charter,
}: ThreadPrContextInput): ReadonlyArray<PrContext> =>
  prContextBadges(git).map((badge) => {
    const repo = repoFromPrUrl(badge.url);
    const bound =
      thread.boundPr !== undefined &&
      repo !== undefined &&
      samePr(thread.boundPr, { repo, number: badge.number })
        ? thread.boundPr
        : undefined;
    return prContextOf({
      badge,
      repo,
      bots,
      mergeReviewPolicy: mergeReviewPolicyOf(charter, repo ?? "", bots),
      bound,
      babysit: bound === undefined ? undefined : thread.babysit,
      seen: repo === undefined ? undefined : seen?.(repo, badge.number),
      now,
    });
  });

/** Credits reviewers in general with an approval. */
const BLURRED_APPROVAL =
  /\b(approved by (the )?reviewers?|(?<!\bAI )reviewers? (have |has )?approved|(?<!\bAI )reviewers? signed off)\b/i;

/** A PR the text names, `owner/repo#N` or `#N`. */
const PR_REFERENCE = /(?:\b([\w.-]+\/[\w.-]+))?#(\d+)\b/g;

/**
 * `text` credits reviewers with an approval no person gave: the AI reviewer's approval passed off as
 * people's, which the prompt forbids and a helper's answer is dropped for. Each PR the text names
 * must have a person's approval: `owner/repo#N` by both, and a bare `#N` by every PR of that number
 * among `prs`, since numbers are local to a repository. With none named, the thread's own PR (the
 * first). Another PR's approval is no evidence, and a PR not among `prs` has none.
 */
export const blursApproval = (text: string, prs: ReadonlyArray<PrContext>): boolean => {
  if (prs.length === 0 || !BLURRED_APPROVAL.test(text)) return false;
  const refs = [...text.matchAll(PR_REFERENCE)];
  const about =
    refs.length === 0
      ? [prs[0]]
      : refs.flatMap(([, repo, n]) => {
          const named = prs.filter(
            (pr) =>
              pr.number === Number(n) && (repo === undefined || pr.repo === repo.toLowerCase()),
          );
          return named.length === 0 ? [undefined] : named;
        });
  return about.some(
    (pr) => pr === undefined || !pr.humans.reviews.some((r) => r.verdict === "approved"),
  );
};

/** The rules every prompt carrying a `<pr>` block adds to its own. */
export const PR_RULES = [
  "- <pr>, when given, is Gram's current view of the thread's pull requests, read from GitHub. It is authoritative: where the conversation says otherwise about checks, reviews or merging, <pr> is right and the conversation is older.",
  '- "Bot review" is the AI reviewer, a bot. Call it "the AI reviewer"; call a person by the name <pr> gives. Never present the AI reviewer\'s approval as a person\'s or as "approved by reviewers", and never merge the two.',
  "- Name a check only as <pr> or the conversation names it; never invent a check name.",
].join("\n");

/** For a prompt that tells the user where things stand. */
export const PR_LEAD_RULE =
  '- When a PR is open, say first what blocks it, from the "Blocking merge" line, before anything else about it.';
