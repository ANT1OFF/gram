// Whether a pull request is a worker's own, the one thing the `full`-autonomy merge delegation
// covers. One check for every place that merges without a card: the
// tools' gate, their recheck in `handle`, and `merge_when_ready`'s launch, which can come long after.

import type { Thread } from "@gram/contracts";
import { git, originOwnerRepo, prHead, realPathOrOwned, samePath } from "@gram/git";
import * as Effect from "effect/Effect";
import { folderExists } from "../fs/folders.ts";
import { ThreadStore } from "../persistence/thread-store.ts";

/** `owner/repo` names as GitHub compares them, ignoring case. */
const sameRepo = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

/**
 * A path with its symlinks resolved, else as given. A project keeps the path it was opened by, and a
 * worktree's `repoRoot` is git's `--show-toplevel`, so one repo can be `/var/…` and `/private/var/…`.
 */
const canonical = (path: string) => Effect.promise(() => realPathOrOwned(path));

/** Remember a branch only when observed in a worktree this worker holds, never one it follows. */
export const withOwnedBranch = (
  thread: Thread,
  path: string,
  branch: string | undefined,
): Thread => {
  if (
    thread.spawnedBy === undefined ||
    branch === undefined ||
    ![thread.checkout, ...(thread.extraCheckouts ?? [])].some(
      (checkout) => checkout.kind === "worktree" && samePath(checkout.path, path),
    ) ||
    thread.ownedBranches?.some((owned) => samePath(owned.path, path) && owned.branch === branch)
  )
    return thread;
  return { ...thread, ownedBranches: [...(thread.ownedBranches ?? []), { path, branch }] };
};

/**
 * The verified held path and branch of the worker's open, non-fork PR, else why it is not owned.
 * The held worktree must still belong to a workspace project. Read-only, so the tool's gate can
 * call it repeatedly; arming persists the verified branch with the intent. GitHub supplies the head
 * on every call, asked from the repo's main checkout when the worktree's folder is gone. A doubt is a refusal; `reviewedHead`, when given, must still be its head.
 */
const checkWorkerPr = (
  thread: Thread,
  repo: string,
  number: number,
  reviewedHead?: string,
  requireOwnedBranch = true,
) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    if (thread.workspaceId === undefined) return "the worker no longer belongs to a workspace";
    const { workspace } = yield* store.getWorkspace(thread.workspaceId);
    const projects = (yield* store.listProjects).filter((project) =>
      workspace.projectIds.includes(project.id),
    );
    const roots = new Set(
      yield* Effect.forEach(projects, (project) => canonical(project.repoRoot ?? project.root)),
    );
    // `currentCheckout` is left out: following the agent into a worktree doesn't make it the
    // worker's, and it may be another thread's.
    const branches = new Map<string, string>();
    let cwd: string | undefined;
    let unrecorded = false;
    for (const checkout of [thread.checkout, ...(thread.extraCheckouts ?? [])]) {
      if (checkout.kind !== "worktree") continue;
      // A worktree deleted outside Gram is asked about from its repo's main checkout, and
      // only the branches recorded for it count, since there is no HEAD left to read.
      const present = yield* folderExists(checkout.path);
      const at = present ? checkout.path : checkout.repoRoot;
      if (at === undefined) {
        unrecorded = true;
        continue;
      }
      if (!roots.has(yield* canonical(checkout.repoRoot ?? checkout.path))) continue;
      if (!sameRepo(yield* originOwnerRepo(at), repo)) continue;
      if (checkout.branch !== undefined) branches.set(checkout.branch, checkout.path);
      for (const owned of thread.ownedBranches ?? []) {
        if (samePath(owned.path, checkout.path)) branches.set(owned.branch, checkout.path);
      }
      if (present) {
        // A tool can arrive before the watcher sees a branch created immediately before gh pr
        // create.
        const local = yield* git(checkout.path, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
          timeoutMs: 2_000,
        });
        const observed = local.status === 0 ? local.stdout.trim() || undefined : undefined;
        if (observed !== undefined) branches.set(observed, checkout.path);
      }
      cwd ??= at;
    }
    if (cwd === undefined)
      return unrecorded
        ? "its worktree is gone and the repo it belonged to was never recorded"
        : "its repo is no longer one of the worker's workspace projects";
    const head = yield* prHead(cwd, number, repo);
    if (!sameRepo(head.repo, repo)) return "its repository no longer matches the requested PR";
    if (head.state !== "OPEN")
      return head.state === undefined
        ? "its open state could not be verified"
        : `it is ${head.state.toLowerCase()}`;
    if (head.fork) return "its head is from another repository";
    if (requireOwnedBranch && !branches.has(head.headRefName))
      return "its head branch is no longer a worktree branch held by this worker";
    if (reviewedHead !== undefined && head.headRefOid !== reviewedHead)
      return head.headRefOid === undefined
        ? "its head could not be verified"
        : "its head moved since the reviewed head was checked";
    return { path: branches.get(head.headRefName) ?? cwd, branch: head.headRefName };
  }).pipe(Effect.catchCause(() => Effect.succeed("its ownership could not be verified")));

/** An owned branch, as before; identity-only verification never supplies ownership. */
export const workerPrOwnership = (
  thread: Thread,
  repo: string,
  number: number,
  reviewedHead?: string,
) => checkWorkerPr(thread, repo, number, reviewedHead);

/** Open, non-fork PR in a held workspace project's origin; confers no branch ownership. */
export const workerPrIdentity = (
  thread: Thread,
  repo: string,
  number: number,
  reviewedHead?: string,
) =>
  checkWorkerPr(thread, repo, number, reviewedHead, false).pipe(
    Effect.map((result) => typeof result === "object"),
  );

/** Why this PR is not the worker's own, with optional pinning to a previously reviewed head. */
export const workerPrBlocker = (
  thread: Thread,
  repo: string,
  number: number,
  reviewedHead?: string,
) =>
  workerPrOwnership(thread, repo, number, reviewedHead).pipe(
    Effect.map((ownership) => (typeof ownership === "string" ? ownership : undefined)),
  );

/** Whether this PR belongs to a recorded worker worktree, independent of its current checkout. */
export const workerOwnsPr = (thread: Thread, repo: string, number: number) =>
  workerPrBlocker(thread, repo, number).pipe(Effect.map((why) => why === undefined));
