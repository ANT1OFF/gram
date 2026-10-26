// Runtime shapes from `@gram/git` onto the round-3 contracts, and the git errors onto contract
// errors.

import {
  GitError,
  InvalidState,
  WorktreeDirty,
  type Diff,
  type DiffFile,
  type PrDetail,
} from "@gram/contracts";
import * as GitRuntime from "@gram/git";
import * as Effect from "effect/Effect";

export const toGitError = (error: { readonly message: string }) =>
  new GitError({ message: error.message });

export const toDiffFile = (
  file: GitRuntime.DiffFile,
  untracked: ReadonlySet<string>,
): DiffFile => ({
  path: file.path,
  status: file.status === "new" ? (untracked.has(file.path) ? "untracked" : "added") : file.status,
  additions: file.added,
  deletions: file.removed,
  patch: file.note === undefined ? file.diff : "",
  binary: file.note === "binary",
  tooLarge: file.note === "too large",
});

export const toDiff = (diff: GitRuntime.DiffResponse, untracked: ReadonlySet<string>): Diff => ({
  repo: diff.repo,
  ...(diff.branch === undefined ? {} : { branch: diff.branch }),
  ...(diff.worktree === undefined ? {} : { worktree: diff.worktree }),
  ...(diff.base === undefined ? {} : { base: diff.base }),
  ...(diff.note === undefined ? {} : { note: diff.note }),
  ...(diff.files === undefined ? {} : { files: diff.files.map((f) => toDiffFile(f, untracked)) }),
});

export const toPrDetail = (detail: GitRuntime.PrDetail): PrDetail => ({
  ...detail,
  files: detail.files.map((f) => toDiffFile(f, new Set())),
});

/** Untracked files of the checkout at `top`, relative to it. */
export const untrackedPaths = (
  top: string,
): Effect.Effect<ReadonlySet<string>, never, GitRuntime.Proc> =>
  GitRuntime.git(top, ["ls-files", "--others", "--exclude-standard", "-z"], {
    maxOutputBytes: 64 * 1024 * 1024,
  }).pipe(
    Effect.map((out) => new Set(out.stdout.split("\0").filter((p) => p !== ""))),
    Effect.orElseSucceed(() => new Set<string>()),
  );

/** Changed entries in a checkout, for `WorktreeDirty.changedFiles`; 0 when unknown. */
export const changedFileCount = (path: string): Effect.Effect<number, never, GitRuntime.Proc> =>
  GitRuntime.git(path, ["status", "--porcelain"]).pipe(
    Effect.map((out) => (out.status === 0 ? GitRuntime.porcelainChanges(out.stdout) : 0)),
    Effect.orElseSucceed(() => 0),
  );

/** A worktree failure as the error a removal RPC reports. */
export const removalError = (
  error: GitRuntime.WorktreeError,
  path: string,
): Effect.Effect<never, GitError | WorktreeDirty | InvalidState, GitRuntime.Proc> =>
  error.dirty
    ? changedFileCount(path).pipe(
        Effect.flatMap((changedFiles) => Effect.fail(new WorktreeDirty({ path, changedFiles }))),
      )
    : Effect.fail(
        error.reason === "conflict"
          ? new InvalidState({ message: error.message })
          : toGitError(error),
      );
