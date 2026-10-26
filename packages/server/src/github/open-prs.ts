// Each repo's open PRs, cached for the sweep. The "PR on another worktree" cue needs only to know
// which branches have an open PR, and it is asked on every sweep for every worktree no thread is on:
// answered from a badge lookup per worktree, that was the single largest spend of the hour's GraphQL
// points in a repo with many worktrees. One list per repo, kept for minutes, answers them all.

import {
  fetchOpenPrs,
  makeTtlCache,
  originOwnerRepo,
  Proc,
  Tools,
  trackBadgeCache,
  type OpenPr,
  type OpenPrsError,
} from "@gram/git";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * How long a repo's list is reused. The cue points at someone else's work, so minutes of lag cost
 * nothing a user would notice; a PR write from this app clears it at once, with the badges.
 */
export const OPEN_PRS_TTL = Duration.minutes(3);

export class OpenPrs extends Context.Service<
  OpenPrs,
  {
    /**
     * The open PRs of `cwd`'s origin repo. `undefined` when they can't be known just now — no `gh`,
     * no GitHub remote, a refused or failed request — which callers must not read as "none".
     */
    readonly list: (cwd: string) => Effect.Effect<ReadonlyArray<OpenPr> | undefined>;
  }
>()("@gram/server/OpenPrs") {
  /** Never asks: for tests and for a server with no `gh` wiring. */
  static readonly layerNone = Layer.succeed(OpenPrs, { list: () => Effect.succeed(undefined) });

  /** Caches whatever `fetch` returns for a repo, sharing one request between concurrent callers. */
  static readonly layerFrom = (
    repoOf: (cwd: string) => Effect.Effect<string | undefined>,
    fetch: (cwd: string, repo: string) => Effect.Effect<ReadonlyArray<OpenPr>, OpenPrsError>,
  ) =>
    Layer.effect(
      OpenPrs,
      Effect.gen(function* () {
        const cache = makeTtlCache<
          { readonly cwd: string; readonly repo: string },
          ReadonlyArray<OpenPr>,
          OpenPrsError,
          never
        >({
          key: ({ repo }) => repo.toLowerCase(),
          ttlMs: Duration.toMillis(OPEN_PRS_TTL),
          fetch: ({ cwd, repo }) => fetch(cwd, repo),
        });
        const untrack = trackBadgeCache(cache);
        yield* Effect.addFinalizer(() => Effect.sync(untrack));
        return {
          list: (cwd) =>
            Effect.gen(function* () {
              const repo = yield* repoOf(cwd);
              if (repo === undefined) return undefined;
              return yield* cache.get({ cwd, repo }).pipe(Effect.orElseSucceed(() => undefined));
            }),
        };
      }),
    );

  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const proc = yield* Proc;
      const tools = yield* Tools;
      const provide = Effect.provideService(Proc, proc);
      return OpenPrs.layerFrom(
        (cwd) =>
          Effect.gen(function* () {
            if (!(yield* tools.ghReady)) return undefined;
            return yield* provide(originOwnerRepo(cwd));
          }),
        (cwd, repo) => provide(fetchOpenPrs(cwd, repo)),
      );
    }),
  );
}
