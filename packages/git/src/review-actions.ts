// Review-bot reads and writes over `gh api`, run in the thread's checkout so `gh` picks up its host
// and auth. Writes are the caller's explicit action: reply, resolve, re-review, or a local patch.

import * as fs from "node:fs";
import {
  repoFromPrUrl,
  type BoundPr,
  type PrReview,
  type PrStatus,
  type ReviewBot,
  type ReviewComment,
} from "@gram/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { openInside, realRoot, writeInside } from "./contained.ts";
import { gh, ghApi, git, gitFailMsg } from "./exec.ts";
import { invalidatePrBadges, makeTtlCache } from "./pr-cache.ts";
import type { Proc } from "./proc.ts";
import { detectRateLimit, type RateLimitSignal } from "./rate-limit.ts";
import {
  buildLatestReview,
  buildReviewState,
  buildReviewThreads,
  extractSuggestion,
} from "./review.ts";

type Json = Record<string, unknown>;

const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const at = (value: unknown, path: ReadonlyArray<string>): unknown => {
  let current = value;
  for (const key of path) current = isJson(current) ? current[key] : undefined;
  return current;
};

/**
 * A review read or write failed: gh missing, auth, network, or GitHub refused it.
 *
 * `rateLimit` is the shared classification of `message`, so callers schedule a backoff off the one
 * matcher in `rate-limit.ts` instead of grepping the text themselves.
 */
export class ReviewActionError extends Data.TaggedError("ReviewActionError")<{
  readonly message: string;
}> {
  get rateLimit(): RateLimitSignal | undefined {
    return detectRateLimit(this.message);
  }
}

// Moved to contracts, where the PR context the web app builds reads it too.
export { repoFromPrUrl } from "@gram/contracts";

/** The PR a thread acts on: its bound PR, else its branch's badge; `undefined` without either. */
export const prTargetOf = (
  boundPr: Pick<BoundPr, "repo" | "number"> | undefined,
  badge: Pick<PrStatus, "number" | "url"> | undefined,
): { readonly repo: string; readonly number: number } | undefined => {
  if (boundPr !== undefined) return { repo: boundPr.repo, number: boundPr.number };
  const repo = badge === undefined ? undefined : repoFromPrUrl(badge.url);
  return badge === undefined || repo === undefined ? undefined : { repo, number: badge.number };
};

const splitRepo = (repo: string) => {
  const slash = repo.indexOf("/");
  return slash > 0 ? { owner: repo.slice(0, slash), name: repo.slice(slash + 1) } : undefined;
};

/** Runs `gh api graphql` and returns `data`; GraphQL `errors` without data fail with their message. */
const graphql = (
  workTree: string,
  query: string,
  variables: ReadonlyArray<readonly [flag: "-f" | "-F", name: string, value: string]>,
): Effect.Effect<Json, ReviewActionError, Proc> =>
  Effect.gen(function* () {
    const args = ["graphql", "-f", `query=${query}`];
    for (const [flag, name, value] of variables) args.push(flag, `${name}=${value}`);
    const out = yield* ghApi(workTree, args, { timeoutMs: 20_000 }).pipe(
      Effect.mapError((e) => new ReviewActionError({ message: e.message })),
    );
    let body: unknown;
    try {
      body = JSON.parse(out.stdout.trim());
    } catch {
      return yield* new ReviewActionError({
        message: out.stderr.trim() || `gh exited with code ${out.status}`,
      });
    }
    const data = at(body, ["data"]);
    if (!isJson(data)) {
      const errors = at(body, ["errors"]);
      const first = Array.isArray(errors) && isJson(errors[0]) ? str(errors[0]["message"]) : "";
      return yield* new ReviewActionError({ message: first || "GitHub returned no data" });
    }
    return data;
  });

const PR_REVIEW_QUERY = `query($o:String!,$n:String!,$num:Int!){repository(owner:$o,name:$n){pullRequest(number:$num){
number url state viewerDidAuthor author{login} headRefOid reviewDecision mergeStateStatus
reviews(last:50){nodes{id author{login __typename} state submittedAt commit{oid} body}}
reviewThreads(first:100){nodes{id isResolved isOutdated path line startLine
comments(first:50){nodes{id author{login} body createdAt url}}}}
comments(last:30){nodes{id author{login} body createdAt}}}}}`;

interface PrReviewRequest {
  readonly workTree: string;
  readonly repo: string;
  readonly number: number;
  readonly bots: ReadonlyArray<ReviewBot>;
  /** The checkout's HEAD, so a commit is a new entry rather than a warm hit. */
  readonly head: string;
}

const reviewCache = makeTtlCache<PrReviewRequest, PrReview, ReviewActionError, Proc>({
  key: ({ repo, number, bots, head }) =>
    `${repo.toLowerCase()}#${number}@${head}|${bots.map((bot) => bot.loginPattern).join(",")}`,
  fetch: (request) => uncachedPrReview(request),
});

/**
 * Drops every cached review. Call after any write that changes what a read would return; the
 * replies, resolves and comments in this module already do.
 */
export const invalidatePrReviews = (): void => reviewCache.clear();

/** A reply, resolve or comment went through: the badge counts the same threads the review lists. */
const reviewWritten = (): void => {
  invalidatePrReviews();
  invalidatePrBadges();
};

/**
 * The full bot review picture for one PR.
 *
 * Answers are reused for `PR_POLL_TTL_MS` per PR and checkout HEAD, and concurrent callers share
 * one `gh` call: an agent asking for the review state and then its threads costs one fetch, not
 * two. Failures are never cached.
 */
export const fetchPrReview = (
  workTree: string,
  repo: string,
  number: number,
  bots: ReadonlyArray<ReviewBot>,
): Effect.Effect<PrReview, ReviewActionError, Proc> =>
  Effect.gen(function* () {
    if (splitRepo(repo) === undefined)
      return yield* new ReviewActionError({ message: `invalid repository ${repo}` });
    const head = yield* git(workTree, ["rev-parse", "HEAD"]).pipe(
      Effect.map((out) => (out.status === 0 ? out.stdout.trim() : "")),
      Effect.orElseSucceed(() => ""),
    );
    return yield* reviewCache.get({ workTree, repo, number, bots, head });
  });

const uncachedPrReview = ({
  workTree,
  repo,
  number,
  bots,
}: PrReviewRequest): Effect.Effect<PrReview, ReviewActionError, Proc> =>
  Effect.gen(function* () {
    const parts = splitRepo(repo);
    if (parts === undefined)
      return yield* new ReviewActionError({ message: `invalid repository ${repo}` });
    const data = yield* graphql(workTree, PR_REVIEW_QUERY, [
      ["-f", "o", parts.owner],
      ["-f", "n", parts.name],
      ["-F", "num", String(number)],
    ]);
    const node = at(data, ["repository", "pullRequest"]);
    if (!isJson(node)) return { available: true, threads: [] } satisfies PrReview;
    const state = buildReviewState(node, bots, str(at(node, ["author", "login"])));
    const latestReview = buildLatestReview(node, bots);
    return {
      available: true,
      pr: {
        number: typeof node["number"] === "number" ? node["number"] : number,
        url: str(node["url"]),
        headRefOid: str(node["headRefOid"]),
        reviewDecision: str(node["reviewDecision"]),
        mergeStateStatus: str(node["mergeStateStatus"]),
        ...(typeof node["state"] === "string" ? { state: node["state"] } : {}),
        ...(typeof node["viewerDidAuthor"] === "boolean"
          ? { viewerDidAuthor: node["viewerDidAuthor"] }
          : {}),
      },
      ...(state === undefined ? {} : { state }),
      ...(latestReview === undefined ? {} : { latestReview }),
      threads: buildReviewThreads(node, bots),
    } satisfies PrReview;
  });

/** Reruns a GitHub Actions run's failed jobs. */
export const rerunFailedJobs = (
  workTree: string,
  repo: string,
  runId: string,
): Effect.Effect<void, ReviewActionError, Proc> =>
  Effect.gen(function* () {
    const out = yield* gh(workTree, ["run", "rerun", runId, "--failed", "--repo", repo]).pipe(
      Effect.mapError((e) => new ReviewActionError({ message: e.message })),
    );
    if (out.status !== 0) {
      return yield* new ReviewActionError({ message: gitFailMsg(out, "gh run rerun failed") });
    }
    invalidatePrBadges();
  });

/**
 * Whether `head` contains `sha`, from the local object database: `undefined` when either commit
 * isn't known locally, so callers can't mistake a missing fetch for a force-push.
 */
export const containsCommit = (
  workTree: string,
  sha: string,
  head: string,
): Effect.Effect<boolean | undefined, never, Proc> =>
  git(workTree, ["merge-base", "--is-ancestor", sha, head]).pipe(
    Effect.map((out) => (out.status === 0 ? true : out.status === 1 ? false : undefined)),
    Effect.orElseSucceed(() => undefined),
  );

const REPLY_MUTATION = `mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){
comment{id author{login} body createdAt url}}}`;

export const replyToThread = (
  workTree: string,
  reviewThreadId: string,
  body: string,
): Effect.Effect<ReviewComment, ReviewActionError, Proc> =>
  Effect.gen(function* () {
    if (body.trim() === "") return yield* new ReviewActionError({ message: "the reply is empty" });
    const data = yield* graphql(workTree, REPLY_MUTATION, [
      ["-f", "t", reviewThreadId],
      ["-f", "b", body],
    ]);
    const comment = at(data, ["addPullRequestReviewThreadReply", "comment"]);
    if (!isJson(comment))
      return yield* new ReviewActionError({ message: "GitHub returned no comment" });
    const text = str(comment["body"]);
    const suggestion = extractSuggestion(text);
    reviewWritten();
    return {
      id: str(comment["id"]),
      author: str(at(comment, ["author", "login"])),
      body: text,
      createdAt: str(comment["createdAt"]),
      url: str(comment["url"]),
      ...(suggestion === undefined ? {} : { suggestion }),
    };
  });

const RESOLVE_MUTATION = `mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{id isResolved}}}`;

export const resolveThread = (
  workTree: string,
  reviewThreadId: string,
): Effect.Effect<void, ReviewActionError, Proc> =>
  graphql(workTree, RESOLVE_MUTATION, [["-f", "t", reviewThreadId]]).pipe(
    Effect.andThen(Effect.sync(reviewWritten)),
  );

/** Posts a plain PR conversation comment, e.g. the bot's re-review command. */
export const postPrComment = (
  workTree: string,
  repo: string,
  number: number,
  body: string,
): Effect.Effect<void, ReviewActionError, Proc> =>
  Effect.gen(function* () {
    if (splitRepo(repo) === undefined) {
      return yield* new ReviewActionError({ message: `invalid repository ${repo}` });
    }
    const out = yield* ghApi(
      workTree,
      [`repos/${repo}/issues/${number}/comments`, "-f", `body=${body}`],
      {
        timeoutMs: 20_000,
      },
    ).pipe(Effect.mapError((e) => new ReviewActionError({ message: e.message })));
    if (out.status !== 0) {
      return yield* new ReviewActionError({ message: out.stderr.trim() || "gh api failed" });
    }
    reviewWritten();
  });

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/** A suggestion that can't be applied: outdated, no block, or the file changed underneath it. */
export class SuggestionError extends Data.TaggedError("SuggestionError")<{
  readonly message: string;
}> {}

export interface SuggestionTarget {
  readonly path: string;
  readonly line: number | undefined;
  readonly startLine: number | undefined;
  readonly isOutdated: boolean;
}

/**
 * Replaces lines `startLine..line` (1-based, inclusive; `line` alone for one line) of the file with
 * the suggestion text, in the working tree only. The line ending style and a trailing newline are
 * preserved. The file is read and replaced on `contained.ts`'s terms: a regular file under the
 * checkout reached through no link, replaced only if it is still the file that was read.
 */
export const applySuggestion = (
  workTree: string,
  target: SuggestionTarget,
  suggestion: string,
): Effect.Effect<{ path: string; startLine: number; endLine: number }, SuggestionError> =>
  Effect.gen(function* () {
    if (target.isOutdated || target.line === undefined) {
      return yield* new SuggestionError({
        message: "This suggestion is on outdated code; apply it by hand.",
      });
    }
    const read = yield* Effect.try({
      try: () => {
        const root = realRoot(workTree);
        const fd = openInside(root, target.path);
        try {
          return {
            root,
            stat: fs.fstatSync(fd, { bigint: true }),
            text: fs.readFileSync(fd, "utf8"),
          };
        } finally {
          fs.closeSync(fd);
        }
      },
      catch: (error) =>
        new SuggestionError({
          message: isMissing(error)
            ? `Can't read ${target.path}`
            : `${target.path} is a link or outside the checkout`,
        }),
    });
    const { text } = read;
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const trailing = text.endsWith(eol);
    const lines = (trailing ? text.slice(0, -eol.length) : text).split(eol);
    const endLine = target.line;
    const startLine = target.startLine ?? endLine;
    if (startLine < 1 || startLine > endLine || endLine > lines.length) {
      return yield* new SuggestionError({
        message: `${target.path} no longer has lines ${startLine}–${endLine}`,
      });
    }
    const replacement = suggestion === "" ? [] : suggestion.split(/\r?\n/);
    lines.splice(startLine - 1, endLine - startLine + 1, ...replacement);
    const next = lines.join(eol) + (trailing ? eol : "");
    yield* Effect.try({
      try: () =>
        writeInside(read.root, target.path, (fd) => fs.writeFileSync(fd, next), {
          mode: Number(read.stat.mode) & 0o777,
          replacing: read.stat,
        }),
      catch: () => new SuggestionError({ message: `Can't write ${target.path}` }),
    });
    return { path: target.path, startLine, endLine };
  });
