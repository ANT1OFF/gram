// The PR context (`@gram/contracts` `threadPrContexts`) a helper prompt carries, read from
// what the server already holds: the published badge, the binding, and check names `Pr.seenChecks`
// kept from another caller's read. Never a GitHub request of its own.

import {
  prContextBadges,
  renderPrContext,
  repoFromPrUrl,
  reviewBotsOf,
  threadPrContexts,
  type GitState,
  type MergeReviewCharter,
  type WorkspaceId,
  type PrContext,
  type SeenPrChecks,
  type Settings,
  type Thread,
} from "@gram/contracts";
import type { SeenChecks } from "@gram/git";
import * as Effect from "effect/Effect";

import { redactText } from "../logging/redact.ts";

export interface PrContextDeps {
  readonly charter?:
    | ((id: WorkspaceId) => Effect.Effect<MergeReviewCharter | undefined, unknown>)
    | undefined;
  readonly settings: Effect.Effect<Settings, unknown>;
  readonly seenChecks: (repo: string, number: number) => Effect.Effect<SeenChecks | undefined>;
  readonly now: Effect.Effect<number>;
}

/** The context of each PR `thread` has, from its published `git` state; none on any failure. */
export const prContextsFor = (
  deps: PrContextDeps,
  thread: Pick<Thread, "boundPr" | "babysit"> & Partial<Pick<Thread, "workspaceId">>,
  git: Pick<GitState, "pr" | "extraPrs"> | undefined,
): Effect.Effect<ReadonlyArray<PrContext>> =>
  Effect.gen(function* () {
    const badges = prContextBadges(git);
    if (badges.length === 0) return [];
    const bots = reviewBotsOf(yield* deps.settings);
    const charter =
      thread.workspaceId === undefined || deps.charter === undefined
        ? undefined
        : yield* deps.charter(thread.workspaceId);
    const now = yield* deps.now;
    const seen = new Map<string, SeenPrChecks>();
    for (const badge of badges) {
      const repo = repoFromPrUrl(badge.url);
      if (repo === undefined) continue;
      const read = yield* deps.seenChecks(repo, badge.number);
      if (read !== undefined) seen.set(`${repo}#${badge.number}`, read);
    }
    return threadPrContexts({
      thread,
      git,
      charter,
      bots,
      now,
      seen: (repo, number) => seen.get(`${repo}#${number}`),
    });
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<PrContext> => []));

/** `prs` as the `<pr>` block of a helper prompt, token-shaped text scrubbed; none without a PR. */
export const prPromptBlock = (prs: ReadonlyArray<PrContext>): string | undefined => {
  const block = renderPrContext(prs);
  return block === undefined ? undefined : redactText(block);
};
