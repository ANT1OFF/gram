import type { GitState } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { git, porcelainChanges } from "./exec.ts";
import type { Proc } from "./proc.ts";
import { listWorktrees } from "./worktrees.ts";

export interface WorkElsewhere {
  readonly branch: string;
  readonly path: string;
}

/**
 * The worktree holding the repo's uncommitted work when it isn't this checkout. Only
 * a clean main checkout on a branch qualifies; a linked worktree is pinned to itself. Among the other
 * worktrees on a different branch with uncommitted changes, the most recently active one wins.
 * `concurrency` bounds the `git status` calls, one per sibling.
 */
export const workElsewhere = (
  cwd: string,
  state: GitState,
  options: { readonly concurrency?: number } = {},
): Effect.Effect<WorkElsewhere | undefined, never, Proc> =>
  Effect.gen(function* () {
    if (!state.repo || state.worktree || state.changedFiles > 0 || state.branch === undefined) {
      return undefined;
    }
    const list = yield* listWorktrees(cwd, { openCheckouts: [] }).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (list === undefined) return undefined;
    const siblings = list.worktrees.filter(
      (w) => !w.isMain && w.branch !== undefined && w.branch !== state.branch,
    );
    const dirty = yield* Effect.forEach(
      siblings,
      (sibling) =>
        git(sibling.path, ["status", "--porcelain"]).pipe(
          Effect.option,
          Effect.map(
            (status) =>
              status._tag === "Some" &&
              status.value.status === 0 &&
              porcelainChanges(status.value.stdout) > 0,
          ),
        ),
      { concurrency: options.concurrency ?? 1 },
    );
    let best: { readonly entry: WorkElsewhere; readonly at: number } | undefined;
    for (const [index, sibling] of siblings.entries()) {
      if (!dirty[index]) continue;
      if (best === undefined || sibling.lastActivity > best.at) {
        best = { entry: { branch: sibling.branch!, path: sibling.path }, at: sibling.lastActivity };
      }
    }
    return best?.entry;
  });
