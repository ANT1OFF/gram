// The worktree sweep: a pass, on unless turned off, that frees finished threads' `node_modules` once
// they have sat for `freeAfterDays`, and closes the thread with its worktree after `removeAfterDays`,
// or `MERGED_GRACE_MS` after its PR merged. Every thread kind but an orchestrator: a worker once the
// ledger reads it finished, any other thread once it is archived or its PRs are all merged or closed.
// An archived worker with no PR of its own (a reviewer, a research or release worker) goes
// `ARCHIVED_GRACE_MS` after its last activity, once clean, pushed and with no PR open for its branch.
//
// Invariants. It only ever looks at a finished thread at rest with nothing waiting on the user, in a
// linked worktree no other thread holds, and never at a main checkout or at a worker spanning
// repos. Before either step, git is asked afresh: a worktree with uncommitted changes, or whose HEAD
// no remote has, is left alone; one whose folder was deleted outside Gram has nothing left to lose,
// and is removed (its registration pruned) once due. Last, right before either step, no process
// may work inside it (`processInside`): an agent, a dev server or a shell the threads don't know
// about keeps it, and so does a platform or a scan that can't tell.
// Removal also needs the PR merged or closed (for an archived worker with none, no PR open), goes
// through `closeAtRest` (the app's own close, which refuses a dirty tree, a thread that got busy or a
// terminal running a command, and removes on the `slow` tier), and never deletes a branch. It logs counts, never paths, and tells each workspace one digest line.
//
// Known and accepted gap. Whether another thread holds or follows the worktree, or a process works
// in it, is read last right before the deletion, not held across it: an agent elsewhere that moves into this worktree while
// `freeNodeModules` or `git worktree remove` is still running can lose `node_modules` (back with
// `pnpm install`) or the checked-out tree, whose work passed the clean-and-pushed check. Taking a
// worktree days after its last activity makes that rare, and closing it needs a checkout lock
// that serializes `setCurrentCheckout`, worktree moves, creation and removal across a repo's
// threads, which is a follow-up of its own (the same family as the archive race), not this sweep.

import type { Dirent } from "node:fs";
import { lstat, readdir, readlink, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import {
  combinePrFacts,
  FINISHED_STATES,
  headPushed,
  mergedAndDone,
  prFactsOf,
  reopenedSinceMerge,
  worktreeSweepOf,
  type GitState,
  type PrStatus,
  type Thread,
  type ThreadStatus,
  type WorkspaceId,
  type WorktreeSweep,
} from "@gram/contracts";
import { git, isInside, Pr, Proc, realPathOrOwned, samePath } from "@gram/git";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { folderExists } from "../fs/folders.ts";
import { asBackground } from "../github/budget.ts";
import { workerState } from "../orchestration/rules.ts";
import { canOpenPr, workerPrBadges } from "../orchestration/ledger.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { usedCheckoutPaths } from "../runtime/create-in-checkout.ts";
import { ThreadPorts } from "../ports/service.ts";
import { closeAtRest } from "../runtime/close-at-rest.ts";
import { ThreadRuntimes, type ClaimGuard } from "../runtime/thread-runtimes.ts";
import { TerminalGate } from "../terminal/gate.ts";
import { Orchestration } from "../orchestration/service.ts";
import { GitStatePublisher } from "./publisher.ts";
import { cleanupNotes, underWorktreesFolder, type Cleaned } from "./storage.ts";
import { cachedFolderSize, forgetFolderSize } from "./worktree-size.ts";
import { DAY_MS } from "../zone-time.ts";

/** Statuses of a thread that isn't doing anything and won't until someone writes to it. */
const AT_REST: ReadonlySet<ThreadStatus> = new Set<ThreadStatus>(["cold", "idle", "ended"]);

/** Folders the search for `node_modules` never enters: git's, nested worktrees, and deps. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([".git", ".worktrees", "node_modules"]);

/** How deep under the worktree a `node_modules` is looked for: `apps/web/node_modules` is 2. */
const NODE_MODULES_DEPTH = 3;

/** What the sweep knows about one thread before asking git anything. */
export interface SweepFacts {
  readonly thread: Thread;
  readonly status: ThreadStatus;
  readonly pendingRequests: number;
  /** Background tasks, subagents or terminal programs still run in it, whatever the status says. */
  readonly busy: boolean;
  /** The publisher's cached state and badge; either may be absent for an archived worker. */
  readonly git: GitState | undefined;
  readonly badge: PrStatus | undefined;
  /** The badges of its `extraPrs` as the publisher last sent them; absent counts each as unknown. */
  readonly extraBadges?: ReadonlyArray<PrStatus> | undefined;
  /** Its bound PRs GitHub says don't exist (`GitState.missingPrs`). */
  readonly missingPrs?: GitState["missingPrs"] | undefined;
  /** Every checkout the other threads hold or follow (`othersCheckouts`). */
  readonly heldByOthers: ReadonlyArray<string>;
}

/**
 * Whether the ledger reads the worker as finished (`FINISHED_STATES`: delivered, merged or
 * archived), from the facts the sweep has. Its reports live in the orchestration outbox, which the
 * sweep doesn't read, so a worker that only reported done reads as not finished: the safe side.
 * The one place the sweep decides "finished", so a shared predicate can replace it.
 */
const isFinishedWorker = (facts: SweepFacts): boolean => {
  // Every PR of the worker, as the ledger reads them: one still open, or not known, isn't finished.
  const badges = workerPrBadges({ ...facts, extraBadges: facts.extraBadges ?? [] });
  const pr = combinePrFacts(
    badges.map((badge) => (badge === undefined ? undefined : prFactsOf(badge))),
  );
  return FINISHED_STATES.has(
    workerState({
      status: facts.status,
      parked: facts.thread.parked,
      completedReason: facts.thread.completedReason,
      hasStartedTurn: true,
      pendingRequestCount: facts.pendingRequests,
      ...(pr === undefined ? {} : { pr }),
      reopened: reopenedSinceMerge(facts.thread, badges),
      canOpenPr: canOpenPr({ git: facts.git, extras: [] }),
    }),
  );
};

/**
 * Whether a thread no orchestrator dispatched is finished: archived, or every PR it follows merged
 * or closed, and not reopened since a merge.
 */
const isFinishedThread = (facts: SweepFacts): boolean => {
  if (facts.thread.parked) return true;
  const badges = workerPrBadges({ ...facts, extraBadges: facts.extraBadges ?? [] });
  if (mergedAndDone(facts.thread, badges)) return true;
  return (
    badges.length > 0 &&
    badges.every((badge) => badge?.state === "MERGED" || badge?.state === "CLOSED") &&
    !reopenedSinceMerge(facts.thread, badges)
  );
};

/**
 * Whether the thread is done because its PRs merged: its worktree goes without the long wait. An
 * archived thread's badge is dropped once GitHub answers that its PR merged, so there its own record
 * stands in: completed on a merge, no other PR followed, and no badge it still has open.
 * `checkWorktree` asks GitHub afresh before anything goes.
 */
const mergedDone = (facts: SweepFacts): boolean => {
  const { thread } = facts;
  const badges = workerPrBadges({ ...facts, extraBadges: facts.extraBadges ?? [] });
  if (mergedAndDone(thread, badges)) return true;
  return (
    thread.parked &&
    thread.completedReason === "prMerged" &&
    thread.completedAt !== undefined &&
    (thread.extraPrs?.length ?? 0) === 0 &&
    badges.every((badge) => badge === undefined || badge.state !== "OPEN")
  );
};

/**
 * How long after a merge its worktree is removed: long enough for a look at the result, short
 * enough that the next sweep takes it.
 */
export const MERGED_GRACE_MS = 10 * 60_000;

/**
 * How long after its last activity an archived worker with no PR of its own has its worktree
 * removed: a day to unarchive it, after which `restore_worktree` can still bring its branch back.
 */
export const ARCHIVED_GRACE_MS = DAY_MS;

/** Epoch ms from which a finished thread's age is counted: its last activity or completion. */
const finishedSince = (thread: Thread): number =>
  Math.max(thread.lastActivityAt, thread.completedAt ?? 0);

/** Which steps are due for a thread, before git has been asked. */
export interface SweepDue {
  readonly free: boolean;
  /** Old enough to remove, and with a PR whose state can be asked or an archived worker with none. */
  readonly remove: boolean;
  /** Removal needs no settled PR: an archived worker that never had one (`ARCHIVED_GRACE_MS`). */
  readonly withoutPr?: true;
}

/**
 * The steps due for `facts.thread` at `now`, or `undefined` when the sweep must never touch it: an
 * orchestrator, a plain thread outside the repo's `.worktrees/` folder, not finished, busy (background
 * tasks, subagents or terminal programs included) or waiting on the user, in the main checkout,
 * spanning repos, following its agent into another checkout, or in a checkout another thread holds
 * or follows its agent into.
 */
export const sweepDue = (
  facts: SweepFacts,
  sweep: WorktreeSweep,
  now: number,
): SweepDue | undefined => {
  const { thread } = facts;
  const { checkout } = thread;
  if (thread.role !== undefined) return undefined;
  const worker = thread.spawnedBy !== undefined;
  // A plain thread may have been opened in a worktree some other tool or the user made: only one
  // in Gram's own `.worktrees/` folder is the sweep's to take.
  if (
    !worker &&
    (checkout.repoRoot === undefined || !underWorktreesFolder(checkout.repoRoot, checkout.path))
  ) {
    return undefined;
  }
  if (checkout.kind !== "worktree") return undefined;
  if (checkout.repoRoot !== undefined && samePath(checkout.repoRoot, checkout.path)) {
    return undefined;
  }
  if ((thread.extraCheckouts?.length ?? 0) > 0) return undefined;
  // A worker that followed its agent elsewhere: what it works in isn't what would be cleaned up.
  if (
    thread.currentCheckout !== undefined &&
    !samePath(thread.currentCheckout.path, checkout.path)
  ) {
    return undefined;
  }
  if (!AT_REST.has(facts.status) || facts.pendingRequests > 0 || facts.busy) return undefined;
  if (facts.heldByOthers.some((held) => samePath(held, checkout.path))) return undefined;
  if (!(worker ? isFinishedWorker(facts) : isFinishedThread(facts))) return undefined;
  const age = now - finishedSince(thread);
  const hasPr = thread.boundPr !== undefined || facts.badge !== undefined;
  const free = age >= sweep.freeAfterDays * DAY_MS;
  // An archived worker following no PR at all: archiving is what says its work is over.
  if (!hasPr && (thread.extraPrs?.length ?? 0) === 0 && worker && thread.parked) {
    const remove = age >= ARCHIVED_GRACE_MS;
    if (remove) return { free, remove, withoutPr: true };
    return free ? { free, remove } : undefined;
  }
  const removeAfter = mergedDone(facts) ? MERGED_GRACE_MS : sweep.removeAfterDays * DAY_MS;
  const due = { free, remove: hasPr && age >= removeAfter };
  return due.free || due.remove ? due : undefined;
};

/** What git and GitHub say about a worktree right before the sweep acts on it. */
export interface WorktreeCheck {
  /** `git status` lists nothing: no uncommitted or untracked work. */
  readonly clean: boolean;
  /** Every commit is on a remote (`headPushed`): the rule the close dialog pre-ticks removal by. */
  readonly pushed: boolean;
  /** The PR is merged or closed. */
  readonly prSettled: boolean;
  /** GitHub answered: no PR is open for it (none at all, or a settled one). A failed lookup is no. */
  readonly noPrOpen?: boolean;
}

/** The step to take, from what is due and what git said; `undefined` leaves the worktree be. */
export const sweepStep = (due: SweepDue, check: WorktreeCheck): "free" | "remove" | undefined => {
  if (!check.clean || !check.pushed) return undefined;
  const settled = due.withoutPr === true ? check.noPrOpen === true : check.prSettled;
  if (due.remove && settled) return "remove";
  return due.free ? "free" : undefined;
};

/** Asks git, and gh when a PR is wanted, what `sweepStep` needs. Any failure reads as "no". */
export const checkWorktree = (
  path: string,
  thread: Thread,
  wantPr: boolean,
): Effect.Effect<WorktreeCheck, never, Proc | Pr> =>
  Effect.gen(function* () {
    const no: WorktreeCheck = { clean: false, pushed: false, prSettled: false };
    const status = yield* git(path, ["status", "--porcelain"]).pipe(Effect.option);
    if (Option.isNone(status) || status.value.status !== 0 || status.value.truncated) return no;
    const clean = status.value.stdout.trim() === "";
    const rev = yield* git(path, ["rev-parse", "--verify", "HEAD"]).pipe(Effect.option);
    if (Option.isNone(rev) || rev.value.status !== 0) return { ...no, clean };
    const head = rev.value.stdout.trim();
    const remote = yield* git(path, [
      "for-each-ref",
      "--count=1",
      "--format=%(refname)",
      "--contains",
      head,
      "refs/remotes",
    ]).pipe(Effect.option);
    const onRemote =
      Option.isSome(remote) && remote.value.status === 0 && remote.value.stdout.trim() !== "";
    if (!wantPr)
      return { clean, pushed: headPushed({ head, headOnRemote: onRemote }), prSettled: false };
    const pr = yield* Pr;
    const badge = yield* asBackground(pr.status(path, thread.boundPr)).pipe(Effect.option);
    const settled = Option.isSome(badge) ? badge.value : undefined;
    return {
      clean,
      pushed: headPushed({ head, headOnRemote: onRemote, prHeadRefOid: settled?.headRefOid }),
      prSettled: settled?.state === "MERGED" || settled?.state === "CLOSED",
      noPrOpen: Option.isSome(badge) && settled?.state !== "OPEN",
    };
  });

/**
 * `checkWorktree` for a worktree whose folder was deleted outside Gram: nothing is left in it
 * to lose, so it reads clean and pushed, and only the PR has to have settled. That is asked of gh
 * from the repo's main checkout for a bound PR, and otherwise read off the last badge, since a
 * branch lookup needs the folder; with nothing bound, no open badge is no PR open.
 */
export const checkMissingWorktree = (
  thread: Thread,
  badge: PrStatus | undefined,
  wantPr: boolean,
): Effect.Effect<WorktreeCheck, never, Pr> =>
  Effect.gen(function* () {
    if (!wantPr) return { clean: true, pushed: true, prSettled: false };
    const root = thread.checkout.repoRoot;
    const pr = yield* Pr;
    const asked =
      thread.boundPr !== undefined && root !== undefined
        ? yield* asBackground(pr.status(root, thread.boundPr)).pipe(Effect.option)
        : Option.some(badge);
    const settled = Option.getOrUndefined(asked);
    return {
      clean: true,
      pushed: true,
      prSettled: settled?.state === "MERGED" || settled?.state === "CLOSED",
      noPrOpen: Option.isSome(asked) && settled?.state !== "OPEN",
    };
  });

/**
 * `node_modules` folders under `root`, `NODE_MODULES_DEPTH` deep at most, never through a link and
 * never into a nested git checkout (a submodule), whose own index is the only one that knows them.
 */
const findNodeModules = async (root: string): Promise<ReadonlyArray<string>> => {
  const found: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable or gone: nothing in it to free.
      return;
    }
    // A submodule or nested repository: the outer index can't say what it tracks.
    if (dir !== root && entries.some((entry) => entry.name === ".git")) return;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name === "node_modules") found.push(path);
      else if (!SKIPPED_DIRS.has(entry.name) && depth < NODE_MODULES_DEPTH) {
        await visit(path, depth + 1);
      }
    }
  };
  await visit(root, 0);
  return found;
};

/**
 * Deletes the untracked `node_modules` folders in the worktree at `path`. One git tracks anything
 * in, or that is a link rather than a folder by now, is kept. Answers how many went.
 */
export const freeNodeModules = (path: string): Effect.Effect<number, never, Proc> =>
  Effect.gen(function* () {
    const folders = yield* Effect.promise(() => findNodeModules(path));
    let freed = 0;
    for (const folder of folders) {
      const tracked = yield* git(path, ["ls-files", "-z", "--", relative(path, folder)]).pipe(
        Effect.option,
      );
      if (Option.isNone(tracked) || tracked.value.status !== 0 || tracked.value.stdout !== "") {
        continue;
      }
      const removed = yield* Effect.promise(async () => {
        const stats = await lstat(folder).catch(() => undefined);
        if (stats === undefined || !stats.isDirectory() || stats.isSymbolicLink()) return false;
        return rm(folder, { recursive: true, force: true }).then(
          () => true,
          () => false,
        );
      });
      if (removed) freed += 1;
    }
    return freed;
  });

/** The working folders in `lsof -d cwd -Fn` output: one `n<path>` line per process. */
export const lsofCwds = (stdout: string): ReadonlyArray<string> =>
  stdout
    .split("\n")
    .filter((line) => line.startsWith("n/"))
    .map((line) => line.slice(1));

/** Every process's working folder, or `undefined` where they can't be listed. */
const processCwds = (): Effect.Effect<ReadonlyArray<string> | undefined, never, Proc> =>
  Effect.gen(function* () {
    if (process.platform === "linux") {
      return yield* Effect.promise(async () => {
        const pids = await readdir("/proc").catch(() => undefined);
        if (pids === undefined) return undefined;
        const cwds = await Promise.all(
          // Another user's process, or one gone since, has no folder to read: it isn't ours.
          pids
            .filter((pid) => /^\d+$/.test(pid))
            .map((pid) => readlink(`/proc/${pid}/cwd`).catch(() => undefined)),
        );
        return cwds.filter((cwd): cwd is string => cwd !== undefined);
      });
    }
    if (process.platform !== "darwin") return undefined;
    const proc = yield* Proc;
    const out = yield* proc
      .run("/usr/sbin/lsof", ["-n", "-d", "cwd", "-Fn"], {
        cwd: homedir(),
        tier: "local",
        env: { PATH: "/usr/bin:/bin:/usr/sbin", LC_ALL: "C" },
        maxOutputBytes: 16 * 1024 * 1024,
      })
      .pipe(Effect.option);
    // lsof exits 1 when it couldn't read some process, and still lists the rest.
    if (Option.isNone(out) || out.value.truncated || out.value.status > 1) return undefined;
    const cwds = lsofCwds(out.value.stdout);
    return cwds.length === 0 ? undefined : cwds;
  });

/** Whether one of `cwds` is `path` or below it, as written or through its links. */
export const anyInside = (path: string, real: string, cwds: ReadonlyArray<string>): boolean =>
  cwds.some((cwd) => isInside(path, cwd) || isInside(real, cwd));

/**
 * Whether a process works inside the worktree at `path`: an agent, a dev server or a shell, the
 * threads' state aside. `true` when that can't be told, so the sweep leaves the worktree be.
 */
export const processInside = (path: string): Effect.Effect<boolean, never, Proc> =>
  Effect.gen(function* () {
    const cwds = yield* processCwds();
    if (cwds === undefined) return true;
    const real = yield* Effect.promise(() => realPathOrOwned(path));
    return anyInside(path, real, cwds);
  });

/**
 * The last look before the sweep takes anything from the worktree at `path`: another thread holds
 * or follows its agent into it (`held`), or a process works inside it (`processInside`).
 */
export const inUse = (
  path: string,
  held: ReadonlyArray<string>,
): Effect.Effect<boolean, never, Proc> =>
  held.some((each) => samePath(each, path)) ? Effect.succeed(true) : processInside(path);

/**
 * The free step's deletion behind its last look: `freeNodeModules` unless the worktree is `inUse`,
 * since `node_modules` pulled from under a running process breaks it. How many went, or
 * `undefined` when it was left be.
 */
export const freeUnlessInUse = (
  path: string,
  held: ReadonlyArray<string>,
): Effect.Effect<number | undefined, never, Proc> =>
  Effect.gen(function* () {
    if (yield* inUse(path, held)) return undefined;
    return yield* freeNodeModules(path);
  });

/** The checkouts threads other than `self` hold or follow their agent into (`usedCheckoutPaths`). */
export const othersCheckouts = (
  threads: ReadonlyArray<Thread>,
  self: Thread["id"],
): ReadonlyArray<string> => usedCheckoutPaths(threads.filter((other) => other.id !== self));

/**
 * What the sweep found a worker due on, to be checked again under its runtime lock right before
 * acting: still in `checked`'s checkout, and nothing that made it due has moved since. New
 * activity, a completion or an unpark between the snapshot and the act restarts its clock or ends
 * its eligibility, and the next pass judges it afresh.
 */
export const asChecked = (checked: Thread): ClaimGuard => ({
  expectedCheckout: checked.checkout.path,
  stillHolds: (now) =>
    now.parked === checked.parked &&
    now.lastActivityAt === checked.lastActivityAt &&
    now.completedAt === checked.completedAt &&
    now.completedReason === checked.completedReason &&
    now.spawnedBy?.threadId === checked.spawnedBy?.threadId,
});

/** What one pass did, as counts only. */
interface SweepCounts {
  /** Worktrees whose `node_modules` went. */
  readonly freed: number;
  readonly removed: number;
  /** Due, but git or GitHub said no, or the step failed. */
  readonly kept: number;
  /** The worktrees removed, by repo and workspace, for the digest line. */
  readonly cleaned: ReadonlyArray<Cleaned & { readonly workspaceId?: WorkspaceId | undefined }>;
}

/** How long a removed worktree's size count may take: the digest line says what it freed. */
const SIZE_BUDGET_MS = 5_000;

/** One pass over every thread, under `sweep`'s schedule. */
const sweepOnce = (
  sweep: WorktreeSweep,
): Effect.Effect<
  SweepCounts,
  never,
  ThreadStore | ThreadRuntimes | GitStatePublisher | Proc | Pr
> =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const runtimes = yield* ThreadRuntimes;
    const publisher = yield* GitStatePublisher;
    const ports = Option.getOrUndefined(yield* Effect.serviceOption(ThreadPorts));
    const gate = Option.getOrUndefined(yield* Effect.serviceOption(TerminalGate));
    const summaries = yield* runtimes.snapshot;
    const working = new Set(yield* runtimes.working);
    const threads = summaries.map((summary) => summary.thread);
    const now = Date.now();
    const counts = { freed: 0, removed: 0, kept: 0 };
    const cleaned: Array<Cleaned & { readonly workspaceId?: WorkspaceId | undefined }> = [];
    for (const summary of summaries) {
      const { thread } = summary;
      const due = sweepDue(
        {
          thread,
          status: summary.status,
          pendingRequests: summary.pendingRequests.length,
          // Between turns an activity line is published only while a background subagent works.
          busy:
            working.has(thread.id) ||
            (summary.background?.length ?? 0) > 0 ||
            (summary.terminalProcesses?.length ?? 0) > 0 ||
            summary.activity !== undefined,
          git: yield* publisher.stateFor(thread.checkout.path),
          badge: yield* publisher.badgeFor(thread),
          extraBadges: yield* publisher.extraBadgesFor(thread),
          missingPrs: (yield* publisher.stateForThread(thread))?.missingPrs,
          heldByOthers: othersCheckouts(threads, thread.id),
        },
        sweep,
        now,
      );
      if (due === undefined) continue;
      const path = thread.checkout.path;
      const gone = !(yield* folderExists(path));
      const check = gone
        ? yield* checkMissingWorktree(thread, yield* publisher.badgeFor(thread), due.remove)
        : yield* checkWorktree(path, thread, due.remove);
      const step = sweepStep(due, check);
      // A folder that is gone holds no `node_modules`; it waits to be removed with its thread.
      if (step === undefined || (gone && step === "free")) {
        counts.kept += 1;
        continue;
      }
      // Asked again with the step in hand: another thread may have followed its agent in since, or
      // a process the threads don't know about may work there.
      const held = othersCheckouts(yield* store.listThreads, thread.id);
      const used = gone ? held.some((each) => samePath(each, path)) : yield* inUse(path, held);
      if (used) {
        counts.kept += 1;
        continue;
      }
      if (step === "remove") {
        const size = gone ? { bytes: 0 } : yield* cachedFolderSize(path, SIZE_BUDGET_MS);
        // `closeAtRest` holds its terminals and scans them; the close checks the runtime and that
        // the thread is still as it was found due (`asChecked`), under the lock sends take.
        const closed = yield* closeAtRest(runtimes, ports, gate, thread.id, {
          removeWorktree: { force: false },
          ...asChecked(thread),
        }).pipe(Effect.option);
        if (Option.isSome(closed)) {
          counts.removed += 1;
          forgetFolderSize(path);
          cleaned.push({
            repoTop: thread.checkout.repoRoot ?? path,
            bytes: size.bytes,
            workspaceId: thread.workspaceId,
          });
        } else counts.kept += 1;
        continue;
      }
      // Freeing takes the same terminal hold and scan, and runs reserved at rest while the worker is
      // still as found due and in that checkout, so no send starts a turn on top of it:
      // `node_modules` pulled from under `pnpm dev` or an agent breaks them.
      const freed = yield* Effect.acquireUseRelease(
        gate === undefined ? Effect.succeed(Effect.void) : gate.hold(thread.id),
        () =>
          Effect.gen(function* () {
            const terminals = ports === undefined ? undefined : yield* ports.busyTerminalsNow;
            if (terminals === undefined || terminals.includes(thread.id)) return undefined;
            return yield* runtimes.whileAtRest(
              thread.id,
              Effect.gen(function* () {
                // Last look before anything goes: another thread's agent may have moved in. Not held
                // across the deletion; see "Known and accepted gap" at the top.
                return yield* freeUnlessInUse(
                  path,
                  othersCheckouts(yield* store.listThreads, thread.id),
                );
              }),
              asChecked(thread),
            );
          }),
        (release) => release,
      ).pipe(Effect.orElseSucceed(() => undefined));
      if (freed === undefined) counts.kept += 1;
      else if (freed > 0) counts.freed += 1;
    }
    return { ...counts, cleaned };
  });

/**
 * How often the sweep runs; the first pass waits as long, so a boot isn't slowed by it. Short
 * enough that a merged thread's worktree goes soon after `MERGED_GRACE_MS`.
 */
const SWEEP_EVERY = Duration.minutes(15);

/** Runs `sweepOnce` every `SWEEP_EVERY` while the setting is on, until the scope closes. */
export const WorktreeSweepLive: Layer.Layer<
  never,
  never,
  ThreadStore | ThreadRuntimes | GitStatePublisher | Proc | Pr
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const orchestration = Option.getOrUndefined(yield* Effect.serviceOption(Orchestration));
    const pass = Effect.gen(function* () {
      const settings = yield* store.getSettings;
      const sweep = worktreeSweepOf(settings);
      if (sweep === undefined) return;
      const { cleaned, ...counts } = yield* sweepOnce(sweep);
      // A worktree kept for want of a merge is kept again every pass; that alone isn't news.
      if (counts.freed + counts.removed === 0) return;
      yield* Effect.logInfo("worktree sweep").pipe(Effect.annotateLogs({ ...counts }));
      if (orchestration === undefined || cleaned.length === 0) return;
      const notes = cleanupNotes(cleaned, yield* store.listWorkspaces, yield* store.listProjects);
      for (const { workspaceId, note } of notes)
        yield* orchestration.noteQuietly(workspaceId, note);
    }).pipe(
      // A defect's text can name a worktree's path, so the log says only that the pass failed; the
      // next pass runs regardless.
      Effect.catchCause(() => Effect.logWarning("worktree sweep pass failed")),
    );
    yield* Effect.sleep(SWEEP_EVERY).pipe(
      Effect.andThen(pass.pipe(Effect.repeat(Schedule.spaced(SWEEP_EVERY)))),
      Effect.forkScoped,
    );
  }),
);
