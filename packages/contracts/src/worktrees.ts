import * as Schema from "effect/Schema";
import { WorktreeEntry } from "./git.ts";
import { ThreadId } from "./ids.ts";

/** A worktree by its folder, for the RPCs that work on worktrees no thread has open. */
export const WorktreePathFields = {
  path: Schema.String,
};

export const RemoveWorktreeFields = {
  path: Schema.String,
  /** Discard uncommitted changes instead of refusing with `WorktreeDirty`. */
  force: Schema.Boolean,
  /** Picks from `worktree.pendingPermissionsAt` to union into the main checkout once removed. */
  permissionRules: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * Also delete the worktree's local branch, merged through this PR. The server checks it again at
   * delete time and keeps the branch, saying why, when it isn't safe.
   */
  deleteBranch: Schema.optionalKey(Schema.Struct({ repo: Schema.String, number: Schema.Int })),
};

/** What a worktree folder takes on disk, for the Worktrees list's selection. */
export const WorktreeSize = Schema.Struct({
  bytes: Schema.Number,
  /** The count stopped at its time bound, so `bytes` is a lower bound. */
  partial: Schema.Boolean,
});
export type WorktreeSize = typeof WorktreeSize.Type;

export const WorktreeList = Schema.Struct({
  repoTop: Schema.String,
  worktrees: Schema.Array(WorktreeEntry),
});
export type WorktreeList = typeof WorktreeList.Type;

/** What happened to a removed worktree's local branch when deleting it was asked for. */
export const BranchCleanup = Schema.Struct({
  name: Schema.String,
  deleted: Schema.Boolean,
  /** Why the branch was kept; absent once deleted. */
  reason: Schema.optionalKey(Schema.String),
});
export type BranchCleanup = typeof BranchCleanup.Type;

/** `branch` is present only when the removal was asked to delete the local branch. */
export const WorktreeRemoval = Schema.Struct({ branch: Schema.optionalKey(BranchCleanup) });
export type WorktreeRemoval = typeof WorktreeRemoval.Type;

/** Where a restored worktree's branch came from. */
export const RestoreSource = Schema.Literals(["local", "origin", "pr"]);
export type RestoreSource = typeof RestoreSource.Type;

/**
 * What `thread.restoreWorktree` did. `restored`: the worktree is back at its recorded path on its
 * branch, from the local branch, `origin`'s, or the PR's head; what was uncommitted in it is gone
 * for good. `branchGone`: neither the repo nor `origin` has the branch, and nothing was changed;
 * with `pr`, asking again with `fromPr` recreates the branch from that PR's head.
 */
export const RestoreWorktreeResult = Schema.Union([
  Schema.TaggedStruct("restored", {
    path: Schema.String,
    branch: Schema.String,
    source: RestoreSource,
  }),
  Schema.TaggedStruct("branchGone", {
    branch: Schema.String,
    pr: Schema.optionalKey(Schema.Struct({ repo: Schema.String, number: Schema.Int })),
  }),
]);
export type RestoreWorktreeResult = typeof RestoreWorktreeResult.Type;

/**
 * Where a linked worktree stands in Settings › Storage. `inUse`: an open thread works in it.
 * `removable`: its PR merged or closed (or HEAD is in the base branch), nothing uncommitted, nothing
 * unpushed, or its folder is already gone. `kept`: uncommitted or unpushed work. `idle`: the rest
 * Gram made. `foreign`: one Gram didn't make, such as an agent shell's in a temp folder.
 */
export const StorageGroup = Schema.Literals(["inUse", "idle", "removable", "kept", "foreign"]);
export type StorageGroup = typeof StorageGroup.Type;

export const StoragePr = Schema.Struct({
  number: Schema.Int,
  state: Schema.Literals(["OPEN", "MERGED", "CLOSED"]),
});
export type StoragePr = typeof StoragePr.Type;

/** One linked worktree of a known repo, as Settings › Storage lists it. */
export const StorageWorktree = Schema.Struct({
  path: Schema.String,
  /** The repo's main checkout. */
  repoTop: Schema.String,
  branch: Schema.optionalKey(Schema.String),
  group: StorageGroup,
  /** Under the repo's `.worktrees/`, or a thread's checkout. */
  madeByGram: Schema.Boolean,
  /** The open thread working in it. */
  threadId: Schema.optionalKey(ThreadId),
  threadTitle: Schema.optionalKey(Schema.String),
  /** Epoch ms of the last activity seen: a thread's, or git's in the folder; 0 when unknown. */
  lastActivity: Schema.Number,
  /** The folder is gone and only git's registration is left, which a prune drops. */
  missing: Schema.Boolean,
  /** git couldn't read it, so nothing is known of its work and it is kept. */
  unreadable: Schema.optionalKey(Schema.Literal(true)),
  /** `git worktree lock`ed: whoever locked it wants it kept, so nothing here removes it. */
  locked: Schema.optionalKey(Schema.Literal(true)),
  changedFiles: Schema.Int,
  /** Commits HEAD has that no remote has, unless HEAD is a settled PR's head. */
  unpushed: Schema.Int,
  /** Its PR merged or closed, or HEAD is already in the base branch. */
  settled: Schema.Boolean,
  pr: Schema.optionalKey(StoragePr),
});
export type StorageWorktree = typeof StorageWorktree.Type;

/** The disk the worktrees sit on. */
export const DiskSpace = Schema.Struct({ freeBytes: Schema.Number, totalBytes: Schema.Number });
export type DiskSpace = typeof DiskSpace.Type;

/** `worktree.storage`: every known repo's linked worktrees, grouped, and the free disk space. */
export const StorageReport = Schema.Struct({
  worktrees: Schema.Array(StorageWorktree),
  disk: Schema.optionalKey(DiskSpace),
  /** Repos whose worktrees couldn't be listed. */
  failedRepos: Schema.Array(Schema.String),
});
export type StorageReport = typeof StorageReport.Type;

/** The choices "Clean up inactive" offers, in days. */
export const CLEANUP_INACTIVE_DAYS = [30, 60, 90] as const;

export const CleanupPlanFields = {
  inactiveDays: Schema.Int.check(Schema.isGreaterThan(0)),
};

/**
 * What "Clean up inactive" would remove, computed before anything goes: worktrees Gram made that no
 * open thread uses, with nothing uncommitted or unpushed, untouched for `inactiveDays`.
 */
export const CleanupPlan = Schema.Struct({
  worktrees: Schema.Array(StorageWorktree),
  bytes: Schema.Number,
  /** A size count ran out of time, so `bytes` is a lower bound. */
  partial: Schema.Boolean,
});
export type CleanupPlan = typeof CleanupPlan.Type;

/**
 * A worktree the user confirmed removing by name, with the work the confirmation showed. More work
 * than that at removal time keeps it.
 */
export const ConfirmedRemoval = Schema.Struct({
  path: Schema.String,
  changedFiles: Schema.Int,
  unpushed: Schema.Int,
});
export type ConfirmedRemoval = typeof ConfirmedRemoval.Type;

export const CleanUpFields = {
  paths: Schema.Array(Schema.String),
  /**
   * Worktrees the user confirmed by name: needed for one with uncommitted or unpushed work, and for
   * one Gram didn't make. Any other such path is kept, whatever else asked for it.
   */
  confirmed: Schema.optionalKey(Schema.Array(ConfirmedRemoval)),
  /** Also `git worktree prune` the repos: drops registrations whose folder is gone. */
  prune: Schema.optionalKey(Schema.Boolean),
};

/** What `worktree.cleanUp` did. Branches always stay. */
export const CleanUpResult = Schema.Struct({
  removed: Schema.Array(Schema.Struct({ path: Schema.String, bytes: Schema.Number })),
  kept: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
  /** Registrations `git worktree prune` dropped. */
  pruned: Schema.Int,
  /** What the removed folders took on disk, at least. */
  bytes: Schema.Number,
});
export type CleanUpResult = typeof CleanUpResult.Type;

const DAY_MS = 24 * 60 * 60_000;

/** Nothing would be lost by removing it: gone already, or clean, unlocked, every commit pushed. */
export const losesNothing = (
  entry: Pick<StorageWorktree, "missing" | "changedFiles" | "unpushed" | "unreadable" | "locked">,
): boolean =>
  entry.missing ||
  (entry.unreadable !== true &&
    entry.locked !== true &&
    entry.changedFiles === 0 &&
    entry.unpushed === 0);

/**
 * Whether "Clean up inactive" takes it: Gram made it, no thread uses it, nothing would be lost,
 * and nothing has happened in it for `days`. Unknown activity (0) counts as recent, unless the
 * folder is already gone.
 */
export const inactiveCandidate = (entry: StorageWorktree, days: number, now: number): boolean =>
  entry.madeByGram &&
  (entry.group === "idle" || entry.group === "removable") &&
  losesNothing(entry) &&
  (entry.missing || entry.lastActivity > 0) &&
  entry.lastActivity < now - days * DAY_MS;

/**
 * Why `cleanUp` keeps a worktree it was asked to remove, or `undefined` to go ahead. Never one in
 * use or locked; one with work, or one Gram didn't make, only when the user confirmed it by name
 * and it has no more work than the confirmation showed.
 */
export const keepReason = (
  entry: StorageWorktree | undefined,
  confirmed: ReadonlyArray<ConfirmedRemoval>,
): string | undefined => {
  if (entry === undefined) return "not a linked worktree of a known repo";
  if (entry.group === "inUse") return "an open thread uses it";
  if (entry.missing) return undefined;
  if (entry.locked === true) return "it is locked";
  if (losesNothing(entry) && entry.madeByGram) return undefined;
  const named = confirmed.find((c) => c.path === entry.path);
  if (named === undefined) {
    if (entry.unreadable === true) return "git couldn't read it";
    return losesNothing(entry)
      ? "Gram didn't make it, and it wasn't confirmed by name"
      : "it has uncommitted or unpushed work";
  }
  if (entry.unreadable === true) return "git couldn't read it";
  if (entry.changedFiles > named.changedFiles || entry.unpushed > named.unpushed) {
    return "it has more work than was confirmed";
  }
  return undefined;
};
