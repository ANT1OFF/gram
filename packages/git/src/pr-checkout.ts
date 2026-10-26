// Checking a pull request out locally: the branch it lands on, and fetching its head from GitHub,
// a fork's head included, through `refs/pull/<n>/head`.

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { branchExists, gh, git, gitFailMsg } from "./exec.ts";
import { parseOwnerRepo } from "./pr.ts";
import type { Proc } from "./proc.ts";
import { repoFromPrUrl } from "./review-actions.ts";
import { isValidGitRefCharset } from "./worktrees.ts";

/** `gh` couldn't describe the PR, or git couldn't fetch its head. */
export class PrCheckoutError extends Data.TaggedError("PrCheckoutError")<{
  readonly message: string;
}> {}

const fail = (message: string) => new PrCheckoutError({ message });

export interface PrHead {
  /** `owner/name` of the PR's (base) repository. */
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly headRefName: string;
  /** State and head read in the same request as the branch, for merge delegation. */
  readonly state?: string;
  readonly headRefOid?: string;
  /** The head branch lives in another repository. */
  readonly fork: boolean;
}

/**
 * The local branch a PR checks out to: a same-repo PR keeps its head's name; a fork's head becomes
 * `pr-<n>-<head>` so it can't take over a local branch of the same name. `pr-<n>` when the head's
 * name can't enter git argv.
 */
export const localPrBranch = (head: Pick<PrHead, "number" | "headRefName" | "fork">): string => {
  const name = head.fork ? `pr-${head.number}-${head.headRefName}` : head.headRefName;
  const safe =
    isValidGitRefCharset(name) &&
    !name.includes("..") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock");
  return safe ? name : `pr-${head.number}`;
};

/** The PR as `gh pr view` describes it; `repo` absent means the checkout's own repository. */
export const prHead = (
  workTree: string,
  number: number,
  repo: string | undefined,
): Effect.Effect<PrHead, PrCheckoutError, Proc> =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(number) || number <= 0) {
      return yield* fail(`invalid pull request number ${number}`);
    }
    if (repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      return yield* fail(`invalid repository ${repo}`);
    }
    const out = yield* gh(
      workTree,
      [
        "pr",
        "view",
        String(number),
        ...(repo === undefined ? [] : ["--repo", repo]),
        "--json",
        "number,url,title,headRefName,isCrossRepository,state,headRefOid",
      ],
      { timeoutMs: 15_000 },
    ).pipe(Effect.mapError((e) => fail(e.message)));
    if (out.status !== 0) return yield* fail(gitFailMsg(out, "gh pr view failed"));
    let view: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(out.stdout);
      if (typeof parsed === "object" && parsed !== null) view = parsed as Record<string, unknown>;
    } catch {
      view = {};
    }
    const text = (key: string) => (typeof view[key] === "string" ? (view[key] as string) : "");
    const nwo = repoFromPrUrl(text("url"));
    if (nwo === undefined || text("headRefName") === "") {
      return yield* fail(`gh didn't describe pull request #${number}`);
    }
    return {
      repo: nwo,
      number,
      url: text("url"),
      title: text("title"),
      headRefName: text("headRefName"),
      ...(text("state") === "" ? {} : { state: text("state") }),
      ...(text("headRefOid") === "" ? {} : { headRefOid: text("headRefOid") }),
      fork: view["isCrossRepository"] === true,
    };
  });

/** The remote whose URL is `repo`, when the checkout has one. */
const remoteFor = (repoTop: string, repo: string) =>
  git(repoTop, ["config", "--get-regexp", "^remote\\..*\\.url$"]).pipe(
    Effect.map((out) =>
      out.status !== 0
        ? undefined
        : out.stdout.split("\n").flatMap((line) => {
            const [key = "", url = ""] = line.trim().split(/\s+/);
            const name = /^remote\.(.+)\.url$/.exec(key)?.[1];
            return name !== undefined && parseOwnerRepo(url)?.toLowerCase() === repo.toLowerCase()
              ? [name]
              : [];
          })[0],
    ),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * Makes the PR's head a local branch and returns its name. An existing local branch is used as it
 * is, never moved. A same-repo head tracks `<remote>/<head>`; a fork's head, or a repository with no
 * matching remote, is fetched from `refs/pull/<n>/head`.
 */
export const fetchPrHead = (
  repoTop: string,
  head: PrHead,
): Effect.Effect<string, PrCheckoutError, Proc> =>
  Effect.gen(function* () {
    const branch = localPrBranch(head);
    if (yield* branchExists(repoTop, `refs/heads/${branch}`)) return branch;
    const run = (args: ReadonlyArray<string>, network: boolean) =>
      git(repoTop, args, network ? { tier: "network" } : {}).pipe(
        Effect.mapError((e) => fail(e.message)),
        Effect.flatMap((out) =>
          out.status === 0
            ? Effect.void
            : Effect.fail(fail(gitFailMsg(out, `git ${args[0]} failed`))),
        ),
      );
    const remote = yield* remoteFor(repoTop, head.repo);
    if (!head.fork && remote !== undefined && branch === head.headRefName) {
      const tracking = `refs/remotes/${remote}/${head.headRefName}`;
      yield* run(["fetch", "--quiet", remote, `+refs/heads/${head.headRefName}:${tracking}`], true);
      yield* run(["branch", "--track", branch, `${remote}/${head.headRefName}`], false);
      return branch;
    }
    const source = remote ?? head.url.replace(/\/pull\/\d+.*$/, ".git");
    // A ref of its own rather than the shared `FETCH_HEAD`, which a sibling worktree's background
    // fetch can overwrite between the fetch and the branch.
    const ref = `refs/gram/pr-checkout/pr-${head.number}-${process.pid}-${Date.now()}`;
    yield* Effect.gen(function* () {
      yield* run(["fetch", "--quiet", source, `+refs/pull/${head.number}/head:${ref}`], true);
      const resolved = yield* git(repoTop, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${ref}^{commit}`,
      ]).pipe(Effect.mapError((e) => fail(e.message)));
      const oid = resolved.stdout.trim();
      if (resolved.status !== 0 || oid === "") {
        return yield* Effect.fail(fail(`couldn't read the fetched head of PR #${head.number}`));
      }
      if (head.headRefOid !== undefined && head.headRefOid !== "" && oid !== head.headRefOid) {
        return yield* Effect.fail(
          fail(`PR #${head.number}'s head moved while it was fetched; try again`),
        );
      }
      yield* run(["branch", branch, oid], false);
    }).pipe(Effect.ensuring(Effect.ignore(git(repoTop, ["update-ref", "-d", ref]))));
    return branch;
  });
