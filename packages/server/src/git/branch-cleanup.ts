import { git, listWorktrees, Pr, type Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export interface BranchCleanupRequest {
  /** A checkout of the repo that still exists, typically the main checkout. */
  readonly repoPath: string;
  readonly branch: string;
  /** The PR the branch was merged through. */
  readonly pr: { readonly repo: string; readonly number: number };
}

export interface BranchCleanup {
  readonly name: string;
  readonly deleted: boolean;
  /** Why the branch was kept; absent once deleted. */
  readonly reason?: string;
}

const BRANCH_NAME = /^(?!-)[\w./-]+$/;

/**
 * Deletes a worktree's local branch after its PR merged. Everything is checked again right before
 * `git branch -D`: gh reports the PR merged now, the branch tip is the PR's head, and no worktree
 * still has the branch checked out. Otherwise, or when gh can't answer, the branch is kept with a
 * reason. The remote branch is never touched.
 */
export const deleteMergedBranch = (
  request: BranchCleanupRequest,
): Effect.Effect<BranchCleanup, never, Pr | Proc> =>
  Effect.gen(function* () {
    const { repoPath, branch } = request;
    const number = request.pr.number;
    const keep = (reason: string): BranchCleanup => ({ name: branch, deleted: false, reason });
    if (!BRANCH_NAME.test(branch)) return keep("the branch name isn't one git can delete safely");

    const pr = yield* Pr;
    const status = yield* pr.status(repoPath, request.pr).pipe(Effect.option);
    if (Option.isNone(status) || status.value === undefined) {
      return keep(`couldn't confirm #${number} with gh`);
    }
    if (status.value.state !== "MERGED") return keep(`#${number} isn't merged`);
    const head = status.value.headRefOid;

    const tip = yield* git(repoPath, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]).pipe(Effect.option);
    if (Option.isNone(tip) || tip.value.status !== 0) return keep("there's no local branch");
    const localTip = tip.value.stdout.trim();
    if (head === undefined || localTip !== head) {
      return keep(`it has commits #${number} doesn't`);
    }

    const list = yield* listWorktrees(repoPath, { openCheckouts: [] }).pipe(Effect.option);
    if (Option.isNone(list)) return keep("couldn't list the repo's worktrees");
    const holder = list.value.worktrees.find((w) => w.branch === branch);
    if (holder !== undefined) return keep(`it's checked out in ${holder.path}`);

    const out = yield* git(repoPath, ["branch", "-D", branch]).pipe(Effect.option);
    if (Option.isNone(out) || out.value.status !== 0) {
      const detail = Option.isSome(out) ? out.value.stderr.trim() : "";
      return keep(`git branch -D failed${detail === "" ? "" : `: ${detail}`}`);
    }
    return { name: branch, deleted: true };
  });
