// For a checkout whose branch has no PR: an open PR on another worktree of the same repo, so the badge
// area can point at it. One worktree list per repo per sweep. A worktree a thread tracks answers from
// the state the publisher already holds; the rest are matched by branch against the repo's open PRs,
// one cached list however many worktrees there are. A badge lookup per untracked worktree cost some
// five GraphQL points each, every sweep, and a repo with a dozen idle worktrees spent the hour's
// allowance on this cue alone.

import {
  effectiveCheckout,
  type GitState,
  type PrElsewhere,
  type PrStatus,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import { cachedRepoRoots, type Proc, repoFromPrUrl, samePathKey, Worktrees } from "@gram/git";
import * as Effect from "effect/Effect";
import { OpenPrs } from "../github/open-prs.ts";

export interface WorktreePr {
  readonly worktreePath: string;
  readonly branch: string;
  /** As much of the PR as the cue shows, so a row of the open-PR list serves as well as a badge. */
  readonly pr: Pick<PrStatus, "number" | "state" | "title" | "url"> | undefined;
  readonly threadId?: ThreadId;
}

/** The newest open PR on a worktree other than `ownKey`'s. */
export const pickPrElsewhere = (
  ownKey: string,
  candidates: ReadonlyArray<WorktreePr>,
): PrElsewhere | undefined => {
  let best: (WorktreePr & { readonly pr: NonNullable<WorktreePr["pr"]> }) | undefined;
  for (const candidate of candidates) {
    const pr = candidate.pr;
    if (pr === undefined || pr.state !== "OPEN") continue;
    if (samePathKey(candidate.worktreePath) === ownKey) continue;
    if (best === undefined || pr.number > best.pr.number) best = { ...candidate, pr };
  }
  const repo = best === undefined ? undefined : repoFromPrUrl(best.pr.url);
  if (best === undefined || repo === undefined) return undefined;
  return {
    number: best.pr.number,
    title: best.pr.title,
    url: best.pr.url,
    repo,
    branch: best.branch,
    worktreePath: best.worktreePath,
    ...(best.threadId === undefined ? {} : { threadId: best.threadId }),
  };
};

/**
 * Whether the cue could mean anything to `thread`. Orchestration gives every worker a worktree of the
 * same repo, so a sibling's PR is always there to point at, and on the orchestrator, a dream, or a
 * worker in its own worktree on its own branch the chip only ever named some other worker's PR. A
 * worker that moved elsewhere or changed branch keeps it, as an ordinary thread does.
 */
export const wantsPrElsewhere = (
  thread: Pick<Thread, "role" | "workspaceId" | "spawnedBy" | "checkout" | "currentCheckout">,
  state: Pick<GitState, "branch">,
): boolean => {
  if (thread.role !== undefined) return false;
  if (thread.workspaceId === undefined && thread.spawnedBy === undefined) return true;
  const own = thread.checkout;
  const inOwnWorktree =
    own.kind === "worktree" &&
    samePathKey(effectiveCheckout(thread).path) === samePathKey(own.path) &&
    (own.branch === undefined || own.branch === state.branch);
  return !inOwnWorktree;
};

/**
 * The cue for every open checkout on a branch without a PR of its own or a bound one, keyed by
 * `samePathKey`; `undefined` clears a cue. `stateFor` supplies what the publisher already knows, so a
 * worktree a thread tracks costs no lookup. A repo whose open PRs can't be read just now is left out
 * of the answer, so its checkouts keep the cue they have. `onIncomplete` hears of a repo's roots or
 * worktrees that failed to read, so the caller can ask again soon; open PRs that can't be known (no
 * `gh`, no GitHub origin, a failed request) wait, as their list's minutes-long cache already does.
 */
export const discoverPrsElsewhere = (
  threads: ReadonlyArray<Thread>,
  stateFor: (key: string) => GitState | undefined,
  onIncomplete: () => void = () => {},
): Effect.Effect<Map<string, PrElsewhere | undefined>, never, OpenPrs | Proc | Worktrees> =>
  Effect.gen(function* () {
    const openPrs = yield* OpenPrs;
    const worktrees = yield* Worktrees;
    const found = new Map<string, PrElsewhere | undefined>();

    const wanting = new Map<string, string>();
    const threadAt = new Map<string, ThreadId>();
    for (const thread of threads) {
      const path = effectiveCheckout(thread).path;
      const key = samePathKey(path);
      threadAt.set(key, thread.id);
      const state = stateFor(key);
      if (thread.boundPr !== undefined || state === undefined || !state.repo) continue;
      if (state.pr !== undefined || state.branch === undefined) continue;
      if (!wantsPrElsewhere(thread, state)) continue;
      wanting.set(key, path);
    }
    if (wanting.size === 0) return found;

    const repos = new Map<string, { readonly path: string; readonly keys: Array<string> }>();
    for (const [key, path] of wanting) {
      const roots = yield* cachedRepoRoots(path).pipe(
        Effect.orElseSucceed(() => {
          onIncomplete();
          return undefined;
        }),
      );
      if (roots === undefined) continue;
      const repo = repos.get(roots.common) ?? { path, keys: [] };
      repo.keys.push(key);
      repos.set(roots.common, repo);
    }

    const lists = yield* Effect.forEach(
      repos,
      ([common, repo]) =>
        worktrees.list(repo.path, { openCheckouts: [] }).pipe(
          Effect.map((list) => ({ common, worktrees: list.worktrees })),
          Effect.orElseSucceed(() => {
            onIncomplete();
            return { common, worktrees: [] };
          }),
        ),
      { concurrency: 4 },
    );
    for (const { common, worktrees: entries } of lists) {
      const repo = repos.get(common);
      if (repo === undefined) continue;
      const branched = entries.flatMap((w) =>
        w.branch === undefined ? [] : [{ path: w.path, branch: w.branch }],
      );
      const untracked = branched.some((w) => stateFor(samePathKey(w.path)) === undefined);
      const open = untracked ? yield* openPrs.list(repo.path) : [];
      if (open === undefined) continue;
      const candidates = branched.map(({ path, branch }): WorktreePr => {
        const key = samePathKey(path);
        const tracked = stateFor(key);
        const listed = open.find((pr) => pr.branch === branch);
        const threadId = threadAt.get(key);
        return {
          worktreePath: path,
          branch,
          pr:
            tracked !== undefined
              ? tracked.pr
              : listed && {
                  number: listed.number,
                  state: "OPEN",
                  title: listed.title,
                  url: listed.url,
                },
          ...(threadId === undefined ? {} : { threadId }),
        };
      });
      for (const key of repo.keys) found.set(key, pickPrElsewhere(key, candidates));
    }
    return found;
  });
