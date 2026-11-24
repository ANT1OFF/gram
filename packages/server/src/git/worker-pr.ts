import {
  type Checkout,
  hostOf,
  isLocalHost,
  LOCAL_HOST_ID,
  type Project,
  type Thread,
} from "@gram/contracts";
import { git, prHead, type Proc, realPathOrOwned, realPathSync, samePath } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { lstatSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { folderExists, ghFolderOf } from "../fs/folders.ts";
import { cloneUrlOf } from "../host/repos.ts";
import { WorkerHosts, type WorkerHostsShape } from "../host/worker-host.ts";
import { ThreadStore } from "../persistence/thread-store.ts";

const sameRepo = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

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
  originUnrecorded: "its worktree predates the record of the repository it was made from",
  otherThread: "another thread binds it or holds its branch",
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

const TRY_AGAIN = "Retry the ownership check; ask your orchestrator if it persists.";

const EXPLANATIONS: Record<string, OwnershipExplanation> = {
  [OWNERSHIP_BLOCKERS.noWorkspace]: {
    reason: "the worker no longer belongs to a workspace",
    fix: "Ask your orchestrator to start a worker in the repository's workspace.",
  },
  [OWNERSHIP_BLOCKERS.worktreeGone]: {
    reason: "the worktree Gram gave the worker is gone, and its repository was never recorded",
    fix: "Ask your orchestrator to start a fresh worker for this pull request.",
    orchestratorFix: "Start a fresh worker for this pull request.",
    unblocks: true,
  },
  [OWNERSHIP_BLOCKERS.repoNotInWorkspace]: {
    reason: "its repository isn't a workspace project the worker has a worktree in",
    fix: "Open the pull request from a worktree Gram gave you in a workspace project; ask your orchestrator to start the appropriate worker if needed.",
    orchestratorFix:
      "Have the worker open the pull request from the worktree Gram gave it in a workspace project, or start the appropriate worker there.",
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
    fix: "Retry pr_status to verify that the PR is open.",
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
    fix: "Retry pr_status to read the PR's head commit.",
  },
  [OWNERSHIP_BLOCKERS.headMoved]: {
    reason: "its head moved after Gram checked it",
    fix: "Call again so Gram checks the new head.",
  },
  [OWNERSHIP_BLOCKERS.unverified]: {
    reason: "Gram couldn't read the worker's worktree or the pull request on GitHub",
    fix: "Check that the worker's worktree is readable and GitHub is reachable, then retry; ask your orchestrator if it persists.",
  },
  [OWNERSHIP_BLOCKERS.machineUnconfirmed]: {
    reason:
      "the machine the worker runs on didn't confirm that the worktree Gram made there still has its branch and its repository",
    fix: "Keep the recorded branch and origin in the worktree Gram made on your machine, reconnect it with a current gram-host, then retry; ask your orchestrator if it persists.",
    orchestratorFix:
      "Have the worker keep the recorded branch and origin in its worktree, reconnect its machine with a current gram-host, then retry.",
  },
  [OWNERSHIP_BLOCKERS.otherThread]: {
    reason:
      "another thread has it as its pull request, or holds its branch in a worktree of its own, so it is that thread's work even where the worker has the branch checked out",
    fix: "Ask your orchestrator to merge it on the thread that holds this PR; checking out its branch doesn't transfer ownership. Retry if that thread's claim has changed.",
    orchestratorFix:
      "Merge it on the thread that holds this PR. Retry if that thread's claim has changed.",
  },
  [OWNERSHIP_BLOCKERS.cloneUnrecorded]: {
    reason:
      "the worktree Gram made on the worker's machine is older than Gram's record of which repository it cloned there",
    fix: "Ask your orchestrator to start a fresh worker for this pull request.",
    orchestratorFix: "Start a fresh worker for this pull request.",
    unblocks: true,
  },
  [OWNERSHIP_BLOCKERS.originUnrecorded]: {
    reason:
      "the worktree Gram gave the worker is older than Gram's record of which repository it was made from",
    fix: "Ask your orchestrator to start a fresh worker for this pull request.",
    orchestratorFix: "Start a fresh worker for this pull request.",
    unblocks: true,
  },
};

/** A blocker `checkWorkerPr` returned, in plain words and with what an agent can do about it. */
export const explainOwnershipBlocker = (blocker: string): OwnershipExplanation => {
  const known = Object.hasOwn(EXPLANATIONS, blocker) ? EXPLANATIONS[blocker] : undefined;
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

/** An ownership doubt at full autonomy is the agent's to resolve, never an approval request. */
export const ownershipRefusalText = (
  blocker: string,
  audience: "worker" | "orchestrator",
  tool: string,
): string => {
  const explanation = explainOwnershipBlocker(blocker);
  const fix =
    audience === "orchestrator"
      ? (explanation.orchestratorFix ?? explanation.fix)
      : explanation.fix;
  return `Full auto covers only a worker's own pull request, and Gram couldn't confirm this one is the worker's own: ${explanation.reason}. ${fix} Then call ${tool} again so Gram verifies ownership. The call was refused; the user wasn't asked.`;
};

const heldWorktrees = (thread: Thread) =>
  [thread.checkout, ...(thread.extraCheckouts ?? [])].filter(
    (checkout) => checkout.kind === "worktree",
  );

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

const originUrlOf = (at: string) =>
  git(at, ["config", "--get", "remote.origin.url"], { timeoutMs: 2_000 }).pipe(
    Effect.map((out) => (out.status === 0 ? out.stdout.trim() || undefined : undefined)),
    Effect.orElseSucceed(() => undefined),
  );

/** What a local folder's HEAD is right now, as `liveHeadAt` reads it. */
export type LiveHead =
  | { readonly kind: "branch"; readonly name: string }
  | { readonly kind: "detached" }
  | { readonly kind: "no-repository" }
  | { readonly kind: "unknown" };

const noGitMarkersAbove = (path: string): boolean => {
  try {
    let at = realPathSync(path);
    for (;;) {
      if (!statSync(at).isDirectory()) return false;
      for (const marker of [".git", "HEAD", "objects", "refs", "config", "commondir"])
        if (lstatSync(join(at, marker), { throwIfNoEntry: false }) !== undefined) return false;
      const parent = dirname(at);
      if (parent === at) return true;
      at = parent;
    }
  } catch {
    return false;
  }
};

/**
 * A local folder's HEAD read now: its branch, a verified detached HEAD, no repository, or `unknown`
 * when it can't be told. A conflict check reads this so a branch a sibling switched or renamed to,
 * which the publisher may not have sampled onto its recorded checkout, is still seen as
 * held; `unknown` is never read as "holds nothing". Another machine's folder is never read live.
 */
export const liveHeadAt = (path: string): Effect.Effect<LiveHead, never, Proc> =>
  Effect.gen(function* () {
    if (!(yield* folderExists(path))) return { kind: "unknown" } as const;
    const out = yield* git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      timeoutMs: 2_000,
    });
    const name = out.stdout.trim();
    if (out.status === 0 && !out.truncated && name !== "") return { kind: "branch", name } as const;
    if (out.status === 1 && out.stderr.trim() === "") return { kind: "detached" } as const;
    if (out.status === 128 && !out.truncated) {
      const probe = yield* git(path, ["rev-parse", "--git-dir"], {
        timeoutMs: 2_000,
        env: { LC_ALL: "C", LANGUAGE: "C", GIT_DISCOVERY_ACROSS_FILESYSTEM: "1" },
      });
      if (
        probe.status === 128 &&
        !probe.truncated &&
        probe.stdout.trim() === "" &&
        probe.stderr.trim() ===
          "fatal: not a git repository (or any of the parent directories): .git" &&
        noGitMarkersAbove(path)
      )
        return { kind: "no-repository" } as const;
    }
    return { kind: "unknown" } as const;
  }).pipe(Effect.orElseSucceed(() => ({ kind: "unknown" }) as const));

const projectOfClone = (
  checkout: Checkout,
  projects: ReadonlyArray<Project>,
  repo: string,
): Project | undefined => {
  const clone = checkout.cloneIdentity;
  if (clone === undefined || !mayNameRepo(cloneUrlOf(clone), repo)) return undefined;
  return projects.find(
    (project) =>
      project.originIdentity !== undefined && mayNameRepo(cloneUrlOf(project.originIdentity), repo),
  );
};

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

const GITHUB_HOSTS: ReadonlyMap<string, { readonly https: string; readonly ssh: string }> = new Map(
  [
    ["github.com", { https: "443", ssh: "22" }],
    ["www.github.com", { https: "443", ssh: "22" }],
    ["ssh.github.com", { https: "443", ssh: "443" }],
  ],
);
const PLAIN_NAME = /^[A-Za-z0-9._-]+$/;
const PLAIN_HOST = /^[A-Za-z0-9.-]+$/;
const GIT_SUFFIX = /\.git$/i;

/** The repository a remote URL names, as `remoteRepoOf` reads it. */
export interface RemoteRepo {
  /** `ssh` for an scp-style URL too. */
  readonly transport: "https" | "ssh";
  /** Lowercased. */
  readonly host: string;
  /** The port it names; the transport's default (`443`, `22`) when it names none. */
  readonly port: string;
  readonly owner: string;
  /** Without its `.git` suffix. */
  readonly name: string;
}

/**
 * The one reading of a remote (a local `origin`, or the URL of a clone identity Gram recorded)
 * as a repository, for both questions asked of it: whether it is the PR's repository (ownership,
 * `remoteNamesRepo`) and whether it is plainly another one (conflict, `remoteNamesOtherRepo`).
 * Reading both from one parse is what keeps them from disagreeing.
 *
 * Strict: an https URL (credentials allowed), an ssh URL or an scp-style address, with a plain
 * host and port, and a path of exactly an owner and a repository, each a plain GitHub name
 * (`[A-Za-z0-9._-]`, the owner without a dot at either end; one `.git` suffix in any case
 * dropped). ASCII only, with no `%`, query, fragment, backslash or further segment. `undefined`
 * for anything else, which names no repository: it is never the PR's, nor plainly another.
 */
export const remoteRepoOf = (url: string): RemoteRepo | undefined => {
  if (!/^[\x21-\x7e]+$/.test(url) || /[%?#\\]/.test(url)) return undefined;
  const https = /^https:\/\/(?:[^/@]+@)?([^/@:]+)(?::(\d+))?\/([^/]+)\/([^/]+?)\/?$/.exec(url);
  const ssh =
    https === null
      ? /^ssh:\/\/(?:[A-Za-z0-9._-]+@)?([^/@:]+)(?::(\d+))?\/([^/]+)\/([^/]+?)\/?$/.exec(url)
      : null;
  const scp =
    https === null && ssh === null
      ? /^(?:[A-Za-z0-9._-]+@)?([^/@:]+):()([^/]+)\/([^/]+?)\/?$/.exec(url)
      : null;
  const parts = https ?? ssh ?? scp;
  if (parts === null) return undefined;
  const [, rawHost = "", rawPort = "", owner = "", rawName = ""] = parts;
  const transport = https === null ? "ssh" : "https";
  if (!PLAIN_HOST.test(rawHost) || rawHost.startsWith(".") || rawHost.endsWith("."))
    return undefined;
  const name = rawName.replace(GIT_SUFFIX, "");
  if (
    !PLAIN_NAME.test(owner) ||
    owner.startsWith(".") ||
    owner.endsWith(".") ||
    !PLAIN_NAME.test(name) ||
    name === "." ||
    name === ".." ||
    GIT_SUFFIX.test(name)
  )
    return undefined;
  return {
    transport,
    host: rawHost.toLowerCase(),
    port: rawPort === "" ? (transport === "https" ? "443" : "22") : rawPort,
    owner,
    name,
  };
};

/**
 * The host a pull request's URL (as `gh` gives it) is on, lowercased: `github.com`, or the
 * Enterprise host `gh` is configured for. `undefined` for a URL it can't plainly read.
 */
export const prHostOf = (url: string): string | undefined => {
  const host = /^https:\/\/([A-Za-z0-9.-]+)(?::\d+)?\//.exec(url)?.[1];
  return host === undefined || host.startsWith(".") || host.endsWith(".")
    ? undefined
    : host.toLowerCase();
};

const onPrHost = (remoteHost: string, prHost: string): boolean =>
  GITHUB_HOSTS.has(prHost) ? GITHUB_HOSTS.has(remoteHost) : remoteHost === prHost;

/**
 * Whether the remote `url` is `repo` on the host of its PR (`prHost`, `prHostOf`'s): what
 * ownership asks of a worker's folder. The owner, the repository and the host must all match.
 */
export const remoteNamesRepo = (url: string | undefined, repo: string, prHost: string): boolean => {
  const named = url === undefined ? undefined : remoteRepoOf(url);
  return (
    named !== undefined &&
    sameRepo(`${named.owner}/${named.name}`, repo) &&
    onPrHost(named.host, prHost)
  );
};

const mayNameRepo = (url: string | undefined, repo: string): boolean => {
  const named = url === undefined ? undefined : remoteRepoOf(url);
  return named !== undefined && sameRepo(`${named.owner}/${named.name}`, repo);
};

/**
 * Whether the remote `url` plainly names a repository other than `repo`, on GitHub's own host and
 * its default port: enough to rule out a branch claim in that repository.
 * It is never true where `remoteNamesRepo` is.
 */
export const remoteNamesOtherRepo = (url: string | undefined, repo: string): boolean => {
  const named = url === undefined ? undefined : remoteRepoOf(url);
  if (named === undefined) return false;
  const host = GITHUB_HOSTS.get(named.host);
  return (
    host !== undefined &&
    named.port === host[named.transport] &&
    !sameRepo(`${named.owner}/${named.name}`, repo)
  );
};

const remoteUrlOf = (checkout: Checkout) =>
  Effect.gen(function* () {
    if (checkout.cloneIdentity !== undefined) return cloneUrlOf(checkout.cloneIdentity);
    if (!isLocalHost(checkout)) return undefined;
    const at = (yield* folderExists(checkout.path)) ? checkout.path : checkout.repoRoot;
    return at === undefined ? undefined : yield* originUrlOf(at);
  });

const mayHoldRepo = (checkout: Checkout, repo: string) =>
  remoteUrlOf(checkout).pipe(
    Effect.map((url) => !remoteNamesOtherRepo(url, repo)),
    Effect.orElseSucceed(() => true),
  );

const claimedByAnother = (
  thread: Thread,
  repo: string,
  number: number,
  branch: string,
  where: Checkout,
) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const { threads, unknown } = yield* store.listThreadsForClaims;
    if (unknown.some((id) => id !== thread.id)) return true;
    for (const other of threads) {
      if (other.id === thread.id || other.parked) continue;
      const bound = other.boundPr;
      if (bound !== undefined && sameRepo(bound.repo, repo) && bound.number === number) return true;
      for (const checkout of [other.checkout, ...(other.extraCheckouts ?? [])]) {
        if (sameCheckout(checkout, where)) continue;
        let holds =
          checkout.branch === branch ||
          (other.ownedBranches ?? []).some(
            (owned) => samePath(owned.path, checkout.path) && owned.branch === branch,
          );
        if (!holds && isLocalHost(checkout)) {
          const live = yield* liveHeadAt(checkout.path);
          holds = live.kind === "unknown" || (live.kind === "branch" && live.name === branch);
        }
        if (holds && (yield* mayHoldRepo(checkout, repo))) return true;
      }
    }
    return false;
  });

const checkWorkerPr = (
  thread: Thread,
  repo: string,
  number: number,
  reviewedHead?: string,
  requireOwnedBranch = true,
) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const hosts = Option.getOrUndefined(yield* Effect.serviceOption(WorkerHosts));
    if (thread.workspaceId === undefined) return OWNERSHIP_BLOCKERS.noWorkspace;
    const { workspace } = yield* store.getWorkspace(thread.workspaceId);
    const projects = (yield* store.listProjects).filter((project) =>
      workspace.projectIds.includes(project.id),
    );
    const roots = new Set(
      yield* Effect.forEach(projects, (project) => canonical(project.repoRoot ?? project.root)),
    );
    const branches = new Map<string, Checkout>();
    let cwd: string | undefined;
    let held: Checkout | undefined;
    let unrecorded = false;
    let unconfirmed = false;
    let unrecordedClone = false;
    let unrecordedOrigin = false;
    for (const checkout of heldWorktrees(thread)) {
      if (!isLocalHost(checkout)) {
        if (checkout.repoRoot === undefined || checkout.branch === undefined) continue;
        if (checkout.cloneIdentity === undefined) {
          unrecordedClone = true;
          continue;
        }
        if (projectOfClone(checkout, projects, repo) === undefined) continue;
        if (!(yield* machineConfirms(hosts, checkout, checkout.repoRoot, checkout.branch))) {
          unconfirmed = true;
          continue;
        }
        branches.set(checkout.branch, checkout);
        cwd ??= yield* ghFolderOf(checkout);
        held ??= checkout;
        continue;
      }
      const present = yield* folderExists(checkout.path);
      const at = present ? checkout.path : checkout.repoRoot;
      if (at === undefined) {
        unrecorded = true;
        continue;
      }
      if (!roots.has(yield* canonical(checkout.repoRoot ?? checkout.path))) continue;
      if (checkout.cloneIdentity === undefined) {
        unrecordedOrigin = true;
        continue;
      }
      if (!mayNameRepo(cloneUrlOf(checkout.cloneIdentity), repo)) continue;
      if (checkout.branch !== undefined) branches.set(checkout.branch, checkout);
      for (const owned of ownedIn(thread, checkout)) branches.set(owned, checkout);
      if (present) {
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
          : unrecordedOrigin
            ? OWNERSHIP_BLOCKERS.originUnrecorded
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
          : unrecordedOrigin
            ? OWNERSHIP_BLOCKERS.originUnrecorded
            : OWNERSHIP_BLOCKERS.branchNotHeld;
    if (reviewedHead !== undefined && head.headRefOid !== reviewedHead)
      return head.headRefOid === undefined
        ? OWNERSHIP_BLOCKERS.headUnknown
        : OWNERSHIP_BLOCKERS.headMoved;
    const where = branches.get(head.headRefName) ?? held;
    const prHost = prHostOf(head.url);
    if (prHost === undefined) return OWNERSHIP_BLOCKERS.unverified;
    if (!remoteNamesRepo(yield* remoteUrlOf(where), repo, prHost))
      return OWNERSHIP_BLOCKERS.otherRepo;
    if (yield* claimedByAnother(thread, repo, number, head.headRefName, where))
      return OWNERSHIP_BLOCKERS.otherThread;
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

/**
 * Whether the PR the worker owned as `owned` (`workerPrOwnership`'s answer) no longer stands as
 * its own, for a recheck after a provider read: the folder is no longer held, its remote no longer
 * names the PR's repository on the PR's host (`prHost`), or another thread now claims it. Local
 * git and the store only, no GitHub read. A doubt is a yes.
 */
export const ownedPrNoLongerStands = (
  thread: Thread,
  repo: string,
  number: number,
  owned: { readonly path: string; readonly hostId?: string | undefined; readonly branch: string },
  prHost: string | undefined,
) =>
  Effect.gen(function* () {
    if (prHost === undefined) return true;
    const where = heldWorktrees(thread).find(
      (checkout) =>
        samePath(checkout.path, owned.path) &&
        (owned.hostId === undefined ? isLocalHost(checkout) : hostOf(checkout) === owned.hostId),
    );
    if (where === undefined) return true;
    if (!remoteNamesRepo(yield* remoteUrlOf(where), repo, prHost)) return true;
    return yield* claimedByAnother(thread, repo, number, owned.branch, where);
  }).pipe(Effect.catchCause(() => Effect.succeed(true)));

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

const SAFE_BRANCH = /^[\w./-]{1,200}$/;

const heldByAnother = (thread: Thread, repo: string, number: number, branch: string) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const pr = { repo, number };
    const same = (other: { readonly repo: string; readonly number: number }) =>
      sameRepo(other.repo, pr.repo) && other.number === pr.number;
    return (yield* store.listThreads).some(
      (other) =>
        other.id !== thread.id &&
        ((other.boundPr !== undefined && same(other.boundPr)) ||
          (other.extraPrs ?? []).some(same) ||
          [other.checkout, ...(other.extraCheckouts ?? [])].some(
            (checkout) => checkout.branch === branch,
          ) ||
          (other.ownedBranches ?? []).some((owned) => owned.branch === branch)),
    );
  });

const checkedOutElsewhere = (here: string, branch: string) =>
  Effect.gen(function* () {
    const out = yield* git(here, ["worktree", "list", "--porcelain"], { timeoutMs: 5_000 });
    if (out.status !== 0) return true;
    const self = yield* canonical(here);
    for (const block of out.stdout.split(/\n\s*\n/)) {
      const lines = block.split("\n");
      const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
      if (path === undefined || !lines.includes(`branch refs/heads/${branch}`)) continue;
      if ((yield* canonical(path)) !== self) return true;
    }
    return false;
  }).pipe(Effect.orElseSucceed(() => true));

/** The refusal for a merge call on a PR that is merged or closed: there is nothing to merge. */
export const endedPrText = (repo: string, number: number, state: "merged" | "closed") =>
  `${repo}#${number} is ${state}, so there is nothing to merge; check it with pr_status. Nobody was asked.`;

/**
 * At `full` autonomy, every ownership doubt returns a refusal to the calling agent instead of
 * a user card, never widening what is owned. More specific guidance where it is safe:
 *
 * - its head branch isn't held in the worker's worktree, no other thread follows or holds it, and
 *   no other git worktree has it checked out (a deploy PR a release script opened from a scratch
 *   worktree it then removed, say): the agent is told to check it out there and call again, which
 *   then goes through without the user.
 *
 * - it is merged or closed: there is nothing to merge (`endedPrText`).
 *
 * Every other ownership blocker is refused with repair guidance too. `undefined` only when
 * ownership is verified. The caller has already established the full-autonomy delegation.
 */
export const ownershipRefusal = (
  thread: Thread,
  repo: string,
  number: number,
  options: {
    readonly audience: "worker" | "orchestrator";
    /** The tool to call again. */
    readonly tool: string;
    /** What Gram then does without asking, as in "Gram then merges it without asking". */
    readonly action: string;
  },
) =>
  Effect.gen(function* () {
    const ownership = yield* workerPrOwnership(thread, repo, number);
    if (typeof ownership !== "string") return undefined;
    const state =
      ownership === "it is merged" ? "merged" : ownership === "it is closed" ? "closed" : undefined;
    if (state !== undefined) return endedPrText(repo, number, state);
    const refusal = ownershipRefusalText(ownership, options.audience, options.tool);
    if (options.audience === "worker" && thread.boundPr?.mergeWhenReady?.heldBy === "orchestrator")
      return refusal;
    if (ownership !== OWNERSHIP_BLOCKERS.branchNotHeld || !isLocalHost(thread.checkout))
      return refusal;
    const here = thread.checkout.path;
    if (thread.checkout.kind !== "worktree" || !(yield* folderExists(here))) return refusal;
    const head = yield* prHead(here, number, repo);
    const branch = head.headRefName;
    if (!SAFE_BRANCH.test(branch) || branch.startsWith("-") || head.fork) return refusal;
    if (yield* heldByAnother(thread, repo, number, branch)) return refusal;
    if (yield* checkedOutElsewhere(here, branch)) return refusal;
    const steps = `\`git fetch origin ${branch}\` then \`git switch ${branch}\``;
    const fix =
      options.audience === "worker"
        ? `Check it out in the worktree Gram gave you (${steps}; commit your own work first), then call ${options.tool} again`
        : `Have the worker check it out in the worktree Gram gave it (${steps}), then call ${options.tool} again`;
    return `Full auto covers only a worker's own pull request: one whose head branch is checked out in the worktree Gram gave the worker. ${repo}#${number}'s head branch \`${branch}\` isn't checked out there. ${fix}; Gram then ${options.action} without asking. That holds only while no other thread has it as its pull request or holds its branch: checking out another thread's branch never makes it yours. The user wasn't asked, and their approval isn't the way through for this.`;
  }).pipe(
    Effect.timeoutOrElse({
      duration: "4 seconds",
      orElse: () =>
        Effect.succeed(
          ownershipRefusalText(OWNERSHIP_BLOCKERS.unverified, options.audience, options.tool),
        ),
    }),
    Effect.catchCause(() =>
      Effect.succeed(
        ownershipRefusalText(OWNERSHIP_BLOCKERS.unverified, options.audience, options.tool),
      ),
    ),
  );
