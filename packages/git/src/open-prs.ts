// A repo's open PRs by head branch, in one request. The badge lookup answers "which PR is this
// branch's" with review and CI state, at some five GraphQL points a branch; a caller that only needs
// to know whether a branch has an open PR at all asks here instead, at one point for the whole repo.

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { ghApi } from "./exec.ts";
import type { Proc } from "./proc.ts";
import { detectRateLimit, type RateLimitSignal } from "./rate-limit.ts";

export interface OpenPr {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  /** The head branch, in the repo itself: a fork's PR is left out. */
  readonly branch: string;
}

/**
 * One page, most recently updated first. A repo with more open PRs than this loses the oldest from
 * the list, which costs a cue and never a badge.
 */
export const OPEN_PRS_LIMIT = 100;

export const OPEN_PRS_QUERY =
  "query($o:String!,$n:String!){repository(owner:$o,name:$n){pullRequests(states:OPEN," +
  `first:${OPEN_PRS_LIMIT},orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url ` +
  "headRefName isCrossRepository}}}}";

export class OpenPrsError extends Data.TaggedError("OpenPrsError")<{
  readonly message: string;
}> {
  get rateLimit(): RateLimitSignal | undefined {
    return detectRateLimit(this.message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The open PRs in a response body. `undefined` when the body carries no PR list, so a refused or
 * errored document reads as "unknown" rather than as "no open PRs".
 */
export const parseOpenPrs = (body: unknown): ReadonlyArray<OpenPr> | undefined => {
  const data = isRecord(body) ? body["data"] : undefined;
  const repository = isRecord(data) ? data["repository"] : undefined;
  const pullRequests = isRecord(repository) ? repository["pullRequests"] : undefined;
  const nodes = isRecord(pullRequests) ? pullRequests["nodes"] : undefined;
  if (!Array.isArray(nodes)) return undefined;
  return nodes.flatMap((node): ReadonlyArray<OpenPr> => {
    if (!isRecord(node) || node["isCrossRepository"] === true) return [];
    const { number, title, url, headRefName } = node;
    if (typeof number !== "number" || typeof url !== "string" || typeof headRefName !== "string") {
      return [];
    }
    return [{ number, title: typeof title === "string" ? title : "", url, branch: headRefName }];
  });
};

/** `repo`'s open PRs, asked from `cwd` so `gh` picks up that checkout's host and auth. */
export const fetchOpenPrs = (
  cwd: string,
  repo: string,
): Effect.Effect<ReadonlyArray<OpenPr>, OpenPrsError, Proc> =>
  Effect.gen(function* () {
    const slash = repo.indexOf("/");
    if (slash <= 0) return yield* new OpenPrsError({ message: `not an owner/repo: ${repo}` });
    const out = yield* ghApi(cwd, [
      "graphql",
      "-f",
      `query=${OPEN_PRS_QUERY}`,
      "-f",
      `o=${repo.slice(0, slash)}`,
      "-f",
      `n=${repo.slice(slash + 1)}`,
    ]).pipe(Effect.mapError((e) => new OpenPrsError({ message: e.message })));
    let body: unknown;
    try {
      body = JSON.parse(out.stdout.trim());
    } catch {
      body = undefined;
    }
    const prs = parseOpenPrs(body);
    if (prs !== undefined) return prs;
    return yield* new OpenPrsError({
      message: out.stderr.trim() || `gh api graphql exited with code ${out.status} and no PR list`,
    });
  });
