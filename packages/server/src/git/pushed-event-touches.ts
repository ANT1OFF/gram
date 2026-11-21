// Which checkouts a pushed repository event touches, so only those are read again.

import type { GitState } from "@gram/contracts";
import { repoFromPrUrl } from "@gram/git";
import type { PrRef } from "./extra-prs.ts";

/** Something that happened to a repository on GitHub, as whoever received its webhook retells it. */
export interface PushedRepoEvent {
  /** `owner/name`. */
  readonly repo: string;
  /** The pull request it is about, when it is about one. */
  readonly number?: number | undefined;
  /** The head branch it is about: a pull request just opened has no number any checkout knows. */
  readonly branch?: string | undefined;
}

const isRepo = (left: string | undefined, right: string) =>
  left !== undefined && left.toLowerCase() === right.toLowerCase();

/**
 * Whether `event` touches a checkout in `state` whose threads are `threads`, with the PRs they
 * wait on in `waited`: its own PR or branch, or a PR one of them is bound to, follows or waits on.
 * An event naming neither a PR nor a branch touches every checkout of its repository. A checkout's
 * repositories are its `origin` and the one its PR is in, which a fork's differ in; GitHub ignores
 * a repository's case.
 */
export const pushedEventTouches = (
  event: PushedRepoEvent,
  state: Pick<GitState, "origin" | "branch" | "pr"> | undefined,
  threads: ReadonlyArray<{
    readonly boundPr?: PrRef | undefined;
    readonly extraPrs?: ReadonlyArray<PrRef> | undefined;
  }>,
  waited: ReadonlyArray<PrRef> = [],
): boolean => {
  const prRepo = state?.pr === undefined ? undefined : repoFromPrUrl(state.pr.url);
  const here = isRepo(state?.origin, event.repo) || isRepo(prRepo, event.repo);
  const whole = event.number === undefined && event.branch === undefined;
  if (here && whole) return true;
  if (event.number !== undefined && state?.pr?.number === event.number) {
    if (isRepo(prRepo ?? state.origin, event.repo)) return true;
  }
  if (here && event.branch !== undefined && state?.branch === event.branch) return true;
  const names = (ref: PrRef) =>
    isRepo(ref.repo, event.repo) && (whole || ref.number === event.number);
  return (
    threads.some(
      (thread) =>
        (thread.boundPr !== undefined && names(thread.boundPr)) ||
        (thread.extraPrs ?? []).some(names),
    ) || waited.some(names)
  );
};
