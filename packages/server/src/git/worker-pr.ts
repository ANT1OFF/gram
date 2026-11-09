// Whether a pull request is a worker's own, the one thing the `full`-autonomy merge delegation
// covers. One check for every place that merges without a card: the
// tools' gate, their recheck in `handle`, and `merge_when_ready`'s launch, which can come long after.

import {
  type Checkout,
  hostOf,
  isLocalHost,
  LOCAL_HOST_ID,
  type Project,
  type Thread,
} from "@gram/contracts";
import { git, originOwnerRepo, prHead, type Proc, realPathOrOwned, samePath } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { folderExists, ghFolderOf } from "../fs/folders.ts";
import { cloneIdentityOf } from "../host/repos.ts";
import { WorkerHosts, type WorkerHostsShape } from "../host/worker-host.ts";
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
  machineUnconfirmed: "its machine did not confirm the worktree Gram made there",
  cloneUnrecorded: "its worktree on another machine predates the record of its clone",
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
  [OWNERSHIP_BLOCKERS.machineUnconfirmed]: {
    reason:
      "the machine the worker runs on didn't confirm that the worktree Gram made there still has its branch and its repository",
    fix: "Keep the branch Gram gave you checked out in that worktree, with its origin unchanged, and call again. If the machine is offline or its gram-host is out of date, the user has to approve this.",
    orchestratorFix:
      "Have the worker keep the branch Gram gave it checked out in that worktree, with its origin unchanged. If the machine is offline or its gram-host is out of date, the user has to approve this.",
  },
  [OWNERSHIP_BLOCKERS.cloneUnrecorded]: {
    reason:
      "the worktree Gram made on the worker's machine is older than Gram's record of which repository it cloned there",
    fix: "Ask your orchestrator to start a fresh worker for this pull request.",
    orchestratorFix: "Start a fresh worker for this pull request.",
    unblocks: true,
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

/** The worktrees Gram gave the thread: never one it follows (`currentCheckout`). */
const heldWorktrees = (thread: Thread) =>
  [thread.checkout, ...(thread.extraCheckouts ?? [])].filter(
    (checkout) => checkout.kind === "worktree",
  );

/** Whether `a` and `b` are one folder on one machine: a path alone is two machines' at once. */
const sameCheckout = (a: Pick<Checkout, "path" | "hostId">, b: Pick<Checkout, "path" | "hostId">) =>
  hostOf(a) === hostOf(b) && samePath(a.path, b.path);

/**
 * Remember a branch only when observed in a worktree this worker holds on this machine, never one
 * it follows, and never one another machine reports: there, only what Gram recorded as it made
 * the worktree counts (`checkWorkerPr`). Recorded with its machine, so another machine's folder
 * at the same path never inherits it.
 */
export const withOwnedBranch = (
  thread: Thread,
  observed: Pick<Checkout, "path" | "hostId">,
  branch: string | undefined,
): Thread => {
  if (
    thread.spawnedBy === undefined ||
    branch === undefined ||
    !isLocalHost(observed) ||
    !heldWorktrees(thread).some((checkout) => sameCheckout(checkout, observed)) ||
    thread.ownedBranches?.some(
      (owned) =>
        owned.hostId === LOCAL_HOST_ID &&
        samePath(owned.path, observed.path) &&
        owned.branch === branch,
    )
  )
    return thread;
  return {
    ...thread,
    ownedBranches: [
      ...(thread.ownedBranches ?? []),
      { path: observed.path, branch, hostId: LOCAL_HOST_ID },
    ],
  };
};

/**
 * The branches recorded as observed in `checkout`, a held worktree on this machine. One recorded
 * before entries named their machine counts only while no folder the thread has on another
 * machine shares its path, since it can't say on which of them it was seen.
 */
const ownedIn = (thread: Thread, checkout: Checkout): ReadonlyArray<string> => {
  const elsewhere = [
    thread.checkout,
    ...(thread.currentCheckout === undefined ? [] : [thread.currentCheckout]),
    ...(thread.extraCheckouts ?? []),
  ].some((other) => !isLocalHost(other) && samePath(other.path, checkout.path));
  return (thread.ownedBranches ?? [])
    .filter(
      (owned) =>
        samePath(owned.path, checkout.path) &&
        (owned.hostId === undefined ? !elsewhere : owned.hostId === LOCAL_HOST_ID),
    )
    .map((owned) => owned.branch);
};

/**
 * The workspace project a worktree on another machine was made for, from what this machine
 * recorded as it made it: the identity of the origin it cloned (`cloneIdentity`), which must be
 * the identity of the project's origin here, a project whose origin is the PR's repository.
 */
const projectOfClone = (
  checkout: Checkout,
  projects: ReadonlyArray<Project>,
  repo: string,
): Effect.Effect<Project | undefined, never, Proc> =>
  Effect.gen(function* () {
    if (checkout.cloneIdentity === undefined) return undefined;
    for (const project of projects) {
      const root = project.repoRoot ?? project.root;
      if (!sameRepo(yield* originOwnerRepo(root), repo)) continue;
      const out = yield* git(root, ["remote", "get-url", "origin"], { timeoutMs: 2_000 }).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (out === undefined || out.status !== 0) continue;
      if (cloneIdentityOf(out.stdout.trim()) === checkout.cloneIdentity) return project;
    }
    return undefined;
  });

/**
 * Whether the machine `checkout` is on confirms what this machine recorded as it made it: the
 * worktree still shares the clone's repository, its origin has the recorded identity, and the
 * recorded branch is checked out. Asked of that machine by its id (`hostOf`), never by the path,
 * which another machine can share. Its answer only ever confirms: a host that is offline, too old
 * to say, or says anything else leaves the worktree unconfirmed.
 */
const machineConfirms = (
  hosts: WorkerHostsShape | undefined,
  checkout: Checkout,
  repoRoot: string,
  branch: string,
) =>
  hosts === undefined
    ? Effect.succeed(false)
    : hosts.get(hostOf(checkout)).pipe(
        Effect.flatMap((host) =>
          host.identify === undefined
            ? Effect.succeed(false)
            : host
                .identify(repoRoot, checkout.path)
                .pipe(
                  Effect.map(
                    (there) =>
                      there.ofClone &&
                      there.identity === checkout.cloneIdentity &&
                      there.branch === branch,
                  ),
                ),
        ),
        Effect.orElseSucceed(() => false),
      );

/**
 * The verified held path and branch of the worker's open, non-fork PR, else why it is not owned.
 * The held worktree must still belong to a workspace project. Read-only, so the tool's gate can
 * call it repeatedly; arming persists the verified branch with the intent. GitHub supplies the head
 * on every call, asked from the repo's main checkout when the worktree's folder is gone. A doubt is a refusal; `reviewedHead`, when given, must still be its head.
 *
 * A worktree Gram made on another machine counts from what this machine recorded as it made it,
 * never from what that machine says: its machine, the identity of the origin it cloned, which
 * must be a workspace project's origin here (`projectOfClone`), and its branch, the only one it
 * can own. Its host only confirms that record (`machineConfirms`); until it does (it is offline,
 * too old to say, or says otherwise), the worktree confirms nothing, and the check says it couldn't
 * verify rather than that the PR isn't the worker's.
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
    // Present wherever a worker can be on another machine; without it, such a worktree fails closed.
    const hosts = Option.getOrUndefined(yield* Effect.serviceOption(WorkerHosts));
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
    const branches = new Map<string, Checkout>();
    /** Where `gh` starts for the PR, which it names with `--repo`. */
    let cwd: string | undefined;
    /** The held checkout when GitHub's head branch is among none of `branches`. */
    let held: Checkout | undefined;
    let unrecorded = false;
    /** A worktree on another machine of the PR's project that its machine didn't confirm. */
    let unconfirmed = false;
    /** A worktree on another machine made before its clone's identity was recorded. */
    let unrecordedClone = false;
    for (const checkout of heldWorktrees(thread)) {
      if (!isLocalHost(checkout)) {
        if (checkout.repoRoot === undefined || checkout.branch === undefined) continue;
        // Made before its clone's identity was recorded: nothing here says which project it is.
        if (checkout.cloneIdentity === undefined) {
          unrecordedClone = true;
          continue;
        }
        if ((yield* projectOfClone(checkout, projects, repo)) === undefined) continue;
        if (!(yield* machineConfirms(hosts, checkout, checkout.repoRoot, checkout.branch))) {
          unconfirmed = true;
          continue;
        }
        branches.set(checkout.branch, checkout);
        cwd ??= yield* ghFolderOf(checkout);
        held ??= checkout;
        continue;
      }
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
      if (checkout.branch !== undefined) branches.set(checkout.branch, checkout);
      for (const owned of ownedIn(thread, checkout)) branches.set(owned, checkout);
      if (present) {
        // A tool can arrive before the watcher sees a branch created immediately before gh pr
        // create.
        const local = yield* git(checkout.path, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
          timeoutMs: 2_000,
        });
        const observed = local.status === 0 ? local.stdout.trim() || undefined : undefined;
        if (observed !== undefined) branches.set(observed, checkout);
      }
      cwd ??= at;
      held ??= present ? checkout : { ...checkout, path: at };
    }
    if (cwd === undefined || held === undefined)
      return unconfirmed
        ? OWNERSHIP_BLOCKERS.machineUnconfirmed
        : unrecordedClone
          ? OWNERSHIP_BLOCKERS.cloneUnrecorded
          : unrecorded
            ? OWNERSHIP_BLOCKERS.worktreeGone
            : OWNERSHIP_BLOCKERS.repoNotInWorkspace;
    const head = yield* prHead(cwd, number, repo);
    if (!sameRepo(head.repo, repo)) return OWNERSHIP_BLOCKERS.otherRepo;
    if (head.state !== "OPEN")
      return head.state === undefined
        ? OWNERSHIP_BLOCKERS.stateUnknown
        : `it is ${head.state.toLowerCase()}`;
    if (head.fork) return OWNERSHIP_BLOCKERS.fork;
    if (requireOwnedBranch && !branches.has(head.headRefName))
      return unconfirmed
        ? OWNERSHIP_BLOCKERS.machineUnconfirmed
        : unrecordedClone
          ? OWNERSHIP_BLOCKERS.cloneUnrecorded
          : OWNERSHIP_BLOCKERS.branchNotHeld;
    if (reviewedHead !== undefined && head.headRefOid !== reviewedHead)
      return head.headRefOid === undefined
        ? OWNERSHIP_BLOCKERS.headUnknown
        : OWNERSHIP_BLOCKERS.headMoved;
    const where = branches.get(head.headRefName) ?? held;
    return {
      path: where.path,
      ...(isLocalHost(where) ? {} : { hostId: hostOf(where) }),
      branch: head.headRefName,
    };
  }).pipe(Effect.catchCause(() => Effect.succeed(OWNERSHIP_BLOCKERS.unverified)));

/**
 * Hands the ownership check the server's machines, when there are any: `checkWorkerPr` reads a
 * joined machine's worktree through them, and fails closed for one without them.
 */
export const withMachines =
  (hosts: WorkerHostsShape | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    hosts === undefined ? effect : Effect.provideService(effect, WorkerHosts, hosts);

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
