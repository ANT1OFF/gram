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

/**
 * Why a PR is not the worker's own, as `checkWorkerPr` says it: the machine reason, kept as is for
 * logs and tests. `explainOwnershipBlocker` says each one to a person and to the agent.
 */
export const OWNERSHIP_BLOCKERS = {
  noWorkspace: "the worker no longer belongs to a workspace",
  worktreeGone: "its worktree is gone and the repo it belonged to was never recorded",
  repoNotInWorkspace: "its repo is no longer one of the worker's workspace projects",
  otherRepo: "its repository no longer matches the requested PR",
  stateUnknown: "its open state could not be verified",
  fork: "its head is from another repository",
  branchNotHeld: "its head branch is no longer a worktree branch held by this worker",
  headUnknown: "its head could not be verified",
  headMoved: "its head moved since the reviewed head was checked",
  unverified: "its ownership could not be verified",
} as const;

/** An ownership blocker in plain words (`reason`) and what an agent can do about it. */
export interface OwnershipExplanation {
  /** Finishes "Gram couldn't confirm this pull request is the worker's own: …". */
  readonly reason: string;
  /** What the worker can do so its next call goes through without the user. */
  readonly fix: string;
  /** The same, said to its orchestrator; `fix` when absent. */
  readonly orchestratorFix?: string;
  /** Once fixed, the PR is the worker's own and full auto covers it again. */
  readonly unblocks?: true;
}

const TRY_AGAIN = "Call again in a minute; if it keeps happening, the user has to approve it.";

const EXPLANATIONS: Record<string, OwnershipExplanation> = {
  [OWNERSHIP_BLOCKERS.noWorkspace]: {
    reason: "the worker no longer belongs to a workspace",
    fix: "Full auto covers workspace workers only, so the user has to approve this.",
  },
  [OWNERSHIP_BLOCKERS.worktreeGone]: {
    reason: "the worktree Gram gave the worker is gone, and its repository was never recorded",
    fix: "Ask your orchestrator to start a fresh worker for this pull request.",
    orchestratorFix: "Start a fresh worker for this pull request.",
    unblocks: true,
  },
  [OWNERSHIP_BLOCKERS.repoNotInWorkspace]: {
    reason: "its repository isn't a workspace project the worker has a worktree in",
    fix: "Open the pull request from the worktree Gram gave you; for a repository outside the workspace, the user has to add it or approve this.",
    orchestratorFix:
      "Have the worker open the pull request from the worktree Gram gave it, or start a worker in that repository's project; for a repository outside the workspace, the user has to add it or approve this.",
  },
  [OWNERSHIP_BLOCKERS.otherRepo]: {
    reason: "it is in another repository than the worktree Gram gave the worker",
    fix: "Open the pull request from the worktree Gram gave you, in its repository.",
    orchestratorFix:
      "Have the worker open the pull request from the worktree Gram gave it, in its repository.",
    unblocks: true,
  },
  [OWNERSHIP_BLOCKERS.stateUnknown]: {
    reason: "GitHub didn't say whether it is open",
    fix: TRY_AGAIN,
  },
  [OWNERSHIP_BLOCKERS.fork]: {
    reason: "its branch is on a fork, not in the repository itself",
    fix: "Push the branch to the repository from the worktree Gram gave you and open the pull request from there.",
    orchestratorFix:
      "Have the worker push the branch to the repository from the worktree Gram gave it and open the pull request from there.",
    unblocks: true,
  },
  [OWNERSHIP_BLOCKERS.branchNotHeld]: {
    reason: "its branch isn't checked out in a worktree Gram gave the worker",
    fix: "Check the branch out inside the worktree Gram gave you (or ask your orchestrator to start a fresh worker for the follow-up), then call again.",
    orchestratorFix:
      "Have the worker check the branch out inside the worktree Gram gave it, or start a fresh worker for the follow-up.",
    unblocks: true,
  },
  [OWNERSHIP_BLOCKERS.headUnknown]: {
    reason: "GitHub didn't say which commit its head is",
    fix: TRY_AGAIN,
  },
  [OWNERSHIP_BLOCKERS.headMoved]: {
    reason: "its head moved after Gram checked it",
    fix: "Call again so Gram checks the new head.",
  },
  [OWNERSHIP_BLOCKERS.unverified]: {
    reason: "Gram couldn't read the worker's worktree or the pull request on GitHub",
    fix: TRY_AGAIN,
  },
};

/** A blocker `checkWorkerPr` returned, in plain words and with what an agent can do about it. */
export const explainOwnershipBlocker = (blocker: string): OwnershipExplanation => {
  const known = EXPLANATIONS[blocker];
  if (known !== undefined) return known;
  const state = /^it is (\w+)$/.exec(blocker)?.[1];
  if (state !== undefined)
    return {
      reason: `it is ${state}, not open`,
      fix: "There is nothing to merge; check it with pr_status.",
    };
  return { reason: blocker, fix: TRY_AGAIN };
};

/** What `audience` can do about the blocker, and what Gram then does (`act`) without asking. */
export const ownershipFix = (
  blocker: string,
  audience: "worker" | "orchestrator",
  act = "merge it",
): string => {
  const { fix, orchestratorFix, unblocks } = explainOwnershipBlocker(blocker);
  return `${audience === "orchestrator" ? (orchestratorFix ?? fix) : fix}${unblocks ? ` Gram can then ${act} without asking.` : ""}`;
};

/**
 * The blocker as the calling agent reads it: why full auto didn't cover the call, and what it can
 * do so that the next one goes through without the user.
 */
export const ownershipForAgent = (
  blocker: string,
  audience: "worker" | "orchestrator",
  act?: string,
): string =>
  `Full auto covers only a worker's own pull request, and Gram couldn't confirm this one is the worker's own: ${explainOwnershipBlocker(blocker).reason}. ${ownershipFix(blocker, audience, act)}`;

/**
 * A card full auto would have skipped but for ownership, said to each who reads it (the app tools'
 * `AskedDespiteAutonomy`): `covers` finishes "Full auto …" and `approving` says what approving does.
 * `approvalActs: false` is for a tool that rechecks ownership after the card, so that approving it
 * does nothing: the agent is then told so, and never to wait on the user.
 */
export const ownershipAsk = (
  blocker: string,
  audience: "worker" | "orchestrator",
  covers: string,
  approving: string,
  act?: string,
  approvalActs = true,
) => {
  const { reason, unblocks } = explainOwnershipBlocker(blocker);
  const agent = approvalActs
    ? ownershipForAgent(blocker, audience, act)
    : `Full auto covers only a worker's own pull request, and Gram couldn't confirm this one is the worker's own: ${reason}. ${unblocks ? ownershipFix(blocker, audience, act) : "Call again later if this was a hiccup; otherwise rely on CI."} The user's approval doesn't change this: Gram refuses it for a pull request that isn't the worker's own.`;
  return {
    user: `Full auto ${covers} without asking, but Gram couldn't confirm this one is the worker's own: ${reason}. ${approving}`,
    agent,
    tag: `full auto, PR ownership unverified: ${reason}`,
  };
};

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
    if (thread.workspaceId === undefined) return OWNERSHIP_BLOCKERS.noWorkspace;
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
      return unrecorded ? OWNERSHIP_BLOCKERS.worktreeGone : OWNERSHIP_BLOCKERS.repoNotInWorkspace;
    const head = yield* prHead(cwd, number, repo);
    if (!sameRepo(head.repo, repo)) return OWNERSHIP_BLOCKERS.otherRepo;
    if (head.state !== "OPEN")
      return head.state === undefined
        ? OWNERSHIP_BLOCKERS.stateUnknown
        : `it is ${head.state.toLowerCase()}`;
    if (head.fork) return OWNERSHIP_BLOCKERS.fork;
    if (requireOwnedBranch && !branches.has(head.headRefName))
      return OWNERSHIP_BLOCKERS.branchNotHeld;
    if (reviewedHead !== undefined && head.headRefOid !== reviewedHead)
      return head.headRefOid === undefined
        ? OWNERSHIP_BLOCKERS.headUnknown
        : OWNERSHIP_BLOCKERS.headMoved;
    return { path: branches.get(head.headRefName) ?? cwd, branch: head.headRefName };
  }).pipe(Effect.catchCause(() => Effect.succeed(OWNERSHIP_BLOCKERS.unverified)));

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
