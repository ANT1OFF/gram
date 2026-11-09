import { GitError, InvalidState } from "@gram/contracts";
import {
  fastForwardBlocker,
  fastForwardCurrent,
  Proc,
  tryRepoTop,
  upstreamDivergence,
} from "@gram/git";
import * as Effect from "effect/Effect";
import { toGitError } from "../../git/mapping.ts";
import { pathHere } from "../../git/thread-pr.ts";
import { WorkerHosts } from "../../host/worker-host.ts";
import type { Handlers } from "./common.ts";

/** `git.upstreamSync` / `git.fastForward`: bring the current checkout up to its upstream. */
export const upstreamSyncHandlers = Effect.gen(function* () {
  const proc = yield* Proc;
  const hosts = yield* WorkerHosts;
  const provide = Effect.provideService(Proc, proc);

  /** A repository on this machine, whose git this runs. */
  const requireRepo = (repoPath: string) =>
    Effect.gen(function* () {
      yield* pathHere(hosts, repoPath);
      const repoTop = yield* provide(tryRepoTop(repoPath)).pipe(Effect.mapError(toGitError));
      if (repoTop === undefined) {
        return yield* new GitError({ message: `${repoPath} is not a git repository` });
      }
    });

  return {
    "git.upstreamSync": ({ repoPath }) =>
      Effect.gen(function* () {
        yield* requireRepo(repoPath);
        const divergence = yield* provide(upstreamDivergence(repoPath));
        const blocker = fastForwardBlocker(divergence);
        return {
          ...(divergence.branch === undefined ? {} : { branch: divergence.branch }),
          ...(divergence.ref === undefined ? {} : { ref: divergence.ref }),
          ahead: divergence.ahead,
          behind: divergence.behind,
          changedFiles: divergence.changedFiles,
          ...(blocker === undefined ? {} : { blocker }),
        };
      }),
    "git.fastForward": ({ repoPath }) =>
      Effect.gen(function* () {
        yield* requireRepo(repoPath);
        return yield* provide(fastForwardCurrent(repoPath)).pipe(
          Effect.mapError((e) => new InvalidState({ message: e.message })),
        );
      }),
  } satisfies Partial<Handlers>;
});
