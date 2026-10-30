import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

/** Detached HEAD hides the branch a rebase or bisect still needs to restore. */
const operationUsesBranch = (worktree: string, branch: string) =>
  Effect.gen(function* () {
    const directory = yield* git(worktree, [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    ]).pipe(Effect.option);
    if (
      Option.isNone(directory) ||
      directory.value.status !== 0 ||
      directory.value.truncated ||
      directory.value.stdout.trim() === ""
    )
      return "unknown" as const;
    const gitDir = directory.value.stdout.trim();
    const state = yield* Effect.tryPromise(() =>
      Promise.all(
        ["rebase-merge/head-name", "rebase-apply/head-name", "BISECT_START"].map(async (file) => {
          try {
            return (await readFile(join(gitDir, file), "utf8")).trim();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
          }
        }),
      ),
    ).pipe(Effect.option);
    if (Option.isNone(state)) return "unknown" as const;
    return state.value.some((name) => name === branch || name === `refs/heads/${branch}`)
      ? ("held" as const)
      : ("free" as const);
  });

/**
 * Deletes a worktree's local branch after its PR merged. Everything is checked again right before
 * the conditional ref deletion: gh reports the PR merged now, the branch tip is the PR's head,
 * and no worktree still has the branch checked out or needs it for a rebase or bisect. Unknown
 * operation state keeps it too. The remote branch is never touched.
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

    // `git branch -D` guarded these detached worktrees itself. The conditional ref deletion
    // below must preserve that guard, reading every worktree's own operation state last.
    for (const worktree of list.value.worktrees) {
      const operation = yield* operationUsesBranch(worktree.path, branch);
      if (operation === "held") return keep(`it's being rebased or bisected in ${worktree.path}`);
      if (operation === "unknown")
        return keep(`couldn't inspect git operation state in ${worktree.path}`);
    }

    // Ref deletion compares under git's lock: another writer's new commits keep their branch.
    // Never dereference a symbolic branch ref into another branch's target.
    const out = yield* git(repoPath, [
      "update-ref",
      "--no-deref",
      "-d",
      `refs/heads/${branch}`,
      localTip,
    ]).pipe(Effect.option);
    if (Option.isNone(out) || out.value.status !== 0) {
      const detail = Option.isSome(out) ? out.value.stderr.trim() : "";
      return keep(`conditional branch deletion failed${detail === "" ? "" : `: ${detail}`}`);
    }
    return { name: branch, deleted: true };
  });
