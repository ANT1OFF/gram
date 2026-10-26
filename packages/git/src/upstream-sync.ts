// The current branch against its `origin/` upstream, and a fast-forward onto it.

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { git, gitFailMsg, porcelainChanges } from "./exec.ts";
import type { Proc } from "./proc.ts";
import { currentUpstream } from "./refs.ts";

export interface UpstreamDivergence {
  /** Absent when HEAD is detached or unborn. */
  readonly branch: string | undefined;
  /** The branch's `origin/` upstream, when it has one. */
  readonly ref: string | undefined;
  readonly ahead: number;
  readonly behind: number;
  /** Uncommitted changes to tracked files; untracked files don't block a fast-forward. */
  readonly changedFiles: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** How far the current branch and its upstream have moved apart, from local refs only. */
export const upstreamDivergence = (cwd: string): Effect.Effect<UpstreamDivergence, never, Proc> =>
  Effect.gen(function* () {
    const { branch, ref } = yield* currentUpstream(cwd);
    const status = yield* git(cwd, ["status", "--porcelain", "--untracked-files=no"]).pipe(
      Effect.option,
    );
    const changedFiles =
      Option.isSome(status) && status.value.status === 0
        ? porcelainChanges(status.value.stdout)
        : 0;
    if (ref === undefined) return { branch, ref, ahead: 0, behind: 0, changedFiles };
    const counts = yield* git(cwd, ["rev-list", "--left-right", "--count", `HEAD...${ref}`]).pipe(
      Effect.option,
    );
    const [ahead = 0, behind = 0] =
      Option.isSome(counts) && counts.value.status === 0
        ? counts.value.stdout
            .trim()
            .split(/\s+/)
            .map((n) => Number.parseInt(n, 10) || 0)
        : [];
    return { branch, ref, ahead, behind, changedFiles };
  });

/** Why the current branch can't fast-forward onto its upstream, or `undefined` when it can. */
export const fastForwardBlocker = (divergence: UpstreamDivergence): string | undefined => {
  if (divergence.branch === undefined) return "HEAD isn't on a branch";
  if (divergence.ref === undefined) return "it has no origin upstream";
  if (divergence.behind === 0) return "it's up to date";
  if (divergence.ahead > 0) return `it has ${plural(divergence.ahead, "commit")} of its own`;
  if (divergence.changedFiles > 0) {
    return `it has ${plural(divergence.changedFiles, "uncommitted change")}`;
  }
  return undefined;
};

/** Fast-forwarding the current branch was refused or failed. */
export class FastForwardFailed extends Data.TaggedError("FastForwardFailed")<{
  readonly message: string;
}> {}

export interface FastForwarded {
  readonly branch: string;
  readonly ref: string;
  readonly commits: number;
  readonly head: string;
}

/** Moves the current branch onto its upstream with `git merge --ff-only`, refusing anything else. */
export const fastForwardCurrent = (
  cwd: string,
): Effect.Effect<FastForwarded, FastForwardFailed, Proc> =>
  Effect.gen(function* () {
    const divergence = yield* upstreamDivergence(cwd);
    const { branch, ref } = divergence;
    const blocker = fastForwardBlocker(divergence);
    if (blocker !== undefined || branch === undefined || ref === undefined) {
      return yield* new FastForwardFailed({
        message: `Can't fast-forward ${branch ?? "HEAD"}: ${blocker ?? "no upstream"}`,
      });
    }
    const out = yield* git(cwd, ["merge", "--ff-only", "--quiet", ref]).pipe(
      Effect.mapError((e) => new FastForwardFailed({ message: e.message })),
    );
    if (out.status !== 0) {
      return yield* new FastForwardFailed({
        message: gitFailMsg(out, "git merge --ff-only failed"),
      });
    }
    const head = yield* git(cwd, ["rev-parse", "HEAD"]).pipe(
      Effect.map((o) => o.stdout.trim()),
      Effect.orElseSucceed(() => ""),
    );
    return { branch, ref, commits: divergence.behind, head };
  });
