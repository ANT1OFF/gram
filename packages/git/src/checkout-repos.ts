import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { samePath } from "./paths.ts";
import type { Proc } from "./proc.ts";
import { gh } from "./exec.ts";
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

/**
 * The repository the PR lookups of the checkout at `cwd` name, `workTree` being the top level git
 * reports for it: as the embedder recorded `cwd`, where it did. A top level other than `cwd` is
 * what the folder's `.git` file and `core.worktree` say, which an agent working there can point
 * anywhere, so behind an embedder such a folder names none rather than go by that one's origin.
 * Only a folder the embedder doesn't know, at its own top level, goes by its live `origin`.
 */
export const recordedOrOriginRepo = (
  cwd: string,
  workTree: string,
): Effect.Effect<string | undefined | null, never, Proc> =>
  Effect.gen(function* () {
    const repos = yield* Effect.serviceOption(CheckoutRepos);
    if (Option.isSome(repos)) {
      const recorded = yield* repos.value.repoOf(cwd);
      if (recorded !== null) return recorded;
      if (!samePath(cwd, workTree)) return undefined;
    }
    return (yield* originOwnerRepo(workTree)) ?? null;
  });

/**
 * The repo for `--repo`: the one the embedder recorded the folder as (`CheckoutRepos`), else the
 * local origin URL over `gh repo view`: instant, and right on a fork, where gh's default repo can
 * be the upstream.
 */
export const resolveRepoNwo = (cwd: string, workTree: string) =>
  Effect.gen(function* () {
    const origin = yield* recordedOrOriginRepo(cwd, workTree);
    if (origin !== null) return origin;
    const out = yield* gh(
      workTree,
      ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
      { timeoutMs: 8_000 },
    ).pipe(Effect.option);
    return Option.isSome(out) && out.value.status === 0
      ? out.value.stdout.trim() || undefined
      : undefined;
  });
