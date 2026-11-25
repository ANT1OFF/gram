import {
  effectiveCheckout,
  fieldsOf,
  isLocalHost,
  type PrStatus,
  type Thread,
} from "@gram/contracts";
import { gh, git, isSameRepoHead, originOwnerRepo, Proc, repoFromPrUrl } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { cloneIdentityOf } from "../host/repos.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { isBadgeOf } from "./extra-prs.ts";
import { GitStatePublisher } from "./publisher.ts";

const sameRepo = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

/** A project here whose origin is the one a worktree on another machine cloned. */
export interface CloneProject {
  /** The project's folder here, where `gh` starts. */
  readonly root: string;
  /** Its origin as `owner/repo`. */
  readonly repo: string;
}

/**
 * The repository the thread's worktree on another machine cloned, from what this machine recorded
 * as it made it (`Checkout.cloneIdentity`), never from what that machine says: the workspace
 * project (or the thread's own) whose origin here has that identity. `undefined` for a checkout
 * on this machine, one made before the identity was recorded, or one no project here matches.
 */
export const cloneProjectOf = (
  thread: Thread,
): Effect.Effect<CloneProject | undefined, never, ThreadStore | Proc> =>
  Effect.gen(function* () {
    const checkout = effectiveCheckout(thread);
    const identity = checkout.cloneIdentity;
    if (isLocalHost(checkout) || identity === undefined) return undefined;
    const store = yield* ThreadStore;
    const workspaceProjects =
      thread.workspaceId === undefined
        ? []
        : yield* store.getWorkspace(thread.workspaceId).pipe(
            Effect.map(({ workspace }) => workspace.projectIds),
            Effect.orElseSucceed((): ReadonlyArray<string> => []),
          );
    const ids = new Set<string>([thread.projectId, ...workspaceProjects]);
    const projects = (yield* store.listProjects.pipe(Effect.orElseSucceed(() => []))).filter(
      (project) => ids.has(project.id),
    );
    for (const project of projects) {
      const root = project.repoRoot ?? project.root;
      const out = yield* git(root, ["config", "--get", "remote.origin.url"], {
        timeoutMs: 2_000,
      }).pipe(Effect.orElseSucceed(() => undefined));
      if (out === undefined || out.status !== 0) continue;
      if (cloneIdentityOf(out.stdout.trim()) !== identity) continue;
      const repo = yield* originOwnerRepo(root);
      if (repo !== undefined) return { root, repo };
    }
    return undefined;
  });

const openPrNumber = (root: string, repo: string, branch: string) =>
  gh(
    root,
    [
      "pr",
      "list",
      "--repo",
      repo,
      `--head=${branch}`,
      "--state",
      "open",
      "--json",
      "number,isCrossRepository",
      "--limit",
      "5",
    ],
    { timeoutMs: 15_000 },
  ).pipe(
    Effect.map((out) => {
      if (out.status !== 0) return undefined;
      try {
        const listed: unknown = JSON.parse(out.stdout);
        if (!Array.isArray(listed)) return undefined;
        const own = listed.find(
          (entry: unknown): entry is { readonly number: number } =>
            isSameRepoHead(entry) && typeof fieldsOf(entry).get("number") === "number",
        );
        return own?.number;
      } catch {
        return undefined;
      }
    }),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * For a thread on another machine, what its published git state leaves out: its origin, and the
 * open PR of its branch with its badge. The branch is the one its host last published, else the
 * one Gram recorded as it made the worktree. Only asked when the published state has no answer.
 */
export const MachineBranchPr = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const proc = yield* Proc;
  const publisher = yield* GitStatePublisher;
  const here = <A>(effect: Effect.Effect<A, never, ThreadStore | Proc>) =>
    effect.pipe(Effect.provideService(ThreadStore, store), Effect.provideService(Proc, proc));

  const origin = (thread: Thread): Effect.Effect<string | undefined> =>
    Effect.map(here(cloneProjectOf(thread)), (project) => project?.repo);

  const boundBadge = (thread: Thread, bound: { readonly repo: string; readonly number: number }) =>
    Effect.map(publisher.stateForThread(thread), (state) =>
      state?.pr !== undefined && isBadgeOf(state.pr, bound) ? state.pr : undefined,
    );

  const discover = (thread: Thread): Effect.Effect<PrStatus | undefined> =>
    Effect.gen(function* () {
      const project = yield* here(cloneProjectOf(thread));
      if (project === undefined) return undefined;
      const published = yield* publisher.stateForThread(thread);
      const badge = published?.pr;
      if (badge !== undefined && sameRepo(repoFromPrUrl(badge.url), project.repo)) return badge;
      const branch = published?.branch ?? effectiveCheckout(thread).branch;
      if (branch === undefined || branch.startsWith("-")) return undefined;
      const number = yield* here(openPrNumber(project.root, project.repo, branch));
      if (number === undefined) return undefined;
      const found = Option.getOrUndefined(
        yield* publisher.lookupPr(thread, { repo: project.repo, number }),
      );
      return found !== undefined && sameRepo(repoFromPrUrl(found.url), project.repo)
        ? found
        : undefined;
    });

  const pr = (thread: Thread): Effect.Effect<PrStatus | undefined> =>
    thread.boundPr === undefined ? discover(thread) : boundBadge(thread, thread.boundPr);

  return { origin, pr };
});
