// The pull requests whose review is requested from the signed-in `gh` user, and the open ones they
// authored. Read-only: nothing here writes to GitHub.

import * as os from "node:os";
import type { ChecksRollup, ReviewBot, ReviewRequestBot } from "@gram/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { gh, ghApi, gitFailMsg } from "./exec.ts";
import type { Proc } from "./proc.ts";
import { buildLatestReview } from "./review.ts";

export interface SearchedReviewRequest {
  /** `owner/name`. */
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: string;
  /** The author is a GitHub App rather than a person. */
  readonly isBot: boolean;
  /** False when the payload doesn't say, as the review-request search, which leaves drafts out. */
  readonly isDraft: boolean;
  readonly updatedAt: string;
  /** Empty when the payload carries none. */
  readonly createdAt: string;
}

/** The `updated:>=` boundary for a max-age cutoff, as GitHub's `YYYY-MM-DD`; `now` is epoch ms. */
export const updatedSinceDate = (maxAgeDays: number, now: number): string =>
  // oxlint-disable-next-line gram/no-day-math -- a UTC date, and a UTC day is always 24 hours
  new Date(now - maxAgeDays * 86_400_000).toISOString().slice(0, 10);

/** The search failed: signed out, rate limited, network, or unexpected output. */
export class ReviewRequestsError extends Data.TaggedError("ReviewRequestsError")<{
  readonly message: string;
}> {}

/** What the search asks GitHub for. */
export interface ReviewRequestsSearch {
  readonly directOnly: boolean;
  /** `YYYY-MM-DD` from `updatedSinceDate`; absent lists a PR however long it has sat. */
  readonly updatedSince?: string | undefined;
}

/**
 * `gh search prs` arguments. `directOnly` asks for the PRs naming the user as a reviewer, through
 * GitHub's `user-review-requested:` qualifier, which `gh`'s `--review-requested` flag widens to the
 * user's teams. `updatedSince` drops PRs untouched since that date. Drafts and the user's own PRs
 * are always left out.
 *
 * The age cutoff belongs in the query rather than in `parseReviewRequests` because `--limit 100`
 * truncates the result before anything here could filter it.
 *
 * Each qualifier is its own positional argument after `--`. The separator is required because `gh`
 * reads a leading `-` as a shorthand flag and rejects `-author:@me`; one argument per qualifier is
 * required because `gh` quotes a positional containing a space as a single term's value, which
 * turns a combined string into the malformed `user-review-requested:"@me -author:@me"`.
 */
export const reviewRequestsSearchArgs = (options: ReviewRequestsSearch): ReadonlyArray<string> => [
  "search",
  "prs",
  ...(options.directOnly ? [] : ["--review-requested=@me"]),
  "--state=open",
  "--draft=false",
  "--json",
  "number,title,url,repository,author,updatedAt,createdAt",
  "--limit",
  "100",
  "--",
  ...(options.directOnly ? ["user-review-requested:@me"] : []),
  "-author:@me",
  ...(options.updatedSince === undefined ? [] : [`updated:>=${options.updatedSince}`]),
];

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Whether the search payload's author is a GitHub App. GitHub has no `is:bot` search qualifier, so
 * this is the only place bots can be told apart: `is_bot` when the payload carries it, and the
 * `…[bot]` login suffix an app author always has.
 */
const botAuthor = (author: Record<string, unknown> | undefined): boolean =>
  author?.["is_bot"] === true || text(author?.["login"]).endsWith("[bot]");

/**
 * `gh search prs` arguments for the user's own open PRs, drafts included. No age cutoff: a PR of
 * yours stays yours to finish or close however long it has sat. A user with more than `--limit`
 * open PRs sees the most recently updated, which is the order the list shows them in anyway.
 */
export const ownPrsSearchArgs = (): ReadonlyArray<string> => [
  "search",
  "prs",
  "--author=@me",
  "--state=open",
  "--json",
  "number,title,url,repository,author,updatedAt,createdAt,isDraft",
  "--sort=updated",
  "--limit",
  "100",
];

/** `gh search prs --json …` output as review requests; `undefined` when it isn't a JSON array. */
export const parseReviewRequests = (
  stdout: string,
): ReadonlyArray<SearchedReviewRequest> | undefined => {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(body)) return undefined;
  return body.flatMap((entry): Array<SearchedReviewRequest> => {
    const pr = record(entry);
    const repo = text(record(pr?.["repository"])?.["nameWithOwner"]);
    const number = pr?.["number"];
    if (
      pr === undefined ||
      repo === "" ||
      typeof number !== "number" ||
      !Number.isInteger(number)
    ) {
      return [];
    }
    const author = record(pr["author"]);
    return [
      {
        repo,
        number,
        title: text(pr["title"]),
        url: text(pr["url"]),
        author: text(author?.["login"]),
        isBot: botAuthor(author),
        isDraft: pr["isDraft"] === true,
        updatedAt: text(pr["updatedAt"]),
        createdAt: text(pr["createdAt"]),
      },
    ];
  });
};

/** `gh search prs` with `args`, in the home folder so no repository's own `gh` config applies. */
const searchPrs = (
  args: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<SearchedReviewRequest>, ReviewRequestsError, Proc> =>
  Effect.gen(function* () {
    const out = yield* gh(os.homedir(), args).pipe(
      Effect.mapError((error) => new ReviewRequestsError({ message: error.message })),
    );
    if (out.status !== 0) {
      return yield* new ReviewRequestsError({ message: gitFailMsg(out, "gh search prs failed") });
    }
    const parsed = parseReviewRequests(out.stdout);
    if (parsed === undefined) {
      return yield* new ReviewRequestsError({
        message: "gh search prs returned unexpected output",
      });
    }
    return parsed;
  });

/** Every open PR requesting the user's review. */
export const searchReviewRequests = (
  options: ReviewRequestsSearch,
): Effect.Effect<ReadonlyArray<SearchedReviewRequest>, ReviewRequestsError, Proc> =>
  searchPrs(reviewRequestsSearchArgs(options));

/** Every open PR the user authored, drafts included. */
export const searchOwnPrs: Effect.Effect<
  ReadonlyArray<SearchedReviewRequest>,
  ReviewRequestsError,
  Proc
> = Effect.suspend(() => searchPrs(ownPrsSearchArgs()));

/**
 * What the search can't say about a PR: its checks, review decision and review-bot verdict, and for
 * the user's own PRs its head branch and merge state.
 */
export interface ReviewRequestDetails {
  readonly labelsCount?: number | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
  /** Internal cache carry marker, never set by a fresh parser result. */
  readonly stale?: boolean | undefined;
  readonly checks: ChecksRollup;
  readonly reviewDecision?: string | undefined;
  readonly bot?: ReviewRequestBot | undefined;
  /** `headRefName`. */
  readonly headRef?: string | undefined;
  /** GitHub's `mergeStateStatus`, such as CLEAN, BLOCKED, BEHIND or DIRTY. */
  readonly mergeState?: string | undefined;
  /**
   * `updatedAt` as this lookup read it, beside the checks it read: the search's own can lag GitHub
   * by its index, so only this one says what the rest of these details have seen.
   */
  readonly updatedAt?: string | undefined;
  /** `isDraft` as this lookup read it, for the same reason. */
  readonly isDraft?: boolean | undefined;
  /** `headRefOid`: the commit `bot.onHead` speaks of. */
  readonly headOid?: string | undefined;
}

/**
 * PRs per details document. Each carries up to twenty review bodies, and a bot's summary runs to a
 * KiB or two, so a fuller document could pass `runCommand`'s 2 MiB output cap and parse as nothing.
 */
export const REVIEW_REQUEST_DETAILS_PER_QUERY = 20;

// `statusCheckRollup.state` rather than its contexts: the row shows one mark, and GitHub's own
// rollup is a single field where the contexts are up to a hundred nodes per PR. The scalars cost
// nothing in GraphQL points, so review requests carry the two only own PRs show.
const DETAILS_GQL_FIELDS =
  "labels(first:100){nodes{name} totalCount} additions deletions headRefOid headRefName mergeStateStatus updatedAt isDraft reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state}}}} " +
  "reviews(last:20){nodes{id author{login} state submittedAt commit{oid} body}}";

/** One aliased `pullRequest` block per PR, named by typed variables so nothing is interpolated. */
export const reviewRequestDetailsQuery = (count: number): string => {
  const indices = Array.from({ length: count }, (_, i) => i);
  const vars = indices.map((i) => `$o${i}:String!,$n${i}:String!,$p${i}:Int!`);
  const blocks = indices.map(
    (i) =>
      `e${i}:repository(owner:$o${i},name:$n${i}){pullRequest(number:$p${i}){${DETAILS_GQL_FIELDS}}}`,
  );
  return `query(${vars.join(",")}){${blocks.join("")}}`;
};

const rollupState = (state: unknown): ChecksRollup | undefined => {
  switch (state) {
    case "SUCCESS":
      return "passing";
    case "FAILURE":
    case "ERROR":
      return "failing";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    case null:
      return "none";
    default:
      return undefined;
  }
};

const lineCount = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * A details document's `pullRequest` node. `undefined` when GitHub returned none for the alias, or
 * one missing a connection the query asked for: an errored field comes back `null`, and reading
 * that as "no checks, no bot review" would replace marks the caller still holds. A null
 * `statusCheckRollup` or `reviewDecision` is an answer, not a gap: the PR has no checks, or no
 * decision.
 */
export const parseReviewRequestDetails = (
  node: unknown,
  bots: ReadonlyArray<ReviewBot>,
): ReviewRequestDetails | undefined => {
  const pr = record(node);
  if (pr === undefined || text(pr["headRefOid"]) === "") return undefined;
  const commits = record(pr["commits"])?.["nodes"];
  const commit = record(record(Array.isArray(commits) ? commits[0] : undefined)?.["commit"]);
  if (commit === undefined || !Array.isArray(record(pr["reviews"])?.["nodes"])) return undefined;
  const rollup = commit["statusCheckRollup"];
  const checks = rollupState(rollup === null ? null : record(rollup)?.["state"]);
  if (checks === undefined) return undefined;
  const reviewDecision = text(pr["reviewDecision"]);
  const headRef = text(pr["headRefName"]);
  const mergeState = text(pr["mergeStateStatus"]);
  const updatedAt = text(pr["updatedAt"]);
  const latest = buildLatestReview(pr, bots);
  const labelNodes = record(pr["labels"])?.["nodes"];
  const labels = Array.isArray(labelNodes)
    ? labelNodes.flatMap((label) =>
        typeof record(label)?.["name"] === "string" ? [text(record(label)?.["name"])] : [],
      )
    : undefined;
  const labelsCount = lineCount(record(pr["labels"])?.["totalCount"]);
  const additions = lineCount(pr["additions"]);
  const deletions = lineCount(pr["deletions"]);
  return {
    ...(labels === undefined ? {} : { labels }),
    ...(labelsCount === undefined ? {} : { labelsCount }),
    ...(additions === undefined ? {} : { additions }),
    ...(deletions === undefined ? {} : { deletions }),
    checks,
    ...(reviewDecision === "" ? {} : { reviewDecision }),
    ...(latest === undefined ? {} : { bot: { verdict: latest.verdict, onHead: latest.onHead } }),
    ...(headRef === "" ? {} : { headRef }),
    ...(mergeState === "" ? {} : { mergeState }),
    ...(updatedAt === "" ? {} : { updatedAt }),
    ...(typeof pr["isDraft"] === "boolean" ? { isDraft: pr["isDraft"] } : {}),
    headOid: text(pr["headRefOid"]),
  };
};

/**
 * The details in a document's response body, by alias index. `gh api graphql` exits non-zero
 * whenever `errors` is present yet still prints partial `data`, so the exit code says nothing here:
 * an alias counts only when no error's `path` names it and its node is complete.
 */
export const parseReviewRequestDetailsBody = (
  body: unknown,
  count: number,
  bots: ReadonlyArray<ReviewBot>,
): ReadonlyMap<number, ReviewRequestDetails> => {
  const details = new Map<number, ReviewRequestDetails>();
  const data = record(record(body)?.["data"]);
  if (data === undefined) return details;
  const errors = record(body)?.["errors"];
  const errored = new Set(
    (Array.isArray(errors) ? errors : []).flatMap((error) => {
      const path = record(error)?.["path"];
      return Array.isArray(path) && typeof path[0] === "string" ? [path[0]] : [];
    }),
  );
  for (let i = 0; i < count; i++) {
    if (errored.has(`e${i}`)) continue;
    const parsed = parseReviewRequestDetails(record(data[`e${i}`])?.["pullRequest"], bots);
    if (parsed !== undefined) details.set(i, parsed);
  }
  return details;
};

/** `repo#number` in lower case, the key `fetchReviewRequestDetails` answers by. */
export const reviewRequestKey = (pr: { readonly repo: string; readonly number: number }) =>
  `${pr.repo.toLowerCase()}#${pr.number}`;

/**
 * Details for `prs`, by `reviewRequestKey`, from one `gh api graphql` document per
 * `REVIEW_REQUEST_DETAILS_PER_QUERY`. Best effort: a PR GitHub wouldn't answer for (no access, a
 * refused, truncated or partly errored document) is simply missing, since the list is worth showing
 * without it and the caller may still hold what it last knew.
 */
export const fetchReviewRequestDetails = (
  prs: ReadonlyArray<{ readonly repo: string; readonly number: number }>,
  bots: ReadonlyArray<ReviewBot>,
): Effect.Effect<ReadonlyMap<string, ReviewRequestDetails>, never, Proc> =>
  Effect.gen(function* () {
    const details = new Map<string, ReviewRequestDetails>();
    const named = prs.filter((pr) => pr.repo.indexOf("/") > 0);
    for (let start = 0; start < named.length; start += REVIEW_REQUEST_DETAILS_PER_QUERY) {
      const chunk = named.slice(start, start + REVIEW_REQUEST_DETAILS_PER_QUERY);
      const args = ["graphql", "-f", `query=${reviewRequestDetailsQuery(chunk.length)}`];
      for (const [i, pr] of chunk.entries()) {
        const slash = pr.repo.indexOf("/");
        args.push(
          "-f",
          `o${i}=${pr.repo.slice(0, slash)}`,
          "-f",
          `n${i}=${pr.repo.slice(slash + 1)}`,
        );
        args.push("-F", `p${i}=${pr.number}`);
      }
      const out = yield* ghApi(os.homedir(), args).pipe(Effect.option);
      if (out._tag === "None") continue;
      let body: unknown;
      try {
        body = JSON.parse(out.value.stdout.trim());
      } catch {
        continue;
      }
      for (const [i, parsed] of parseReviewRequestDetailsBody(body, chunk.length, bots)) {
        details.set(reviewRequestKey(chunk[i]!), parsed);
      }
    }
    return details;
  });
