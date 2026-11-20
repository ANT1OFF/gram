// Behind an embedding deployment's GitHub route (`embedding/github-relay.ts`), the `gh` a tool
// starts reads with the deployment's access, not the agent's or its person's. So a repository an
// agent names (a PR to bind or watch, a branch, a run, a release) is read there only when the
// thread works in it: a checkout of its was made from that repository, or it is the origin of a
// project of the thread's workspace, as `merge_freeze` asks. Anywhere else the `gh` is the
// person's own sign-in, and any repository they can see may be named.

import { cachedOriginUrl, type Proc } from "@gram/git";
import { AppToolError, type Thread, type ThreadId, type WakeCondition } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { githubRelayed } from "../embedding/github-relay.ts";
import { cloneUrlOf } from "../host/repos.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { remoteRepoOf } from "./worker-pr.ts";

const names = (url: string | undefined, repo: string) => {
  const named = url === undefined ? undefined : remoteRepoOf(url);
  return named !== undefined && `${named.owner}/${named.name}`.toLowerCase() === repo.toLowerCase();
};

/** Whether `thread` works in `repo`, by its checkouts' recorded clones or its workspace's origins. */
const worksIn = (store: ThreadStoreShape, thread: Thread, repo: string) =>
  Effect.gen(function* () {
    for (const checkout of [thread.checkout, ...(thread.extraCheckouts ?? [])]) {
      const identity = checkout.cloneIdentity;
      if (identity !== undefined && names(cloneUrlOf(identity), repo)) return true;
    }
    if (thread.workspaceId === undefined) return false;
    const { workspace } = yield* store.getWorkspace(thread.workspaceId);
    for (const project of yield* store.listProjects) {
      if (!workspace.projectIds.includes(project.id)) continue;
      const origin = yield* cachedOriginUrl(project.repoRoot ?? project.root).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (names(origin, repo)) return true;
    }
    return false;
  }).pipe(Effect.catchCause(() => Effect.succeed(false)));

/**
 * Why an agent of `thread` may not have `repo` read for it, or `undefined` when it may. Asked
 * before any read, so the answer is the same whether or not the repository or its PR exists.
 */
export const repoOutOfReach = (
  store: ThreadStoreShape,
  thread: Thread,
  repo: string,
): Effect.Effect<string | undefined, never, Proc> =>
  !githubRelayed()
    ? Effect.succeed(undefined)
    : worksIn(store, thread, repo).pipe(
        Effect.map((works) =>
          works
            ? undefined
            : `${repo} isn't a repository this thread works in (its checkout's, or a project's of its workspace), so Gram doesn't read it here.`,
        ),
      );

/** The repository a wake's condition reads on GitHub, if it reads one. */
const conditionRepo = (spec: WakeCondition | undefined): string | undefined =>
  spec === undefined
    ? undefined
    : "repo" in spec
      ? spec.repo
      : spec.kind === "releasePublished" && spec.source === "github"
        ? spec.name
        : undefined;

/**
 * Refuses `tool`'s call when a repository it names, a PR's or a wake condition's, is out of reach
 * of thread `threadId` (`repoOutOfReach`); a thread that can't be found reaches none.
 */
export const refuseOutOfReach = (
  tool: string,
  store: ThreadStoreShape,
  threadId: ThreadId,
  named: { readonly prRepo?: string | undefined; readonly condition?: WakeCondition | undefined },
): Effect.Effect<void, AppToolError, Proc> =>
  Effect.gen(function* () {
    if (!githubRelayed()) return;
    const repos = [named.prRepo, conditionRepo(named.condition)].filter(
      (repo): repo is string => repo !== undefined,
    );
    if (repos.length === 0) return;
    const thread = yield* store.getThread(threadId).pipe(Effect.orElseSucceed(() => undefined));
    for (const repo of repos) {
      const why =
        thread === undefined
          ? `${repo} is out of reach`
          : yield* repoOutOfReach(store, thread, repo);
      if (why !== undefined) return yield* new AppToolError({ tool, message: why });
    }
  });
