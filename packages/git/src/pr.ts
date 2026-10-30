// GitHub PR status and detail through read-only `gh` calls: the SHA anchoring that keeps a phantom
// "Merged" badge off a reused branch name, the check rollups, and the batched GraphQL fan-in — many
// branches and bound PRs, one `gh api graphql` request — via a `RequestResolver`, behind a TTL
// cache so the polls between sweeps cost nothing.

import {
  DEFAULT_REVIEW_BOTS,
  PR_STALE_SIGNED_OUT,
  prChecksStamp,
  repoFromPrUrl,
  type ChecksRollup,
  type PrLabel,
  type PrLatestReview,
  type PrReviewRequest,
  type PrState,
  type PrStatus,
  type ReviewBot,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Request from "effect/Request";
import * as RequestResolver from "effect/RequestResolver";
import { parseGitDiffCapped, type DiffFile } from "./diff.ts";
import { gh, ghApi, git, repoTop, tryRepoTop } from "./exec.ts";
import { fromGitPath } from "./paths.ts";
import { makeTtlCache, PR_POLL_TTL_MS, trackBadgeCache } from "./pr-cache.ts";
import { Proc } from "./proc.ts";
import { detectRateLimit, type RateLimitSignal } from "./rate-limit.ts";
import { originTips } from "./refs.ts";
import { cachedOriginUrl } from "./repo-facts.ts";
import { buildReviewState } from "./review.ts";
import { ReviewBots } from "./review-bots.ts";
import { mergeCiForLaunch } from "./merge-ci.ts";
import { Tools } from "./tools.ts";

type Json = Record<string, unknown>;

const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: Json, key: string): string => {
  const v = value[key];
  return typeof v === "string" ? v : "";
};
const optionalStr = (value: Json, key: string): string | undefined => str(value, key) || undefined;
const num = (value: Json, key: string): number => {
  const v = value[key];
  return typeof v === "number" ? v : 0;
};
const optionalCount = (value: Json, key: string): number | undefined => {
  const v = value[key];
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
};
const arr = (value: unknown): Array<Json> => (Array.isArray(value) ? value.filter(isJson) : []);

// ---------------------------------------------------------------------------------------------
// Checks

const field = (entry: Json, key: string) => str(entry, key).toUpperCase();

/**
 * The one definition of a failed check, shared by the rollup and the per-check rows. CANCELLED and
 * STALE render grey on GitHub, so they're neutral like SKIPPED, not failures.
 */
const checkIsFailure = (conclusion: string, state: string): boolean =>
  ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion) ||
  state === "FAILURE" ||
  state === "ERROR";

/** Collapse a mixed CheckRun/StatusContext rollup. Failing beats pending beats passing. */
export const rollupStatus = (rollup: unknown): ChecksRollup => {
  const entries = arr(rollup);
  if (entries.length === 0) return "none";
  let pending = false;
  for (const entry of entries) {
    const conclusion = field(entry, "conclusion");
    const state = field(entry, "state");
    if (checkIsFailure(conclusion, state)) return "failing";
    const status = field(entry, "status");
    if ((status !== "" && status !== "COMPLETED") || state === "PENDING" || state === "EXPECTED") {
      pending = true;
    }
  }
  return pending ? "pending" : "passing";
};

/**
 * The rollup over the checks branch protection requires, or `undefined` when none is marked
 * required: GitHub wasn't asked (the REST path), or can't say, and then every check counts.
 */
export const requiredRollupStatus = (rollup: unknown): ChecksRollup | undefined => {
  const required = arr(rollup).filter((entry) => entry["isRequired"] === true);
  return required.length === 0 ? undefined : rollupStatus(required);
};

export type CheckStatus = "passing" | "failing" | "pending" | "neutral";

export const checkStatusOf = (entry: Json): CheckStatus => {
  const conclusion = field(entry, "conclusion");
  const state = field(entry, "state");
  if (checkIsFailure(conclusion, state)) return "failing";
  if (conclusion === "SUCCESS" || state === "SUCCESS") return "passing";
  if (["NEUTRAL", "SKIPPED", "CANCELLED", "STALE"].includes(conclusion)) return "neutral";
  return "pending";
};

/** "N/M checks passed": passed = not failing and not in flight. */
export const checksCounts = (
  rollup: unknown,
): { readonly passed: number; readonly total: number } => {
  const entries = arr(rollup);
  const passed = entries.filter((e) => ["passing", "neutral"].includes(checkStatusOf(e))).length;
  return { passed, total: entries.length };
};

export type CheckPhase = "queued" | "running" | "completed";

export interface PrCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly link: string;
  /** The GitHub Actions run behind the check, when its link names one. */
  readonly runId?: string;
  /** GitHub's raw conclusion (SUCCESS, FAILURE, CANCELLED, …); absent until the check completes. */
  readonly conclusion?: string;
  readonly phase?: CheckPhase;
  /** ISO-8601. */
  readonly startedAt?: string;
  /** ISO-8601. */
  readonly completedAt?: string;
  /** Branch protection requires it; absent when no check of the PR is marked required. */
  readonly required?: boolean;
}

/** The Actions run id in a check link such as `…/actions/runs/<id>/job/<job>`. */
export const actionsRunId = (link: string): string | undefined =>
  /\/actions\/runs\/(\d+)/.exec(link)?.[1];

const checkPhaseOf = (entry: Json): CheckPhase => {
  const status = field(entry, "status");
  if (status === "COMPLETED") return "completed";
  if (status === "IN_PROGRESS") return "running";
  if (status !== "") return "queued";
  const state = field(entry, "state");
  return state === "PENDING" || state === "EXPECTED" ? "queued" : "completed";
};

export const checkRuns = (rollup: unknown): Array<PrCheck> => {
  const entries = arr(rollup);
  const marked = entries.some((entry) => entry["isRequired"] === true);
  return entries.map((entry) => {
    const link = str(entry, "detailsUrl") || str(entry, "targetUrl");
    const runId = actionsRunId(link);
    const conclusion = optionalStr(entry, "conclusion");
    const startedAt = optionalStr(entry, "startedAt");
    const completedAt = optionalStr(entry, "completedAt");
    return {
      name: str(entry, "name") || str(entry, "context"),
      status: checkStatusOf(entry),
      link,
      phase: checkPhaseOf(entry),
      ...(runId === undefined ? {} : { runId }),
      ...(conclusion === undefined ? {} : { conclusion }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(completedAt === undefined ? {} : { completedAt }),
      ...(marked && typeof entry["isRequired"] === "boolean"
        ? { required: entry["isRequired"] }
        : {}),
    };
  });
};

// ---------------------------------------------------------------------------------------------
// PR detail

export interface PrCommit {
  readonly oid: string;
  readonly headline: string;
  readonly author: string;
  /** ISO-8601. */
  readonly at: string;
}

export interface PrComment {
  readonly kind: "comment" | "review";
  readonly author: string;
  /** Review state (APPROVED, CHANGES_REQUESTED, …); "" for plain comments. */
  readonly state: string;
  readonly body: string;
  readonly at: string;
}

export interface PrDetail {
  readonly headRefOid?: string;
  readonly number: number;
  readonly state: PrState;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly isDraft: boolean;
  readonly author: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly commits: number;
  /** APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED; "" when GitHub reports none. */
  readonly reviewDecision: string;
  /** Submitted reviews, including bodiless approvals. */
  readonly reviews: number;
  readonly checks: ChecksRollup;
  readonly checksPassed: number;
  readonly checksTotal: number;
  readonly checkRuns: ReadonlyArray<PrCheck>;
  readonly commitList: ReadonlyArray<PrCommit>;
  readonly conversation: ReadonlyArray<PrComment>;
  readonly files: ReadonlyArray<DiffFile>;
  /** "Diff unavailable" / "Diff too large to display" when `files` was dropped. */
  readonly note?: string;
  readonly reviewRequests: ReadonlyArray<PrReviewRequest>;
  readonly latestReviews: ReadonlyArray<PrLatestReview>;
  readonly labels: ReadonlyArray<PrLabel>;
}

export interface PrDetailResponse {
  /** False: `gh` missing or logged out. */
  readonly available: boolean;
  readonly detail?: PrDetail;
  readonly error?: string;
}

const prState = (value: string): PrState =>
  value === "MERGED" || value === "CLOSED" ? value : "OPEN";

const login = (value: Json): string =>
  isJson(value["author"]) ? str(value["author"], "login") : "";

export const commitList = (view: Json): Array<PrCommit> =>
  arr(view["commits"]).map((commit) => {
    const author = arr(commit["authors"])[0];
    return {
      oid: str(commit, "oid"),
      headline: str(commit, "messageHeadline"),
      author: author ? str(author, "login") || str(author, "name") : "",
      at: str(commit, "committedDate"),
    };
  });

/** Comments and reviews merged chronologically. Bodiless COMMENTED/PENDING reviews carry no signal. */
export const conversation = (view: Json): Array<PrComment> => {
  const comments: Array<PrComment> = arr(view["comments"]).map((c) => ({
    kind: "comment",
    author: login(c),
    state: "",
    body: str(c, "body"),
    at: str(c, "createdAt"),
  }));
  const reviews: Array<PrComment> = arr(view["reviews"]).flatMap((r) => {
    const body = str(r, "body");
    const state = str(r, "state");
    if (body === "" && ["COMMENTED", "PENDING", ""].includes(state)) return [];
    return [{ kind: "review" as const, author: login(r), state, body, at: str(r, "submittedAt") }];
  });
  return [...comments, ...reviews].toSorted((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
};

/**
 * `gh`'s `reviewRequests`: users by login, teams by the `org/slug` `--add-reviewer` takes. A GraphQL
 * node reshaped into it also says whether CODEOWNERS asked; `gh` never does.
 */
export const reviewRequests = (view: Json): Array<PrReviewRequest> =>
  arr(view["reviewRequests"]).flatMap((request) => {
    const team = str(request, "__typename") === "Team";
    const name = team ? str(request, "slug") || str(request, "name") : str(request, "login");
    if (name === "") return [];
    const kind = team ? ("team" as const) : ("user" as const);
    return [
      request["asCodeOwner"] === true ? { kind, name, codeOwner: true as const } : { kind, name },
    ];
  });

export const latestReviews = (view: Json): Array<PrLatestReview> =>
  arr(view["latestReviews"]).flatMap((review) => {
    const author = login(review);
    return author === ""
      ? []
      : [{ author, state: str(review, "state"), at: str(review, "submittedAt") }];
  });

/** Labels as `gh pr view --json labels` and `gh label list --json` both print them. */
export const prLabels = (value: unknown): Array<PrLabel> =>
  arr(value).flatMap((label) => {
    const name = str(label, "name");
    return name === ""
      ? []
      : [{ name, color: str(label, "color"), description: str(label, "description") }];
  });

export const buildPrDetail = (
  view: Json,
  files: ReadonlyArray<DiffFile>,
  note: string | undefined,
): PrDetail => {
  const rollup = view["statusCheckRollup"];
  const counts = checksCounts(rollup);
  return {
    ...(optionalStr(view, "headRefOid") ? { headRefOid: optionalStr(view, "headRefOid")! } : {}),
    number: num(view, "number"),
    state: prState(str(view, "state")),
    url: str(view, "url"),
    title: str(view, "title"),
    body: str(view, "body"),
    isDraft: view["isDraft"] === true,
    author: login(view),
    baseRefName: str(view, "baseRefName"),
    headRefName: str(view, "headRefName"),
    additions: num(view, "additions"),
    deletions: num(view, "deletions"),
    changedFiles: num(view, "changedFiles"),
    commits: arr(view["commits"]).length,
    reviewDecision: str(view, "reviewDecision"),
    reviews: arr(view["reviews"]).length,
    checks: rollupStatus(rollup),
    checksPassed: counts.passed,
    checksTotal: counts.total,
    checkRuns: checkRuns(rollup),
    commitList: commitList(view),
    conversation: conversation(view),
    files,
    ...(note === undefined ? {} : { note }),
    reviewRequests: reviewRequests(view),
    latestReviews: latestReviews(view),
    labels: prLabels(view["labels"]),
  };
};

// ---------------------------------------------------------------------------------------------
// Anchoring

export interface PrInputs {
  /** The thread's OWN checkout; a PR belongs to the branch it was published from. */
  readonly workTree: string;
  readonly branch: string;
  readonly localTip: string;
  /** Pushed tip; "" when never pushed. */
  readonly remoteTip: string;
  /** `owner/name`. */
  readonly repo: string;
}

/** A PR head equal to the local or pushed tip: the only evidence strong enough for MERGED/CLOSED. */
export const isTip = (oid: string, localTip: string, remoteTip: string): boolean =>
  oid !== "" && (oid === localTip || (remoteTip !== "" && oid === remoteTip));

export interface ChosenPr {
  readonly pr: Json;
  readonly headMatches: boolean;
  readonly aheadOfPr: boolean;
}

/**
 * The PR that represents the branch, in precedence order: a tip-anchored PR (state trusted); an OPEN
 * PR whose head is an ancestor of HEAD; an OPEN PR by name (after a force-push it's still yours).
 * Only the first rung may yield a merged/closed badge.
 */
export const choosePr = <R>(
  prs: ReadonlyArray<Json>,
  localTip: string,
  remoteTip: string,
  isAncestor: (oid: string) => Effect.Effect<boolean, never, R>,
): Effect.Effect<ChosenPr | undefined, never, R> =>
  Effect.gen(function* () {
    const anchored = prs.find((p) => isTip(str(p, "headRefOid"), localTip, remoteTip));
    if (anchored) return { pr: anchored, headMatches: true, aheadOfPr: false };
    const open = prs.filter((p) => str(p, "state") === "OPEN");
    for (const p of open) {
      if (
        localTip !== "" &&
        str(p, "headRefOid") !== "" &&
        (yield* isAncestor(str(p, "headRefOid")))
      ) {
        return { pr: p, headMatches: false, aheadOfPr: true };
      }
    }
    const byName = open[0];
    return byName ? { pr: byName, headMatches: false, aheadOfPr: false } : undefined;
  });

const gitIsAncestor = (workTree: string, localTip: string) => (oid: string) =>
  git(workTree, ["merge-base", "--is-ancestor", oid, localTip]).pipe(
    Effect.map((out) => out.status === 0),
    Effect.orElseSucceed(() => false),
  );

/** Build the badge from a PR list in the `gh pr list --json` shape (GraphQL nodes reshape into it). */
export const buildPrStatus = (
  prs: ReadonlyArray<Json>,
  inputs: PrInputs,
  bots: ReadonlyArray<ReviewBot> = DEFAULT_REVIEW_BOTS,
): Effect.Effect<PrStatus | undefined, never, Proc> =>
  choosePr(
    prs,
    inputs.localTip,
    inputs.remoteTip,
    gitIsAncestor(inputs.workTree, inputs.localTip),
  ).pipe(Effect.map((chosen) => (chosen ? toPrStatus(chosen.pr, chosen, bots) : undefined)));

/** One PR in the `gh pr list --json` shape as the badge, anchored as `anchoring` says. */
const toPrStatus = (
  p: Json,
  anchoring: Pick<ChosenPr, "headMatches" | "aheadOfPr">,
  bots: ReadonlyArray<ReviewBot>,
): PrStatus => {
  const optional = {
    baseRef: optionalStr(p, "baseRefName"),
    headRef: optionalStr(p, "headRefName"),
    author: login(p) || undefined,
    additions: optionalCount(p, "additions"),
    deletions: optionalCount(p, "deletions"),
    changedFiles: optionalCount(p, "changedFiles"),
    headRefOid: optionalStr(p, "headRefOid"),
    baseRefOid: optionalStr(p, "baseRefOid"),
    baseTipOid: optionalStr(p, "baseTipOid"),
    updatedAt: optionalStr(p, "updatedAt"),
    mergeState: optionalStr(p, "mergeStateStatus"),
    reviewDecision: optionalStr(p, "reviewDecision"),
  };
  const requested = reviewRequests(p);
  const read = p["review"];
  const review = isJson(read) ? buildReviewState(read, bots, login(p)) : undefined;
  const checks = rollupStatus(p["statusCheckRollup"]);
  const requiredChecks = requiredRollupStatus(p["statusCheckRollup"]);
  return {
    number: num(p, "number"),
    state: prState(str(p, "state")),
    url: str(p, "url"),
    title: str(p, "title"),
    isDraft: p["isDraft"] === true,
    checks,
    ...(requiredChecks === undefined ? {} : { requiredChecks }),
    headMatches: anchoring.headMatches,
    aheadOfPr: anchoring.aheadOfPr,
    ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
    ...(requested.length === 0 ? {} : { reviewRequests: requested }),
    ...(review === undefined ? {} : { review }),
    ...(isJson(read) ? {} : { reviewUnread: true }),
  };
};

/** A PR named by repo and number, as a thread binds one. */
export interface BoundPrRef {
  /** `owner/repo`. */
  readonly repo: string;
  readonly number: number;
  /**
   * Read its reviews too, as a branch's PR has them: for a review monitor on it. Without, the badge
   * is `reviewUnread`.
   */
  readonly reviews?: boolean | undefined;
}

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;

/** A bound PR lookup: the checkout `gh` runs in, and the PR it names. */
export interface BoundPrInputs {
  readonly workTree: string;
  /** `owner/repo`. */
  readonly repo: string;
  readonly number: number;
  /** Read its reviews, and its review threads as a branch's PR carries them. */
  readonly reviews?: boolean | undefined;
}

/** One entry of a batched document: a branch's PRs for anchoring, or a bound PR by number. */
export type PrLookup =
  | { readonly kind: "branch"; readonly inputs: PrInputs }
  | { readonly kind: "number"; readonly bound: BoundPrInputs };

const lookupWorkTree = (lookup: PrLookup): string =>
  lookup.kind === "branch" ? lookup.inputs.workTree : lookup.bound.workTree;

/**
 * The badge for a PR named by repo and number, whichever branch the checkout is on: a PR bound from
 * another repo, or another number than the branch's. It isn't the branch's PR, so it never anchors.
 *
 * Rides the same batched `gh api graphql` document as the branch badges. `resolver` lets a caller
 * that already has one — `Pr.status` does — share its batch window; otherwise one is memoised per
 * `Proc`, so concurrent standalone callers still batch with each other. The resolver's review bots
 * decide the review state `reviews` reads.
 */
export const boundPrStatus = (
  cwd: string,
  bound: BoundPrRef,
  resolver?: RequestResolver.RequestResolver<GetPrStatus>,
): Effect.Effect<PrStatus | undefined, PrLookupError, Proc> =>
  Effect.gen(function* () {
    if (!OWNER_REPO.test(bound.repo) || !Number.isSafeInteger(bound.number) || bound.number <= 0) {
      return undefined;
    }
    const workTree = (yield* tryRepoTop(cwd)) ?? cwd;
    const proc = yield* Proc;
    const lookup = {
      kind: "number",
      bound: {
        workTree,
        repo: bound.repo,
        number: bound.number,
        ...(bound.reviews === true ? { reviews: true } : {}),
      },
    } as const;
    return yield* Effect.request(GetPrStatus({ lookup }), resolver ?? sharedPrResolver(proc));
  }).pipe(Effect.mapError((e) => new PrLookupError({ message: e.message })));

/** Hide the rebase signal when the branch sits exactly on a MERGED/CLOSED PR head: delete, don't rebase. */
export const rebaseDone = (pr: PrStatus | undefined, head: string): boolean =>
  head !== "" && pr !== undefined && pr.state !== "OPEN" && pr.headRefOid === head;

// ---------------------------------------------------------------------------------------------
// GraphQL batching

/**
 * Lookups — branches and bound PRs alike — per GraphQL document; well under GitHub's limits. A branch
 * whose PR is already known takes two blocks, so a document runs to twice this many.
 */
export const GQL_BRANCHES_PER_QUERY = 40;

/** Which PR an aliased block in the batched document names. */
export type PrLookupKind = "branch" | "number";

/** The rollup, each check saying whether PR `$<number>` requires it: a scalar, so no extra cost. */
const rollupGqlField = (number: string) =>
  "commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename " +
  `... on CheckRun{status conclusion isRequired(pullRequestNumber:$${number})} ` +
  `... on StatusContext{state isRequired(pullRequestNumber:$${number})}}}}}}}`;

/**
 * Who is asked to review, which says who a PR blocked on a review waits for. Ten nodes under one
 * PR, never under a branch's candidates, so it adds a request per block rather than ten.
 */
const REVIEW_REQUESTS_GQL_FIELD =
  "reviewRequests(first:10){nodes{asCodeOwner requestedReviewer{__typename " +
  "... on User{login} ... on Bot{login} ... on Mannequin{login} ... on Team{slug name}}}} ";

/**
 * What the badge itself reads, for the block whose PR number is `$<number>`. A bound PR takes only
 * these unless a review monitor is on it.
 */
const badgeGqlFields = (number: string) =>
  "number state url isDraft headRefOid baseRefOid baseRef{target{oid}} title baseRefName headRefName author{login} additions " +
  "deletions changedFiles updatedAt mergeStateStatus reviewDecision " +
  REVIEW_REQUESTS_GQL_FIELD +
  rollupGqlField(number);

/**
 * What decides which PR is a branch's. Nothing nested, on purpose: GitHub prices a document by the
 * requests its connections could need, so a connection under these ten candidates costs ten times
 * what it costs under the one PR chosen from them. Asking for review threads here was five of the
 * six points a branch lookup cost, measured, and the sweep spent the hour's 5,000 in twenty minutes.
 */
const DISCOVERY_GQL_FIELDS = "number state headRefOid";

// Review-bot state: summary reviews and progress comments, and bot-started threads.
// The reviews are everyone's, so people's verdicts come from the same connection at no extra cost.
const REVIEW_GQL_FIELDS =
  "reviews(last:20){nodes{id author{login __typename} state submittedAt commit{oid} body}} " +
  "comments(last:10){nodes{author{login} body}}";
const THREADS_GQL_FIELD =
  "reviewThreads(first:50){nodes{isResolved isOutdated comments(first:3){nodes{author{login __typename} body}}}}";

/**
 * How much of a PR a block asks for. `review` is a branch's PR on an ordinary sweep; its threads, a
 * nested connection and so ten times the rest together, ride along only when `reviewAndThreads`.
 */
export type PrFieldSet = "badge" | "review" | "reviewAndThreads";

const branchPrGqlFields = (number: string) => `${badgeGqlFields(number)} ${REVIEW_GQL_FIELDS}`;
const FIELD_SETS: Record<PrFieldSet, (number: string) => string> = {
  badge: badgeGqlFields,
  review: branchPrGqlFields,
  reviewAndThreads: (number) => `${branchPrGqlFields(number)} ${THREADS_GQL_FIELD}`,
};

/** One aliased block of a batched document: a branch's candidate PRs, or one PR by number. */
export type PrBlock =
  | { readonly kind: "discover"; readonly repo: string; readonly branch: string }
  | {
      readonly kind: "pr";
      readonly repo: string;
      readonly number: number;
      readonly fields: PrFieldSet;
    };

/**
 * The batched document for `blocks`: positional aliases plus typed variables, so branch names and
 * numbers are never interpolated into the query. Block `i` reads `$o<i>`/`$n<i>` and either `$b<i>`,
 * the branch whose PRs it lists, or `$p<i>`, the PR it takes.
 */
export const prGraphqlQuery = (
  blocks: ReadonlyArray<{ readonly kind: PrBlock["kind"]; readonly fields?: PrFieldSet }>,
): string => {
  const vars = blocks.map((block, i) =>
    block.kind === "discover"
      ? `$o${i}:String!,$n${i}:String!,$b${i}:String!`
      : `$o${i}:String!,$n${i}:String!,$p${i}:Int!`,
  );
  const body = blocks.map((block, i) =>
    block.kind === "discover"
      ? `e${i}:repository(owner:$o${i},name:$n${i}){pullRequests(headRefName:$b${i},first:10,` +
        `states:[OPEN,CLOSED,MERGED],orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${DISCOVERY_GQL_FIELDS}}}}`
      : `e${i}:repository(owner:$o${i},name:$n${i}){pullRequest(number:$p${i}){${FIELD_SETS[block.fields ?? "badge"](`p${i}`)}}}`,
  );
  return `query(${vars.join(",")}){${body.join("")}}`;
};

const at = (value: unknown, path: ReadonlyArray<string | number>): unknown => {
  let current = value;
  for (const key of path) {
    if (typeof key === "number") current = Array.isArray(current) ? current[key] : undefined;
    else current = isJson(current) ? current[key] : undefined;
  }
  return current;
};

/** Reshape the badge fields of a GraphQL PullRequest node into the `gh pr view --json` shape. */
const reshapeBadgeNode = (node: Json): Json => ({
  number: node["number"],
  state: node["state"],
  url: node["url"],
  isDraft: node["isDraft"],
  headRefOid: node["headRefOid"],
  baseRefOid: node["baseRefOid"],
  baseTipOid: at(node, ["baseRef", "target", "oid"]),
  title: node["title"],
  baseRefName: node["baseRefName"],
  headRefName: node["headRefName"],
  author: node["author"],
  additions: node["additions"],
  deletions: node["deletions"],
  changedFiles: node["changedFiles"],
  updatedAt: node["updatedAt"],
  mergeStateStatus: node["mergeStateStatus"],
  reviewDecision: node["reviewDecision"],
  reviewRequests: arr(at(node, ["reviewRequests", "nodes"])).map((request): Json => {
    const reviewer = at(request, ["requestedReviewer"]);
    return { ...(isJson(reviewer) ? reviewer : {}), asCodeOwner: request["asCodeOwner"] };
  }),
  statusCheckRollup: arr(
    at(node, ["commits", "nodes", 0, "commit", "statusCheckRollup", "contexts", "nodes"]),
  ).map((c): Json =>
    c["__typename"] === "CheckRun"
      ? { status: c["status"], conclusion: c["conclusion"], isRequired: c["isRequired"] }
      : c["__typename"] === "StatusContext"
        ? { state: c["state"], isRequired: c["isRequired"] }
        : {},
  ),
});

/**
 * Reshape a GraphQL PullRequest node into the `gh pr list --json` object shape. `reviewThreads` is
 * the node's own unless the caller carries them from a fuller block.
 */
export const reshapePrNode = (
  node: Json,
  reviewThreads: unknown = node["reviewThreads"],
): Json => ({
  ...reshapeBadgeNode(node),
  baseRefOid: node["baseRefOid"] ?? at(node, ["baseRef", "target", "oid"]) ?? null,
  review: {
    headRefOid: node["headRefOid"],
    reviews: node["reviews"],
    reviewThreads,
    comments: node["comments"],
  },
});

type Attempt<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly reason: string };

const attempt = <A, R>(
  effect: Effect.Effect<A, { readonly message: string }, R>,
): Effect.Effect<Attempt<A>, never, R> =>
  effect.pipe(
    Effect.map((value): Attempt<A> => ({ ok: true, value })),
    Effect.catch((error) => Effect.succeed<Attempt<A>>({ ok: false, reason: error.message })),
  );

type BatchOutcome =
  /** Block `i`'s answer: a `discover` block's PR nodes, or a `pr` block's node (absent when null). */
  | { readonly kind: "Data"; readonly answers: ReadonlyArray<unknown> }
  /** A body without usable `data`: a GraphQL-shape problem REST might not share. */
  | { readonly kind: "NoData" }
  /** `gh` itself failed (offline, logged out); REST would hit the same wall. */
  | { readonly kind: "RequestFailed"; readonly reason: string };

const graphqlErrorText = (body: unknown): string =>
  arr(at(body, ["errors"]))
    .map((error) => str(error, "message"))
    .filter((message) => message !== "")
    .join("\n");

/** One `gh api graphql` for `blocks`, run in `workTree` so `gh` picks up that checkout's host. */
const runBlocks = (
  workTree: string,
  blocks: ReadonlyArray<PrBlock>,
): Effect.Effect<BatchOutcome, never, Proc> =>
  Effect.gen(function* () {
    if (blocks.length === 0) return { kind: "Data", answers: [] } as const;
    const args = ["graphql", "-f", `query=${prGraphqlQuery(blocks)}`];
    for (const [i, block] of blocks.entries()) {
      const slash = block.repo.indexOf("/");
      if (slash <= 0) return { kind: "NoData" } as const;
      args.push(
        "-f",
        `o${i}=${block.repo.slice(0, slash)}`,
        "-f",
        `n${i}=${block.repo.slice(slash + 1)}`,
      );
      if (block.kind === "discover") args.push("-f", `b${i}=${block.branch}`);
      else args.push("-F", `p${i}=${block.number}`);
    }
    const out = yield* attempt(ghApi(workTree, args));
    if (!out.ok) return { kind: "RequestFailed", reason: out.reason } as const;
    // `gh api graphql` exits non-zero whenever `errors` is present, yet still prints partial data.
    let body: unknown;
    try {
      body = JSON.parse(out.value.stdout.trim());
    } catch {
      return {
        kind: "RequestFailed",
        reason:
          out.value.stderr.trim() || `gh exited with code ${out.value.status} and no usable body`,
      } as const;
    }
    const data = at(body, ["data"]);
    if (!isJson(data)) {
      // Falling back to REST here would turn one refused document into 40 refused requests.
      const reason = `${graphqlErrorText(body)}\n${out.value.stderr}`.trim();
      return detectRateLimit(reason) === undefined
        ? ({ kind: "NoData" } as const)
        : ({ kind: "RequestFailed", reason } as const);
    }
    return {
      kind: "Data",
      answers: blocks.map((block, i) =>
        block.kind === "discover"
          ? arr(at(data, [`e${i}`, "pullRequests", "nodes"]))
          : at(data, [`e${i}`, "pullRequest"]),
      ),
    } as const;
  });

const REST_PR_FIELDS =
  "number,state,url,isDraft,headRefOid,baseRefOid,title,statusCheckRollup,baseRefName,headRefName,author,additions,deletions,changedFiles,updatedAt,reviewDecision,reviewRequests";

const restPrList = (inputs: PrInputs): Effect.Effect<ReadonlyArray<Json>, PrLookupError, Proc> =>
  gh(inputs.workTree, [
    "pr",
    "list",
    "--head",
    inputs.branch,
    "--repo",
    inputs.repo,
    "--state",
    "all",
    "--limit",
    "10",
    "--json",
    REST_PR_FIELDS,
  ]).pipe(
    Effect.mapError((e) => new PrLookupError({ message: e.message })),
    Effect.flatMap((out) => {
      if (out.status !== 0) return Effect.fail(new PrLookupError({ message: out.stderr.trim() }));
      try {
        return Effect.succeed(arr(JSON.parse(out.stdout.trim())));
      } catch {
        return Effect.fail(new PrLookupError({ message: "gh pr list returned no JSON" }));
      }
    }),
  );

/** The one `gh pr view` for a bound PR, for when the batched document came back unusable. */
const restBoundPr = (
  bound: BoundPrInputs,
): Effect.Effect<ReadonlyArray<Json>, PrLookupError, Proc> =>
  gh(bound.workTree, [
    "pr",
    "view",
    String(bound.number),
    "--repo",
    bound.repo,
    "--json",
    `${REST_PR_FIELDS},mergeStateStatus`,
  ]).pipe(
    Effect.mapError((e) => new PrLookupError({ message: e.message })),
    Effect.flatMap((out) => {
      if (out.status !== 0) return Effect.fail(new PrLookupError({ message: out.stderr.trim() }));
      try {
        const parsed: unknown = JSON.parse(out.stdout.trim());
        return Effect.succeed(isJson(parsed) ? [parsed] : []);
      } catch {
        return Effect.fail(new PrLookupError({ message: "gh pr view returned no JSON" }));
      }
    }),
  );

/** The commit at the tip of `branch`, read from GitHub. */
const baseTip = (cwd: string, repo: string, branch: string) =>
  ghApi(cwd, [
    "--method",
    "GET",
    `repos/${repo}/commits/${encodeURIComponent(`heads/${branch}`)}`,
    "--jq",
    ".sha",
  ]).pipe(
    Effect.mapError((e) => new PrLookupError({ message: e.message })),
    Effect.flatMap((out) => {
      const sha = out.stdout.trim();
      return out.status === 0 && /^[a-f0-9]{40}$/.test(sha)
        ? Effect.succeed(sha)
        : Effect.fail(new PrLookupError({ message: `The tip of ${branch} couldn't be read` }));
    }),
  );

/**
 * The PR lookup couldn't complete, so the badge is UNKNOWN: keep the carried one.
 *
 * `rateLimit` is the shared classification of `message`, so callers schedule a backoff off the one
 * matcher in `rate-limit.ts` instead of grepping the text themselves.
 */
export class PrLookupError extends Data.TaggedError("PrLookupError")<{
  readonly message: string;
}> {
  get rateLimit(): RateLimitSignal | undefined {
    return detectRateLimit(this.message);
  }
}

/** Why a PR lookup failed, in a few words for the stale badge's tooltip. */
export const prLookupReason = (message: string): string => {
  if (detectRateLimit(message) !== undefined) return "rate limited";
  const text = message.toLowerCase();
  if (text.includes("gh auth login") || text.includes("authentication") || text.includes("401")) {
    return PR_STALE_SIGNED_OUT;
  }
  if (/could not resolve|timed out|timeout|connection|network|econn/.test(text)) {
    return "network unavailable";
  }
  const first = message.trim().split("\n")[0] ?? "";
  if (first === "") return "gh failed";
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
};

export interface GetPrStatus extends Request.Request<PrStatus | undefined, PrLookupError> {
  readonly _tag: "GetPrStatus";
  readonly lookup: PrLookup;
}

export const GetPrStatus = Request.tagged<GetPrStatus>("GetPrStatus");

const NOT_ANCHORED = { headMatches: false, aheadOfPr: false } as const;

const restFallback = (
  lookup: PrLookup,
  bots: ReadonlyArray<ReviewBot>,
): Effect.Effect<PrStatus | undefined, PrLookupError, Proc> =>
  lookup.kind === "branch"
    ? Effect.flatMap(restPrList(lookup.inputs), (list) => buildPrStatus(list, lookup.inputs, bots))
    : Effect.map(restBoundPr(lookup.bound), ([node]) =>
        node === undefined ? undefined : toPrStatus(node, NOT_ANCHORED, bots),
      );

/**
 * How long a PR's review threads are reused before they ride a sweep again. A thread someone opens
 * or replies to moves the PR's `updatedAt`, which refetches them at once; resolving one on
 * github.com may not, and this is how long that can go unseen.
 */
export const THREADS_MAX_AGE_MS = 120_000;

interface CarriedThreads {
  /** The `reviewThreads` connection as GitHub returned it. */
  readonly threads: unknown;
  /** `headRefOid|updatedAt` of the PR when they were read. */
  readonly stamp: string;
  readonly at: number;
}

/**
 * What one resolver remembers between documents: the PR each branch last resolved to, so its full
 * fields can ride the same document as the candidates it is chosen from, and each PR's review
 * threads, so they needn't.
 */
export interface PrMemo {
  readonly known: Map<string, number>;
  readonly threads: Map<string, CarriedThreads>;
  /** Forgets the threads, for a write that may have resolved or added one. */
  readonly clear: () => void;
}

export const makePrMemo = (): PrMemo => {
  const threads = new Map<string, CarriedThreads>();
  return { known: new Map(), threads, clear: () => threads.clear() };
};

const branchKey = (repo: string, branch: string) => `${repo.toLowerCase()}#${branch}`;
const prKey = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

/**
 * The badge from a PR node read with its reviews, or `undefined` when its threads are neither in
 * the node nor carried from a read of the PR as it stands now, and have to be fetched.
 */
const reviewedBadge = (
  node: Json,
  block: { readonly repo: string; readonly number: number; readonly fields: PrFieldSet },
  anchoring: Pick<ChosenPr, "headMatches" | "aheadOfPr">,
  bots: ReadonlyArray<ReviewBot>,
  memo: PrMemo,
  now: number,
): PrStatus | undefined => {
  const key = prKey(block.repo, block.number);
  const stamp = `${str(node, "headRefOid")}|${str(node, "updatedAt")}`;
  if (block.fields === "reviewAndThreads") {
    memo.threads.set(key, { threads: node["reviewThreads"], stamp, at: now });
  }
  const carried = memo.threads.get(key);
  if (carried === undefined || carried.stamp !== stamp) return undefined;
  return toPrStatus(reshapePrNode(node, carried.threads), anchoring, bots);
};

type Entry = Request.Entry<GetPrStatus>;

const resolveChunk = (
  chunk: ReadonlyArray<Entry>,
  bots: ReadonlyArray<ReviewBot>,
  memo: PrMemo,
): Effect.Effect<void, never, Proc> =>
  Effect.gen(function* () {
    const first = chunk[0];
    if (first === undefined) return;
    const workTree = lookupWorkTree(first.request.lookup);
    const now = yield* Clock.currentTimeMillis;

    const blocks: Array<PrBlock> = [];
    /** The review block for a PR: its threads only when none carried are fresh enough. */
    const reviewBlock = (repo: string, number: number) => {
      const carried = memo.threads.get(prKey(repo, number));
      const fields: PrFieldSet =
        carried !== undefined && now - carried.at < THREADS_MAX_AGE_MS
          ? "review"
          : "reviewAndThreads";
      blocks.push({ kind: "pr", repo, number, fields });
      return { at: blocks.length - 1, repo, number, fields };
    };
    const plans = chunk.map((entry) => {
      const lookup = entry.request.lookup;
      if (lookup.kind === "number") {
        const { repo, number } = lookup.bound;
        if (lookup.bound.reviews === true) {
          const known = reviewBlock(repo, number);
          return { at: known.at, known };
        }
        blocks.push({ kind: "pr", repo, number, fields: "badge" });
        return { at: blocks.length - 1 };
      }
      const { repo, branch } = lookup.inputs;
      blocks.push({ kind: "discover", repo, branch });
      const discoverAt = blocks.length - 1;
      const number = memo.known.get(branchKey(repo, branch));
      if (number === undefined) return { at: discoverAt };
      return { at: discoverAt, known: reviewBlock(repo, number) };
    });

    const outcome = yield* runBlocks(workTree, blocks);
    if (outcome.kind !== "Data") {
      for (const entry of chunk) {
        entry.completeUnsafe(
          outcome.kind === "NoData"
            ? yield* Effect.exit(restFallback(entry.request.lookup, bots))
            : Exit.fail(new PrLookupError({ message: outcome.reason })),
        );
      }
      return;
    }

    // A branch whose PR wasn't in the document — never seen, or no longer the one chosen — or a PR
    // read with its reviews that moved since its threads were read: one more document, with the
    // threads, for just those.
    const pending: Array<{
      readonly entry: Entry;
      readonly block: PrBlock & { readonly kind: "pr" };
      readonly anchoring: Pick<ChosenPr, "headMatches" | "aheadOfPr">;
    }> = [];
    for (const [i, entry] of chunk.entries()) {
      const lookup = entry.request.lookup;
      const plan = plans[i]!;
      if (lookup.kind === "number" && plan.known !== undefined) {
        const node = outcome.answers[plan.at];
        // GitHub has no such PR.
        if (!isJson(node)) {
          entry.completeUnsafe(Exit.succeed(undefined));
          continue;
        }
        const badge = reviewedBadge(node, plan.known, NOT_ANCHORED, bots, memo, now);
        if (badge !== undefined) entry.completeUnsafe(Exit.succeed(badge));
        else {
          const { repo, number } = plan.known;
          pending.push({
            entry,
            block: { kind: "pr", repo, number, fields: "reviewAndThreads" },
            anchoring: NOT_ANCHORED,
          });
        }
        continue;
      }
      if (lookup.kind === "number") {
        const node = outcome.answers[plan.at];
        entry.completeUnsafe(
          Exit.succeed(
            isJson(node) ? toPrStatus(reshapeBadgeNode(node), NOT_ANCHORED, bots) : undefined,
          ),
        );
        continue;
      }
      const { inputs } = lookup;
      const chosen = yield* choosePr(
        arr(outcome.answers[plan.at]),
        inputs.localTip,
        inputs.remoteTip,
        gitIsAncestor(inputs.workTree, inputs.localTip),
      );
      const key = branchKey(inputs.repo, inputs.branch);
      if (chosen === undefined) {
        memo.known.delete(key);
        entry.completeUnsafe(Exit.succeed(undefined));
        continue;
      }
      const number = num(chosen.pr, "number");
      memo.known.set(key, number);
      const node = plan.known?.number === number ? outcome.answers[plan.known.at] : undefined;
      const badge =
        plan.known !== undefined && isJson(node)
          ? reviewedBadge(node, plan.known, chosen, bots, memo, now)
          : undefined;
      if (badge !== undefined) entry.completeUnsafe(Exit.succeed(badge));
      else {
        pending.push({
          entry,
          block: { kind: "pr", repo: inputs.repo, number, fields: "reviewAndThreads" },
          anchoring: chosen,
        });
      }
    }
    if (pending.length === 0) return;

    const followUp = yield* runBlocks(
      workTree,
      pending.map((p) => p.block),
    );
    for (const [i, { entry, block, anchoring }] of pending.entries()) {
      if (followUp.kind === "NoData") {
        entry.completeUnsafe(yield* Effect.exit(restFallback(entry.request.lookup, bots)));
        continue;
      }
      if (followUp.kind === "RequestFailed") {
        entry.completeUnsafe(Exit.fail(new PrLookupError({ message: followUp.reason })));
        continue;
      }
      const node = followUp.answers[i];
      const badge = isJson(node)
        ? reviewedBadge(node, block, anchoring, bots, memo, now)
        : undefined;
      entry.completeUnsafe(
        badge === undefined
          ? Exit.fail(
              new PrLookupError({ message: `GitHub returned no data for #${block.number}` }),
            )
          : Exit.succeed(badge),
      );
    }
  });

/**
 * Batches every concurrently-requested lookup — branch badges and bound PRs together — into one
 * `gh api graphql` per 40. A branch is a list of candidate PRs, anchored as ever, plus the PR it last
 * resolved to by number; only a branch resolving to a different PR, or one that moved since its
 * threads were read, costs a second document, as does a bound PR read with its reviews that moved.
 * A shape problem falls back to one `gh` call per lookup; a `gh` process failure or a rate-limited
 * document fails the batch rather than fanning out into the same wall.
 */
export const makePrResolver = (
  proc: Proc["Service"],
  reviewBots: Effect.Effect<ReadonlyArray<ReviewBot>> = Effect.succeed(DEFAULT_REVIEW_BOTS),
  memo: PrMemo = makePrMemo(),
): RequestResolver.RequestResolver<GetPrStatus> =>
  RequestResolver.make<GetPrStatus>((entries) =>
    Effect.gen(function* () {
      const bots = yield* reviewBots;
      for (let start = 0; start < entries.length; start += GQL_BRANCHES_PER_QUERY) {
        yield* resolveChunk(entries.slice(start, start + GQL_BRANCHES_PER_QUERY), bots, memo);
      }
    }).pipe(Effect.provideService(Proc, proc)),
  );

const sharedResolvers = new WeakMap<
  Proc["Service"],
  RequestResolver.RequestResolver<GetPrStatus>
>();

/** One resolver per `Proc`, so callers without their own still share a batch window. */
const sharedPrResolver = (proc: Proc["Service"]): RequestResolver.RequestResolver<GetPrStatus> => {
  const existing = sharedResolvers.get(proc);
  if (existing !== undefined) return existing;
  const created = makePrResolver(proc);
  sharedResolvers.set(proc, created);
  return created;
};

// ---------------------------------------------------------------------------------------------
// Inputs

/** `owner/repo` from a remote URL (scp-style, https, ssh); `undefined` when not shaped like one. */
export const parseOwnerRepo = (url: string): string | undefined => {
  const match =
    /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?[^/:]+[:/](?:\d+\/)?([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  return match ? `${match[1]}/${match[2]}` : undefined;
};

/** `owner/repo` of the checkout's `origin`, kept while the repo's config is unchanged. */
export const originOwnerRepo = (cwd: string): Effect.Effect<string | undefined, never, Proc> =>
  cachedOriginUrl(cwd).pipe(
    Effect.map((url) => (url === undefined ? undefined : parseOwnerRepo(url))),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * The repo for `--repo`, preferring the local origin URL over `gh repo view`: instant, and right on a
 * fork, where gh's default repo can be the upstream.
 */
const resolveRepoNwo = (workTree: string) =>
  Effect.gen(function* () {
    const origin = yield* originOwnerRepo(workTree);
    if (origin !== undefined) return origin;
    const out = yield* gh(
      workTree,
      ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
      { timeoutMs: 8_000 },
    ).pipe(Effect.option);
    return Option.isSome(out) && out.value.status === 0
      ? out.value.stdout.trim() || undefined
      : undefined;
  });

/**
 * The checkout's toplevel, HEAD, upstream tip and branch, as one `rev-parse` prints them, line by line.
 * A missing upstream (never pushed, or its ref deleted) or a detached HEAD stops it at `@{upstream}`
 * with the lines before printed; an unborn HEAD stops it at `HEAD`, and outside a repo it prints none.
 */
export const PR_INPUTS_REV_PARSE = [
  "rev-parse",
  "--show-toplevel",
  "HEAD",
  "@{upstream}",
  "--abbrev-ref",
  "HEAD",
] as const;

/**
 * The lookup inputs for `cwd`, or `undefined` for a terminal "no PR possible" (not a repo, detached or
 * unborn, no GitHub remote). A timed-out probe fails: branch and tips are unknown. A pushed branch is
 * one `git` run, since the origin's repo is kept; a branch without an upstream adds its name and the
 * `origin/<branch>` tip, the pushed tip when it was pushed without `-u`.
 */
export const resolvePrInputs = (
  cwd: string,
): Effect.Effect<PrInputs | undefined, PrLookupError, Proc> =>
  Effect.gen(function* () {
    const out = yield* git(cwd, PR_INPUTS_REV_PARSE);
    const [top = "", localTip = "", upstreamLine = "", branchLine = ""] = out.stdout
      .split("\n")
      .map((line) => line.trim());
    if (top === "" || localTip === "") return undefined;
    const workTree = fromGitPath(top);
    const tracked = out.status === 0 && upstreamLine !== "" && branchLine !== "";
    const branch = tracked
      ? branchLine
      : (yield* git(workTree, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    if (branch === "" || branch === "HEAD") return undefined;
    const tip = tracked
      ? upstreamLine
      : ((yield* originTips(workTree, [branch]).pipe(
          Effect.orElseSucceed(() => new Map<string, string>()),
        )).get(branch) ?? "");
    const repo = yield* resolveRepoNwo(workTree);
    if (repo === undefined) return undefined;
    return { workTree, branch, localTip, remoteTip: tip, repo } satisfies PrInputs;
  }).pipe(Effect.mapError((e) => new PrLookupError({ message: e.message })));

// ---------------------------------------------------------------------------------------------
// Service

export class Pr extends Context.Service<
  Pr,
  {
    /**
     * The badge for `cwd`'s branch, or with `bound` for that PR whatever the branch;
     * `undefined` when `gh` isn't ready or no PR applies. `checkout`, the branch and HEAD the caller
     * has just read, lets a branch lookup take the inputs `prime` read if they are still that.
     * `fresh` bypasses badge caches and old resolver memo/in-flight reads for an action.
     * `forMerge` also forces freshness and verifies declared CI and exact-head Actions runs.
     */
    readonly status: (
      cwd: string,
      bound?: BoundPrRef,
      checkout?: PrimedCheckout,
      options?: {
        readonly fresh?: boolean | undefined;
        readonly forMerge?: boolean | undefined;
        /**
         * The head a solo local-check attestation vouches for: when it is the badge's head, that
         * check stands in for the runner evidence, all but the jobs the base declares `alwaysJobs`.
         */
        readonly localCheckHead?: string | undefined;
      },
    ) => Effect.Effect<PrStatus | undefined, PrLookupError>;
    /** `number` in `repo`, or in `cwd`'s origin repo when `repo` is absent. */
    readonly detail: (
      cwd: string,
      number: number,
      repo?: string,
    ) => Effect.Effect<PrDetailResponse>;
    /**
     * `number`'s checks by name, in `repo` or else `cwd`'s origin repo. For whoever needs to say
     * which check failed or rerun it: the badge carries only the rollup, and `detail` answers this
     * with the whole PR and its diff, two `gh` runs where this is one small one.
     */
    readonly checks: (
      cwd: string,
      number: number,
      repo?: string,
      options?: PrChecksOptions,
    ) => Effect.Effect<ReadonlyArray<PrCheck>, PrLookupError>;
    /**
     * The checks `checks` last read for `number` in `repo` (`owner/repo`), with the stamp it was
     * asked under and when, kept past the cache's TTL; never asks GitHub. For a reader that may
     * only describe what is already known, as the helper model's PR context does.
     */
    readonly seenChecks: (repo: string, number: number) => Effect.Effect<SeenChecks | undefined>;
    /**
     * Looks every one of `lookups` up together, so the `status` calls a sweep makes right after
     * are answered from the cache. Checkouts reach `status` one at a time, each after its own git
     * work, and asked that way each is a document of its own; GitHub charges a point a document
     * however little it carries, so a sweep of fifteen cost fifteen where this costs one. Never
     * fails: a lookup that can't be answered now is simply asked again by `status`.
     */
    readonly prime: (
      lookups: ReadonlyArray<{ readonly cwd: string; readonly bound?: BoundPrRef | undefined }>,
    ) => Effect.Effect<void>;
  }
>()("@gram/git/Pr") {}

/** One `Pr.checks` answer as `Pr.seenChecks` keeps it. */
export interface SeenChecks {
  readonly checks: ReadonlyArray<PrCheck>;
  /** The `prChecksStamp` it was asked under; absent for a caller that named none. */
  readonly stamp?: string | undefined;
  /** Epoch ms. */
  readonly at: number;
}

/** How many PRs' checks `Pr.seenChecks` remembers; the oldest read goes first. */
export const SEEN_CHECKS_MAX = 256;

/** One PR's key in the checks cache and `Pr.seenChecks`: GitHub ignores the repo's case. */
const checksKey = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

/** A checkout's branch and HEAD as just read, which primed lookup inputs must still match. */
export interface PrimedCheckout {
  readonly branch: string | undefined;
  readonly head: string;
}

/** How far `Pr.checks` may answer from what it read before. */
export interface PrChecksOptions {
  /**
   * The state the caller has seen the PR in, from `prChecksStamp`: an answer read under another
   * stamp, or under none, is never reused for it. Checks change on GitHub without any write from
   * here, so without one a lookup made as they fail can be answered from before they did.
   */
  readonly stamp?: string | undefined;
  /**
   * Ask GitHub whatever is cached. For a caller that acts on the answer: a rerun decided on checks
   * read before they failed finds nothing to rerun.
   */
  readonly fresh?: boolean | undefined;
}

// Lives in contracts, where the helper's PR context reads it.
export { prChecksStamp } from "@gram/contracts";

/** One PR's checks by name, and nothing else of it: two requests, so a point. */
export const PR_CHECKS_QUERY =
  "query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){" +
  "commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename " +
  "... on CheckRun{name status conclusion detailsUrl startedAt completedAt isRequired(pullRequestNumber:$p)} " +
  "... on StatusContext{context state targetUrl isRequired(pullRequestNumber:$p)}}}}}}}}}}";

/**
 * The checks in a `PR_CHECKS_QUERY` body, or `undefined` when it names no PR. A PR with no checks
 * has a null rollup, which is an answer: none.
 */
export const parsePrChecks = (body: unknown): ReadonlyArray<PrCheck> | undefined => {
  const pullRequest = at(body, ["data", "repository", "pullRequest"]);
  if (!isJson(pullRequest)) return undefined;
  return checkRuns(
    at(pullRequest, ["commits", "nodes", 0, "commit", "statusCheckRollup", "contexts", "nodes"]),
  );
};

/**
 * `rollup` with each check marked required or not as the same-named one in `runs` is: `runs` come
 * from a lookup that asks GitHub, `rollup` from one that can't. A check `runs` doesn't name stays
 * unmarked, and all of them do when `runs` marks none required.
 */
export const withRequired = (
  rollup: ReadonlyArray<Json>,
  runs: ReadonlyArray<PrCheck>,
): ReadonlyArray<Json> => {
  if (!runs.some((run) => run.required === true)) return rollup;
  const required = new Map(runs.map((run) => [run.name, run.required]));
  return rollup.map((entry) => {
    const marked = required.get(str(entry, "name") || str(entry, "context"));
    return marked === undefined ? entry : { ...entry, isRequired: marked };
  });
};

/** How many checkouts' lookup inputs `Pr.prime` reads at once: a handful of `git` runs each. */
const PRIME_INPUT_CONCURRENCY = 8;

/**
 * How long `Pr.status` reuses a badge. It has to stay under the caller's badge sweep interval, or a
 * scheduled sweep is answered from the cache and a change made on GitHub waits out the TTL instead.
 */
export const PrBadgeTtlMs = Context.Reference<number>("@gram/git/PrBadgeTtlMs", {
  defaultValue: () => PR_POLL_TTL_MS,
});

export const PrLive = Layer.effect(
  Pr,
  Effect.gen(function* () {
    const proc = yield* Proc;
    const tools = yield* Tools;
    const reviewBots = yield* ReviewBots;
    const ttlMs = yield* PrBadgeTtlMs;
    const memo = makePrMemo();
    const resolver = makePrResolver(proc, reviewBots.get, memo);
    const provide = Effect.provideService(Proc, proc);

    // Keyed on the tips the badge is anchored against, so a commit, push or fetch is a new entry
    // and can never be answered from the one before it.
    const branchBadges = makeTtlCache<PrInputs, PrStatus | undefined, PrLookupError, never>({
      key: (inputs) => `${inputs.repo}#${inputs.branch}@${inputs.localTip}|${inputs.remoteTip}`,
      ttlMs,
      fetch: (inputs) =>
        Effect.request(GetPrStatus({ lookup: { kind: "branch", inputs } }), resolver),
    });

    const boundBadges = makeTtlCache<
      { readonly cwd: string; readonly bound: BoundPrRef },
      PrStatus | undefined,
      PrLookupError,
      never
    >({
      // A review monitor's lookup is its own entry: a badge read without reviews can't answer it.
      key: ({ bound }) =>
        `${bound.repo.toLowerCase()}#${bound.number}${bound.reviews === true ? "+reviews" : ""}`,
      ttlMs,
      fetch: ({ cwd, bound }) => provide(boundPrStatus(cwd, bound, resolver)),
    });

    interface PrChecksInput {
      readonly workTree: string;
      readonly repo: string;
      readonly number: number;
      readonly stamp?: string | undefined;
    }

    const seen = new Map<string, SeenChecks>();

    const fetchPrChecks = ({ workTree, repo, number, stamp }: PrChecksInput) =>
      provide(
        Effect.gen(function* () {
          const slash = repo.indexOf("/");
          const out = yield* ghApi(workTree, [
            "graphql",
            "-f",
            `query=${PR_CHECKS_QUERY}`,
            "-f",
            `o=${repo.slice(0, slash)}`,
            "-f",
            `n=${repo.slice(slash + 1)}`,
            "-F",
            `p=${number}`,
          ]).pipe(Effect.mapError((e) => new PrLookupError({ message: e.message })));
          let body: unknown;
          try {
            body = JSON.parse(out.stdout.trim());
          } catch {
            body = undefined;
          }
          const checks = parsePrChecks(body);
          if (checks !== undefined) {
            const key = checksKey(repo, number);
            seen.delete(key);
            seen.set(key, { checks, stamp, at: yield* Clock.currentTimeMillis });
            if (seen.size > SEEN_CHECKS_MAX) seen.delete(seen.keys().next().value!);
            return checks;
          }
          return yield* new PrLookupError({
            message:
              `${graphqlErrorText(body)}\n${out.stderr}`.trim() ||
              `GitHub returned no data for #${number}`,
          });
        }),
      );

    // One entry a PR, shared by every checkout and caller: a failing run is announced to every
    // thread on the PR at once. A caller that names the state it has seen only takes an answer read
    // under that state; one that names none takes whatever is there.
    const prChecks = makeTtlCache<PrChecksInput, ReadonlyArray<PrCheck>, PrLookupError, never>({
      key: ({ repo, number }) => checksKey(repo, number),
      ttlMs,
      fetch: fetchPrChecks,
      reusable: (input, cached) => input.stamp === undefined || input.stamp === cached.stamp,
    });

    for (const cache of [branchBadges, boundBadges, prChecks, memo]) {
      const untrack = trackBadgeCache(cache);
      yield* Effect.addFinalizer(() => Effect.sync(untrack));
    }

    /**
     * Per checkout: the lookup inputs `prime` just read, taken by the `status` call its sweep makes
     * next instead of reading them again. Older than a badge may be, or read on another branch or
     * HEAD than the caller has just seen, they are read afresh.
     */
    const primedInputs = new Map<
      string,
      { readonly inputs: PrInputs | undefined; readonly at: number }
    >();

    const takePrimed = (cwd: string, checkout: PrimedCheckout | undefined) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const primed = primedInputs.get(cwd);
        primedInputs.delete(cwd);
        if (primed === undefined || checkout === undefined || now - primed.at >= ttlMs) return;
        const { inputs } = primed;
        // No inputs is a checkout off any branch, or one with no GitHub remote: only the first is
        // still provably so.
        const same =
          inputs === undefined
            ? checkout.branch === undefined
            : inputs.branch === checkout.branch && inputs.localTip === checkout.head;
        return same ? primed : undefined;
      });

    const readStatus: Pr["Service"]["status"] = (cwd, bound, checkout, options) =>
      Effect.gen(function* () {
        if (!(yield* tools.ghReady)) return undefined;
        if (bound !== undefined) {
          // Actions must not reuse a TTL answer or an in-flight/memoized older lookup.
          if (options?.fresh === true)
            return yield* provide(boundPrStatus(cwd, bound, makePrResolver(proc, reviewBots.get)));
          return yield* boundBadges.get({ cwd, bound });
        }
        const primed = yield* takePrimed(cwd, checkout);
        const inputs = primed === undefined ? yield* provide(resolvePrInputs(cwd)) : primed.inputs;
        if (inputs === undefined) return undefined;
        return yield* options?.fresh === true
          ? Effect.request(
              GetPrStatus({ lookup: { kind: "branch", inputs } }),
              makePrResolver(proc, reviewBots.get),
            )
          : branchBadges.get(inputs);
      });

    const status: Pr["Service"]["status"] = (cwd, bound, checkout, options) =>
      Effect.gen(function* () {
        const badge = yield* readStatus(
          cwd,
          bound,
          checkout,
          options?.forMerge === true ? { ...options, fresh: true } : options,
        );
        if (options?.forMerge !== true || badge === undefined || badge.state !== "OPEN")
          return badge;
        const locallyChecked =
          options.localCheckHead !== undefined && options.localCheckHead === badge.headRefOid;
        const repo = bound?.repo ?? repoFromPrUrl(badge.url);
        if (repo === undefined) {
          if (locallyChecked) return badge;
          return yield* new PrLookupError({ message: "Merge CI repository is unknown" });
        }
        // A merge goes by the base branch's tip: the REST fallback has none, so it asks for it, and
        // without it the read fails rather than pass off the PR's recorded base as the tip.
        const known =
          badge.baseTipOid !== undefined || badge.baseRef === undefined
            ? badge
            : { ...badge, baseTipOid: yield* provide(baseTip(cwd, repo, badge.baseRef)) };
        const mergeChecks = yield* provide(
          mergeCiForLaunch(cwd, repo, known, options.localCheckHead),
        ).pipe(Effect.mapError((e) => new PrLookupError({ message: e.message })));
        return mergeChecks === undefined ? known : { ...known, mergeChecks };
      });

    const detail = (cwd: string, number: number, explicitRepo?: string) =>
      provide(
        Effect.gen(function* () {
          if (!(yield* tools.ghReady)) return { available: false } satisfies PrDetailResponse;
          if (!Number.isSafeInteger(number) || number <= 0) {
            return { available: true, error: "invalid pr number" } satisfies PrDetailResponse;
          }
          if (explicitRepo !== undefined && !OWNER_REPO.test(explicitRepo)) {
            return { available: true, error: "invalid repo" } satisfies PrDetailResponse;
          }
          const workTree = yield* repoTop(cwd);
          const repo =
            explicitRepo ?? (workTree === undefined ? undefined : yield* resolveRepoNwo(workTree));
          if (workTree === undefined || repo === undefined)
            return { available: true } satisfies PrDetailResponse;
          const view = yield* attempt(
            gh(workTree, [
              "pr",
              "view",
              String(number),
              "--repo",
              repo,
              "--json",
              "number,state,url,headRefOid,title,body,isDraft,author,baseRefName,headRefName,additions,deletions,changedFiles,commits,reviews,reviewDecision,statusCheckRollup,comments,reviewRequests,latestReviews,labels",
            ]),
          );
          if (!view.ok || view.value.status !== 0) {
            const error = view.ok ? view.value.stderr.trim() : view.reason;
            return { available: true, error } satisfies PrDetailResponse;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(view.value.stdout.trim());
          } catch {
            parsed = {};
          }
          const diff = yield* gh(workTree, ["pr", "diff", String(number), "--repo", repo], {
            timeoutMs: 15_000,
          }).pipe(Effect.option);
          const { files, note } =
            Option.isSome(diff) && diff.value.status === 0
              ? parseGitDiffCapped(diff.value.stdout, diff.value.truncated)
              : { files: [], note: "Diff unavailable" };
          const fields = isJson(parsed) ? parsed : {};
          // `gh pr view` can't say which checks are required; the checks lookup the PR strip
          // already makes can, and is usually cached.
          const rollup = arr(fields["statusCheckRollup"]);
          // Stamped as the badge would be, so a list read on another head or rollup isn't reused.
          const head = optionalStr(fields, "headRefOid") ?? commitList(fields).at(-1)?.oid;
          const stamp = prChecksStamp({
            ...(head === undefined ? {} : { headRefOid: head }),
            checks: rollupStatus(rollup),
          });
          const runs =
            rollup.length === 0
              ? []
              : yield* prChecks
                  .get({ workTree, repo, number, stamp })
                  .pipe(Effect.orElseSucceed((): ReadonlyArray<PrCheck> => []));
          return {
            available: true,
            detail: buildPrDetail(
              { ...fields, statusCheckRollup: withRequired(rollup, runs) },
              files,
              note,
            ),
          } satisfies PrDetailResponse;
        }),
      );

    const checks: Pr["Service"]["checks"] = (cwd, number, explicitRepo, options) =>
      Effect.gen(function* () {
        if (!(yield* tools.ghReady)) {
          return yield* new PrLookupError({ message: "GitHub CLI not available or logged out" });
        }
        if (!Number.isSafeInteger(number) || number <= 0) {
          return yield* new PrLookupError({ message: "invalid pr number" });
        }
        const workTree =
          (yield* provide(tryRepoTop(cwd)).pipe(
            Effect.mapError((e) => new PrLookupError({ message: e.message })),
          )) ?? cwd;
        const repo =
          explicitRepo ??
          (yield* provide(resolveRepoNwo(workTree)).pipe(Effect.orElseSucceed(() => undefined)));
        if (repo === undefined || !OWNER_REPO.test(repo)) {
          return yield* new PrLookupError({ message: "no GitHub repo for this checkout" });
        }
        const input = { workTree, repo, number, stamp: options?.stamp };
        return yield* options?.fresh === true ? fetchPrChecks(input) : prChecks.get(input);
      });

    const prime: Pr["Service"]["prime"] = (lookups) =>
      Effect.gen(function* () {
        if (lookups.length === 0 || !(yield* tools.ghReady)) return;
        // Inputs first, requests after: the resolver batches what is asked in one scheduler turn,
        // and a request issued as each checkout's `git` runs finish is a turn of its own.
        const ready = yield* Effect.forEach(
          lookups,
          ({ cwd, bound }) =>
            bound !== undefined
              ? Effect.succeed(boundBadges.get({ cwd, bound }))
              : provide(resolvePrInputs(cwd)).pipe(
                  Effect.flatMap((inputs) =>
                    Effect.map(Clock.currentTimeMillis, (now) => {
                      primedInputs.set(cwd, { inputs, at: now });
                      return inputs === undefined ? undefined : branchBadges.get(inputs);
                    }),
                  ),
                  Effect.orElseSucceed(() => undefined),
                ),
          { concurrency: PRIME_INPUT_CONCURRENCY },
        );
        yield* Effect.forEach(
          ready.filter((get) => get !== undefined),
          (get) => Effect.ignore(get),
          { concurrency: "unbounded", discard: true },
        );
      });

    const seenChecks: Pr["Service"]["seenChecks"] = (repo, number) =>
      Effect.sync(() => seen.get(checksKey(repo, number)));

    return { status, detail, checks, seenChecks, prime };
  }),
);
