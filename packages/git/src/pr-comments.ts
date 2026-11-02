// People's comments on a PR, over `gh`: what a comment the badge listed by id says, and whether its
// author may write to the repository. Reads only, run in the thread's checkout so `gh` picks up its
// host and the user's own login; no token of Gram's own.

import * as Effect from "effect/Effect";
import { ghApi } from "./exec.ts";
import { makeTtlCache } from "./pr-cache.ts";
import type { Proc } from "./proc.ts";
import { ReviewActionError } from "./review-actions.ts";

type Json = Record<string, unknown>;

const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const arr = (value: unknown): Array<Json> => (Array.isArray(value) ? value.filter(isJson) : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const at = (value: unknown, path: ReadonlyArray<string>): unknown => {
  let current = value;
  for (const key of path) current = isJson(current) ? current[key] : undefined;
  return current;
};

/** The most comments one lookup reads: as many as a badge lists. */
export const PERSON_COMMENTS_PER_LOOKUP = 30;
/** The most inline comments read of one review. */
const INLINE_PER_REVIEW = 20;

/** One inline comment of a comment-only review. */
export interface InlineComment {
  readonly id: string;
  readonly path: string;
  readonly line?: number | undefined;
  readonly body: string;
  readonly url: string;
}

/** A person's issue comment or comment-only review, as GitHub has it now. */
export interface FetchedComment {
  readonly id: string;
  readonly kind: "comment" | "review";
  readonly author: string;
  /** The author is a GitHub App or other bot account (`__typename` Bot). */
  readonly authorIsBot: boolean;
  /** Posted with the login `gh` is signed in as: the user's, which the user's agents post with too. */
  readonly viewerDidAuthor: boolean;
  /** A review's state, e.g. COMMENTED; absent for an issue comment. */
  readonly state?: string | undefined;
  readonly body: string;
  readonly url: string;
  readonly createdAt: string;
  /** A review's inline comments; empty for an issue comment. */
  readonly inline: ReadonlyArray<InlineComment>;
}

const AUTHOR = "author{login __typename}";
const NODE_FIELDS =
  `__typename ... on IssueComment{id body url createdAt viewerDidAuthor ${AUTHOR}} ` +
  `... on PullRequestReview{id state body url createdAt viewerDidAuthor ${AUTHOR} ` +
  `comments(first:${INLINE_PER_REVIEW}){nodes{id body path line originalLine url}}}`;

/**
 * One document for `count` nodes by id: positional aliases and typed variables, so no id is ever
 * interpolated into the query.
 */
export const personCommentsQuery = (count: number): string => {
  const vars = Array.from({ length: count }, (_, i) => `$i${i}:ID!`);
  const body = Array.from({ length: count }, (_, i) => `c${i}:node(id:$i${i}){${NODE_FIELDS}}`);
  return `query(${vars.join(",")}){${body.join(" ")}}`;
};

const positiveInt = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

/** A node the query answered, or `undefined` for one that is gone or of another type. */
export const parseFetchedComment = (node: unknown): FetchedComment | undefined => {
  if (!isJson(node)) return undefined;
  const type = node["__typename"];
  if (type !== "IssueComment" && type !== "PullRequestReview") return undefined;
  const id = str(node["id"]);
  if (id === "") return undefined;
  return {
    id,
    kind: type === "IssueComment" ? "comment" : "review",
    author: str(at(node, ["author", "login"])),
    authorIsBot: at(node, ["author", "__typename"]) === "Bot",
    viewerDidAuthor: node["viewerDidAuthor"] === true,
    ...(type === "PullRequestReview" ? { state: str(node["state"]) } : {}),
    body: str(node["body"]),
    url: str(node["url"]),
    createdAt: str(node["createdAt"]),
    inline: arr(at(node, ["comments", "nodes"])).map((c) => {
      const line = positiveInt(c["line"]) ?? positiveInt(c["originalLine"]);
      return {
        id: str(c["id"]),
        path: str(c["path"]),
        ...(line === undefined ? {} : { line }),
        body: str(c["body"]),
        url: str(c["url"]),
      };
    }),
  };
};

const NODE_ID = /^[A-Za-z0-9_=-]+$/;

/**
 * What the comments named by `ids` say now, in one `gh api graphql` call. One that was deleted is
 * simply missing from the answer.
 */
export const fetchPersonComments = (
  workTree: string,
  ids: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<FetchedComment>, ReviewActionError, Proc> =>
  Effect.gen(function* () {
    const wanted = [...new Set(ids)].filter((id) => NODE_ID.test(id));
    if (wanted.length === 0) return [];
    if (wanted.length > PERSON_COMMENTS_PER_LOOKUP)
      return yield* new ReviewActionError({
        message: `at most ${PERSON_COMMENTS_PER_LOOKUP} comments are read at once`,
      });
    const args = ["graphql", "-f", `query=${personCommentsQuery(wanted.length)}`];
    wanted.forEach((id, i) => args.push("-f", `i${i}=${id}`));
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
    // A node id GitHub can't resolve is an error beside partial data, which still answers the rest.
    if (!isJson(data)) {
      const errors = at(body, ["errors"]);
      const first = Array.isArray(errors) && isJson(errors[0]) ? str(errors[0]["message"]) : "";
      return yield* new ReviewActionError({ message: first || "GitHub returned no data" });
    }
    return wanted.flatMap((_, i) => parseFetchedComment(data[`c${i}`]) ?? []);
  });

/** A collaborator's legacy base role on a repository, as GitHub's permission endpoint names it. */
export type RepoPermission = "admin" | "write" | "read" | "none";

/** Whether `permission` lets its holder push: the repository's owner and admins, and writers. */
export const canWrite = (permission: RepoPermission): boolean =>
  permission === "admin" || permission === "write";

/** How long a permission answer is reused: a removed collaborator is trusted at most this long. */
export const PERMISSION_TTL_MS = 10 * 60_000;

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const parsePermission = (text: string): RepoPermission | undefined => {
  const value = text.trim();
  return value === "admin" || value === "write" || value === "read" || value === "none"
    ? value
    : undefined;
};

const uncachedPermission = ({
  workTree,
  repo,
  login,
}: {
  readonly workTree: string;
  readonly repo: string;
  readonly login: string;
}): Effect.Effect<RepoPermission, ReviewActionError, Proc> =>
  Effect.gen(function* () {
    // Nothing else is ever a login: a name outside GitHub's alphabet has no permission to ask about.
    if (!OWNER_REPO.test(repo) || !LOGIN.test(login)) return "none";
    const out = yield* ghApi(
      workTree,
      [`repos/${repo}/collaborators/${login}/permission`, "--jq", ".permission"],
      { timeoutMs: 15_000 },
    ).pipe(Effect.mapError((e) => new ReviewActionError({ message: e.message })));
    if (out.status === 0) {
      const permission = parsePermission(out.stdout);
      if (permission !== undefined) return permission;
      return yield* new ReviewActionError({ message: "GitHub named no permission" });
    }
    // Not a user GitHub knows: no permission at all. Anything else is unknown, and fails.
    if (/HTTP 404/.test(out.stderr)) return "none";
    return yield* new ReviewActionError({
      message: out.stderr.trim() || `gh exited with code ${out.status}`,
    });
  });

const permissionCache = makeTtlCache({
  key: ({ repo, login }: { readonly repo: string; readonly login: string }) =>
    `${repo.toLowerCase()}|${login.toLowerCase()}`,
  fetch: uncachedPermission,
  ttlMs: PERMISSION_TTL_MS,
});

/**
 * `login`'s permission on `repo`, from `gh api repos/{repo}/collaborators/{login}/permission`.
 * Answers are kept for `PERMISSION_TTL_MS`; a failure is never kept, so it is asked again.
 */
export const collaboratorPermission = (
  workTree: string,
  repo: string,
  login: string,
): Effect.Effect<RepoPermission, ReviewActionError, Proc> =>
  permissionCache.get({ workTree, repo, login });

/** Drops every kept permission answer; for tests. */
export const clearPermissionCache = (): void => permissionCache.clear();
