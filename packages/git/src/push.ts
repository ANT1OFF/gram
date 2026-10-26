// Publishing or pushing the current branch to origin. Never forces, never prompts for credentials.

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { git, gitFailMsg } from "./exec.ts";
import type { Proc } from "./proc.ts";

/** Pushing was refused or failed. */
export class PushFailed extends Data.TaggedError("PushFailed")<{ readonly message: string }> {}

export interface Pushed {
  readonly branch: string;
  /** The branch had no upstream, so it was pushed with `-u origin <branch>`. */
  readonly published: boolean;
}

/** Pushes can carry many objects over a slow link; the network tier's default is for fetches. */
const PUSH_TIMEOUT_MS = 120_000;

const counts = (stdout: string) => {
  const [behind = 0, ahead = 0] = stdout
    .trim()
    .split(/\s+/)
    .map((n) => Number.parseInt(n, 10) || 0);
  return { behind, ahead };
};

const toPushFailed = (e: { readonly message: string }) => new PushFailed({ message: e.message });

/**
 * `git push` for the current branch, or `git push -u origin <branch>` when it isn't on origin under
 * its own name yet. A branch tracking something else (a worktree branched from `origin/main` tracks
 * `origin/main`) counts as unpublished, as `GitState.upstream` does. Refuses a detached HEAD, a repo
 * without an `origin` remote, and a branch that is behind or has diverged from its upstream: that
 * needs a pull or rebase first, never a force.
 */
export const pushCurrentBranch = (cwd: string): Effect.Effect<Pushed, PushFailed, Proc> =>
  Effect.gen(function* () {
    const head = yield* git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
      Effect.mapError(toPushFailed),
    );
    const branch = head.status === 0 ? head.stdout.trim() : "";
    if (branch === "" || branch === "HEAD") {
      return yield* new PushFailed({
        message: "HEAD isn't on a branch, so there's nothing to push",
      });
    }
    const origin = yield* git(cwd, ["remote", "get-url", "origin"]).pipe(Effect.option);
    if (Option.isNone(origin) || origin.value.status !== 0) {
      return yield* new PushFailed({ message: "This repository has no origin remote to push to" });
    }

    const upstream = yield* git(cwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]).pipe(Effect.option);
    const hasUpstream =
      Option.isSome(upstream) &&
      upstream.value.status === 0 &&
      upstream.value.stdout.trim() === `origin/${branch}`;
    if (hasUpstream) {
      const out = yield* git(cwd, [
        "rev-list",
        "--left-right",
        "--count",
        "@{upstream}...HEAD",
      ]).pipe(Effect.mapError(toPushFailed));
      const { behind, ahead } = out.status === 0 ? counts(out.stdout) : { behind: 0, ahead: 0 };
      if (behind > 0 && ahead > 0) {
        return yield* new PushFailed({
          message: `${branch} has diverged from ${upstream.value.stdout.trim()} (${ahead} ahead, ${behind} behind). Pull or rebase first; Gram never force-pushes.`,
        });
      }
      if (behind > 0) {
        return yield* new PushFailed({
          message: `${branch} is ${behind} commit${behind === 1 ? "" : "s"} behind ${upstream.value.stdout.trim()}. Pull first.`,
        });
      }
    }

    const args = hasUpstream ? ["push", "--quiet"] : ["push", "--quiet", "-u", "origin", branch];
    const out = yield* git(cwd, ["-c", "credential.interactive=false", ...args], {
      tier: "network",
      timeoutMs: PUSH_TIMEOUT_MS,
    }).pipe(Effect.mapError(toPushFailed));
    if (out.status !== 0) {
      return yield* new PushFailed({ message: gitFailMsg(out, "git push failed") });
    }
    return { branch, published: !hasUpstream };
  });
