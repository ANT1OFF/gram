// Which GitHub repository a checkout's PR lookups name. By default its `origin` as its git config
// says now; an embedder that recorded which repository each folder is (`CheckoutRepos`) answers
// instead, so a rewritten `origin` (`git remote set-url`) can't point a lookup at another one.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Proc } from "./proc.ts";
import { cachedOriginUrl } from "./repo-facts.ts";

/** `owner/repo` from a remote URL (scp-style, https, ssh); `undefined` when not shaped like one. */
export const parseOwnerRepo = (url: string): string | undefined => {
  const match =
    /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?[^/:]+[:/](?:\d+\/)?([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  return match ? `${match[1]}/${match[2]}` : undefined;
};

/** `owner/repo` of the checkout's `origin`, kept while the repo's config is unchanged. */
export const originOwnerRepo = (cwd: string): Effect.Effect<string | undefined, never, Proc> =>
  cachedOriginUrl(cwd).pipe(
    Effect.map((url) => (url === undefined ? undefined : parseOwnerRepo(url))),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * The repository a folder's PR lookups name, as its embedder recorded it: `owner/name`,
 * `undefined` for a folder it knows to have none, or `null` for one it doesn't know, which goes by
 * its live `origin`.
 */
export type CheckoutRepoLookup = (workTree: string) => Effect.Effect<string | undefined | null>;

export interface CheckoutReposShape {
  readonly repoOf: CheckoutRepoLookup;
  /** Sets the lookup: the embedder does once it can answer, which is after the PR services start. */
  readonly answerWith: (lookup: CheckoutRepoLookup) => void;
}

const unknownFolders: CheckoutRepoLookup = () => Effect.succeed(null);

/** Where an embedder says which repository each folder is; every folder is unknown until it does. */
export class CheckoutRepos extends Context.Service<CheckoutRepos, CheckoutReposShape>()(
  "@gram/git/CheckoutRepos",
) {
  static readonly layer = Layer.sync(CheckoutRepos, () => {
    let lookup = unknownFolders;
    return {
      repoOf: (workTree) => Effect.suspend(() => lookup(workTree)),
      answerWith: (next) => {
        lookup = next;
      },
    };
  });
}

/** `effect` with `repos` in its context when there are any (`Effect.serviceOption` reads them). */
export const withCheckoutRepos = <A, E, R>(
  repos: Option.Option<CheckoutReposShape>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Option.isSome(repos) ? Effect.provideService(effect, CheckoutRepos, repos.value) : effect;

/** The repository a checkout's PR lookups name: as recorded where it is, else its live origin. */
export const recordedOrOriginRepo = (
  workTree: string,
): Effect.Effect<string | undefined | null, never, Proc> =>
  Effect.gen(function* () {
    const repos = yield* Effect.serviceOption(CheckoutRepos);
    const recorded = Option.isSome(repos) ? yield* repos.value.repoOf(workTree) : null;
    if (recorded !== null) return recorded;
    return (yield* originOwnerRepo(workTree)) ?? null;
  });
