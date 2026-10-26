// Settings › Storage: every known repo's linked worktrees, grouped by what removing one would lose,
// and the cleanups run from there. Nothing here deletes a branch, and nothing removes a worktree
// with uncommitted or unpushed work unless the user named it (`confirmed`).

import { existsSync, readFileSync, statSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import {
  inactiveCandidate,
  keepReason,
  losesNothing,
  type CleanupPlan,
  type ConfirmedRemoval,
  type CleanUpResult,
  type DiskSpace,
  type Project,
  type StorageGroup,
  type StoragePr,
  type StorageReport,
  type StorageWorktree,
  type Thread,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import {
  gh,
  git,
  localBaseRef,
  porcelainChanges,
  samePath,
  type Proc,
  type WorktreeError,
} from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { folderExists } from "../fs/folders.ts";
import { usedCheckoutPaths } from "../runtime/create-in-checkout.ts";
import { cachedFolderSize, forgetFolderSize } from "./worktree-size.ts";

/** Worktrees probed at once: each probe is a handful of short git runs. */
const PROBES = 8;

/** How long a size count may take while a cleanup works out what it frees. */
const PLAN_SIZE_BUDGET_MS = 5_000;

/** The PRs asked of `gh` per repo, newest first; an older branch falls back to the base check. */
const PR_LIMIT = 200;

/** What git said of one linked worktree. */
interface WorktreeProbe {
  readonly missing: boolean;
  /** `git status` or `rev-parse` failed: nothing can be said, so it is kept. */
  readonly unreadable: boolean;
  /** `git worktree lock`ed. */
  readonly locked: boolean;
  readonly head: string | undefined;
  readonly changedFiles: number;
  /** Commits on HEAD no remote-tracking ref has. */
  readonly unpushed: number;
  /** HEAD is already in the repo's base branch. */
  readonly inBase: boolean;
  /** Epoch ms git last touched the worktree's index or HEAD; 0 when unknown. */
  readonly gitActivity: number;
}

/** A PR GitHub knows for a branch, with the commit it ended on. */
export interface BranchPr extends StoragePr {
  readonly headRefOid: string | undefined;
}

/** What `classifyWorktree` needs. */
export interface ClassifyInput {
  readonly madeByGram: boolean;
  readonly inUse: boolean;
  readonly missing: boolean;
  readonly unreadable: boolean;
  readonly locked?: boolean;
  readonly changedFiles: number;
  readonly unpushed: number;
  readonly settled: boolean;
}

/** The Storage group of a worktree; see `StorageGroup`. */
export const classifyWorktree = (input: ClassifyInput): StorageGroup => {
  if (input.inUse) return "inUse";
  if (!input.madeByGram) return "foreign";
  if (input.missing) return "removable";
  if (input.unreadable || input.locked === true || input.changedFiles > 0 || input.unpushed > 0) {
    return "kept";
  }
  return input.settled ? "removable" : "idle";
};

/** Whether `path` is a folder Gram makes worktrees in: `<repo>/.worktrees/<name>`. */
export const underWorktreesFolder = (repoTop: string, path: string): boolean =>
  samePath(nodePath.dirname(path), nodePath.join(repoTop, ".worktrees"));

/** `git status` locks and refreshes a linked worktree's index here; `HEAD` moves on commit. */
const gitDirOf = (path: string): string | undefined => {
  try {
    const pointer = readFileSync(nodePath.join(path, ".git"), "utf8").trim();
    if (!pointer.startsWith("gitdir:")) return undefined;
    const dir = pointer.slice("gitdir:".length).trim();
    return nodePath.isAbsolute(dir) ? dir : nodePath.resolve(path, dir);
  } catch {
    return undefined;
  }
};

const mtimeOf = (path: string): number => {
  try {
    return statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  } catch {
    return 0;
  }
};

/** Whether `git worktree lock` holds the worktree: its admin folder has a `locked` file. */
const isLocked = (path: string): boolean => {
  const dir = gitDirOf(path);
  return dir !== undefined && existsSync(nodePath.join(dir, "locked"));
};

/** When git last wrote the worktree's index, HEAD or reflog: activity any tool leaves behind. */
const gitActivityOf = (path: string): number => {
  const dir = gitDirOf(path);
  if (dir === undefined) return 0;
  return Math.max(
    mtimeOf(nodePath.join(dir, "index")),
    mtimeOf(nodePath.join(dir, "HEAD")),
    mtimeOf(nodePath.join(dir, "logs", "HEAD")),
  );
};

/** Asks git about one linked worktree; `base` is the repo's base ref when it has one. */
const probeWorktree = (
  path: string,
  base: string | undefined,
): Effect.Effect<WorktreeProbe, never, Proc> =>
  Effect.gen(function* () {
    const none = {
      locked: false,
      head: undefined,
      changedFiles: 0,
      unpushed: 0,
      inBase: false,
      gitActivity: 0,
    };
    if (!(yield* folderExists(path))) return { ...none, missing: true, unreadable: false };
    const unreadable = { ...none, missing: false, unreadable: true, locked: isLocked(path) };
    const status = yield* git(path, ["status", "--porcelain"]).pipe(Effect.option);
    if (Option.isNone(status) || status.value.status !== 0 || status.value.truncated) {
      return unreadable;
    }
    const rev = yield* git(path, ["rev-parse", "--verify", "HEAD"]).pipe(Effect.option);
    if (Option.isNone(rev) || rev.value.status !== 0) return unreadable;
    const head = rev.value.stdout.trim();
    const count = yield* git(path, ["rev-list", "--count", head, "--not", "--remotes"]).pipe(
      Effect.option,
    );
    if (Option.isNone(count) || count.value.status !== 0) return unreadable;
    const inBase =
      base !== undefined &&
      (yield* git(path, ["merge-base", "--is-ancestor", head, base]).pipe(
        Effect.map((out) => out.status === 0),
        Effect.orElseSucceed(() => false),
      ));
    return {
      missing: false,
      unreadable: false,
      locked: isLocked(path),
      head,
      changedFiles: porcelainChanges(status.value.stdout),
      unpushed: Number.parseInt(count.value.stdout.trim(), 10) || 0,
      inBase,
      gitActivity: gitActivityOf(path),
    };
  });

/** `gh pr list --json` output by head branch, the newest PR of each; malformed entries drop. */
export const parseBranchPrs = (stdout: string): ReadonlyMap<string, BranchPr> => {
  const prs = new Map<string, BranchPr>();
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return prs;
  }
  if (!Array.isArray(body)) return prs;
  for (const item of body as ReadonlyArray<Record<string, unknown>>) {
    const { number, state, headRefName, headRefOid } = item ?? {};
    if (typeof number !== "number" || typeof headRefName !== "string") continue;
    if (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED") continue;
    // gh lists the newest first; an older PR from a reused branch name says less.
    if (prs.has(headRefName)) continue;
    prs.set(headRefName, {
      number,
      state,
      headRefOid: typeof headRefOid === "string" ? headRefOid : undefined,
    });
  }
  return prs;
};

/** The repo's PRs by head branch, asked once; none without an `origin` or when gh can't answer. */
const branchPrs = (repoTop: string): Effect.Effect<ReadonlyMap<string, BranchPr>, never, Proc> =>
  Effect.gen(function* () {
    const origin = yield* git(repoTop, ["config", "--get", "remote.origin.url"]).pipe(
      Effect.map((out) => out.status === 0 && out.stdout.trim() !== ""),
      Effect.orElseSucceed(() => false),
    );
    if (!origin) return new Map<string, BranchPr>();
    return yield* askGh(repoTop);
  });

const askGh = (repoTop: string): Effect.Effect<ReadonlyMap<string, BranchPr>, never, Proc> =>
  gh(repoTop, [
    "pr",
    "list",
    "--state",
    "all",
    "--limit",
    String(PR_LIMIT),
    "--json",
    "number,state,headRefName,headRefOid",
  ]).pipe(
    Effect.map((out) => (out.status === 0 ? parseBranchPrs(out.stdout) : new Map())),
    Effect.orElseSucceed(() => new Map<string, BranchPr>()),
  );

/** One linked worktree as `git worktree list` gave it. */
interface ListedWorktree {
  readonly path: string;
  readonly branch?: string | undefined;
}

/** What `storageEntry` needs beyond git's answers. */
interface EntryContext {
  readonly repoTop: string;
  readonly openThreads: ReadonlyArray<Thread>;
  readonly pr: BranchPr | undefined;
}

/** Builds the Storage row for one linked worktree from git's and GitHub's answers. */
const storageEntry = (
  listed: ListedWorktree,
  probe: WorktreeProbe,
  context: EntryContext,
): StorageWorktree => {
  const { path, branch } = listed;
  const users = context.openThreads.filter((thread) =>
    usedCheckoutPaths([thread]).some((used) => samePath(used, path)),
  );
  const holder = users.find((thread) => samePath(thread.checkout.path, path)) ?? users[0];
  // Gram's own folder only: a thread may have been opened in a worktree some other tool made.
  const madeByGram = underWorktreesFolder(context.repoTop, path);
  const pr = context.pr;
  const prSettled = pr !== undefined && pr.state !== "OPEN";
  // A squash merge leaves HEAD in no remote branch once GitHub deletes the PR's.
  const onPrHead = prSettled && probe.head !== undefined && pr.headRefOid === probe.head;
  const unpushed = onPrHead ? 0 : probe.unpushed;
  const settled = prSettled || probe.inBase;
  const lastActivity = Math.max(probe.gitActivity, ...users.map((t) => t.lastActivityAt));
  const group = classifyWorktree({
    madeByGram,
    inUse: users.length > 0,
    missing: probe.missing,
    unreadable: probe.unreadable,
    locked: probe.locked,
    changedFiles: probe.changedFiles,
    unpushed,
    settled,
  });
  return {
    path,
    repoTop: context.repoTop,
    ...(branch === undefined ? {} : { branch }),
    group,
    madeByGram,
    ...(holder === undefined ? {} : { threadId: holder.id, threadTitle: holder.title }),
    lastActivity,
    missing: probe.missing,
    ...(probe.unreadable ? { unreadable: true as const } : {}),
    ...(probe.locked ? { locked: true as const } : {}),
    changedFiles: probe.changedFiles,
    unpushed,
    settled,
    ...(pr === undefined ? {} : { pr: { number: pr.number, state: pr.state } }),
  };
};

/** The repos Gram knows, each once: the projects that are repositories. */
const knownRepos = (projects: ReadonlyArray<Project>): ReadonlyArray<string> => {
  const repos: string[] = [];
  for (const project of projects) {
    const top = project.repoRoot;
    if (top !== undefined && !repos.some((known) => samePath(known, top))) repos.push(top);
  }
  return repos;
};

/** Free and total bytes of the disk `path` is on; `undefined` where the platform can't say. */
const diskSpaceAt = (path: string): Effect.Effect<DiskSpace | undefined> =>
  Effect.promise(() =>
    statfs(path).then(
      (stats): DiskSpace | undefined => ({
        freeBytes: stats.bavail * stats.bsize,
        totalBytes: stats.blocks * stats.bsize,
      }),
      () => undefined,
    ),
  );

/** What the Storage report reads from the rest of the app. */
export interface StorageSources {
  readonly projects: ReadonlyArray<Project>;
  readonly openThreads: ReadonlyArray<Thread>;
  /** `git worktree list` of a repo, linked worktrees only. */
  readonly listLinked: (
    repoTop: string,
  ) => Effect.Effect<ReadonlyArray<ListedWorktree>, WorktreeError>;
  /** The repo's PRs by head branch; `gh pr list` unless given. */
  readonly branchPrs?: (repoTop: string) => Effect.Effect<ReadonlyMap<string, BranchPr>>;
}

/** Every known repo's linked worktrees, grouped, with the free disk space. */
export const storageReport = (sources: StorageSources): Effect.Effect<StorageReport, never, Proc> =>
  scanStorage(sources).pipe(Effect.map((scan) => scan.report));

/** `storageReport`, with the HEAD each worktree was read at, so a removal can tell it moved. */
const scanStorage = (
  sources: StorageSources,
): Effect.Effect<
  { readonly report: StorageReport; readonly heads: ReadonlyMap<string, string | undefined> },
  never,
  Proc
> =>
  Effect.gen(function* () {
    const heads = new Map<string, string | undefined>();
    const repos = knownRepos(sources.projects);
    const failedRepos: string[] = [];
    const perRepo = yield* Effect.forEach(
      repos,
      (repoTop) =>
        Effect.gen(function* () {
          const listed = yield* sources.listLinked(repoTop).pipe(Effect.option);
          if (Option.isNone(listed)) {
            failedRepos.push(repoTop);
            return [];
          }
          if (listed.value.length === 0) return [];
          const base = yield* localBaseRef(repoTop).pipe(Effect.orElseSucceed(() => undefined));
          const prs = listed.value.some((w) => w.branch !== undefined)
            ? yield* sources.branchPrs?.(repoTop) ?? branchPrs(repoTop)
            : new Map<string, BranchPr>();
          return yield* Effect.forEach(
            listed.value,
            (entry) =>
              probeWorktree(entry.path, base).pipe(
                Effect.map((probe) => {
                  heads.set(entry.path, probe.head);
                  return storageEntry(entry, probe, {
                    repoTop,
                    openThreads: sources.openThreads,
                    pr: entry.branch === undefined ? undefined : prs.get(entry.branch),
                  });
                }),
              ),
            { concurrency: PROBES },
          );
        }),
      { concurrency: 2 },
    );
    const disk = yield* diskSpaceAt(repos[0] ?? homedir());
    return {
      report: { worktrees: perRepo.flat(), ...(disk === undefined ? {} : { disk }), failedRepos },
      heads,
    };
  });

/** `report`'s worktrees "Clean up inactive" would take after `days`, with what they free. */
export const cleanupPlan = (
  report: StorageReport,
  days: number,
  now: number,
): Effect.Effect<CleanupPlan> =>
  Effect.gen(function* () {
    const worktrees = report.worktrees.filter((entry) => inactiveCandidate(entry, days, now));
    const sizes = yield* Effect.forEach(
      worktrees.filter((entry) => !entry.missing),
      (entry) => cachedFolderSize(entry.path, PLAN_SIZE_BUDGET_MS),
      { concurrency: 3 },
    );
    return {
      worktrees,
      bytes: sizes.reduce((sum, size) => sum + size.bytes, 0),
      partial: sizes.some((size) => size.partial),
    };
  });

/** What `cleanUp` needs of the rest of the app. */
export interface CleanUpSources extends StorageSources {
  /** `git worktree remove`, with the one-thread-per-checkout guard. */
  readonly remove: (request: {
    readonly repoTop: string;
    readonly path: string;
    readonly force: boolean;
    readonly openCheckouts: ReadonlyArray<string>;
  }) => Effect.Effect<void, WorktreeError>;
  /** The open threads as they are now, read again right before each removal. */
  readonly currentThreads: Effect.Effect<ReadonlyArray<Thread>>;
}

/**
 * The entry as it stands right before removal: the threads read again and git asked again. A
 * moved HEAD, new uncommitted work or a lock shows here, so `keepReason` judges what would really
 * go rather than what the report saw.
 */
const recheckEntry = (
  entry: StorageWorktree,
  reportHead: string | undefined,
  probe: WorktreeProbe,
  threads: ReadonlyArray<Thread>,
): StorageWorktree => {
  const inUse = usedCheckoutPaths(threads).some((used) => samePath(used, entry.path));
  return {
    ...entry,
    group: inUse ? "inUse" : entry.group,
    missing: probe.missing,
    changedFiles: probe.changedFiles,
    // The report's count stands only while HEAD hasn't moved (a squash-merged PR head reads 0).
    unpushed: probe.head === reportHead ? entry.unpushed : probe.unpushed,
    ...(probe.unreadable ? { unreadable: true as const } : {}),
    ...(probe.locked ? { locked: true as const } : {}),
  };
};

/** One cleanup, by repo, for `reportCleanup`. */
export interface Cleaned {
  readonly repoTop: string;
  readonly bytes: number;
}

/** Lines in `git worktree prune --verbose` output: one per registration dropped. */
export const prunedCount = (output: string): number =>
  output.split("\n").filter((line) => line.trim().startsWith("Removing ")).length;

/** `git worktree prune` of one repo; how many registrations went. */
const pruneRepo = (repoTop: string): Effect.Effect<number, never, Proc> =>
  git(repoTop, ["worktree", "prune", "--verbose"]).pipe(
    Effect.map((out) => (out.status === 0 ? prunedCount(`${out.stdout}\n${out.stderr}`) : 0)),
    Effect.orElseSucceed(() => 0),
  );

/**
 * Removes the worktrees at `paths` that are still safe to, judged afresh: a thread may have opened
 * in one, or work landed in it, since the page was drawn. Branches stay.
 */
export const cleanUp = (
  sources: CleanUpSources,
  request: {
    readonly paths: ReadonlyArray<string>;
    readonly confirmed: ReadonlyArray<ConfirmedRemoval>;
    readonly prune: boolean;
  },
): Effect.Effect<
  { readonly result: CleanUpResult; readonly cleaned: ReadonlyArray<Cleaned> },
  never,
  Proc
> =>
  Effect.gen(function* () {
    const { report, heads } = yield* scanStorage(sources);
    const confirmed = request.confirmed;
    const removed: Array<{ path: string; bytes: number }> = [];
    const kept: Array<{ path: string; reason: string }> = [];
    const cleaned: Cleaned[] = [];
    const pruneRepos = new Set<string>();
    if (request.prune) for (const repo of knownRepos(sources.projects)) pruneRepos.add(repo);
    for (const path of request.paths) {
      // Exactly the path asked for: `samePath` also matches another spelling of the same folder.
      const reported = report.worktrees.find((w) => w.path === path);
      const reason = keepReason(reported, confirmed);
      if (reported === undefined || reason !== undefined) {
        kept.push({ path, reason: reason ?? "not found" });
        continue;
      }
      if (reported.missing) {
        // Nothing left on disk: dropping git's registration is all there is to do.
        pruneRepos.add(reported.repoTop);
        continue;
      }
      const size = yield* cachedFolderSize(path, PLAN_SIZE_BUDGET_MS);
      // Asked again with the size in hand: the report and the count take time, in which a thread
      // may have opened here or work landed.
      const threads = yield* sources.currentThreads;
      const entry = recheckEntry(
        reported,
        heads.get(path),
        yield* probeWorktree(path, undefined),
        threads,
      );
      if (entry.missing) {
        // Gone since the report: there is nothing left to remove, only git's record to prune.
        pruneRepos.add(entry.repoTop);
        continue;
      }
      const late = keepReason(entry, confirmed);
      if (late !== undefined) {
        kept.push({ path, reason: late });
        continue;
      }
      const outcome = yield* sources
        .remove({
          repoTop: entry.repoTop,
          path: entry.path,
          force: !losesNothing(entry),
          openCheckouts: usedCheckoutPaths(threads),
        })
        .pipe(Effect.result);
      if (outcome._tag === "Failure") {
        kept.push({ path, reason: outcome.failure.message });
        continue;
      }
      forgetFolderSize(path);
      removed.push({ path, bytes: size.bytes });
      cleaned.push({ repoTop: entry.repoTop, bytes: size.bytes });
    }
    let pruned = 0;
    for (const repoTop of pruneRepos) pruned += yield* pruneRepo(repoTop);
    return {
      result: {
        removed,
        kept,
        pruned,
        bytes: removed.reduce((sum, item) => sum + item.bytes, 0),
      },
      cleaned,
    };
  });

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Bytes as the digest says them: "1.2 GB", "340 MB". */
export const digestBytes = (bytes: number): string => {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${shown} ${UNITS[unit]}`;
};

/** The one digest line for a cleanup: "Cleaned 3 worktrees, 1.2 GB." */
export const cleanupNote = (count: number, bytes: number): string =>
  `Cleaned ${count} worktree${count === 1 ? "" : "s"}, ${digestBytes(bytes)}.`;

/**
 * Which workspaces each cleanup is told to, and the line each gets: a cleanup counts for every
 * workspace with a project in its repo, once per workspace however many worktrees went.
 */
export const cleanupNotes = (
  cleaned: ReadonlyArray<Cleaned & { readonly workspaceId?: WorkspaceId | undefined }>,
  workspaces: ReadonlyArray<Pick<WorkspaceState, "workspace">>,
  projects: ReadonlyArray<Project>,
): ReadonlyArray<{ readonly workspaceId: WorkspaceId; readonly note: string }> => {
  const totals = new Map<WorkspaceId, { count: number; bytes: number }>();
  for (const item of cleaned) {
    const repoProjects = projects.filter(
      (project) => project.repoRoot !== undefined && samePath(project.repoRoot, item.repoTop),
    );
    const ids = new Set<WorkspaceId>(item.workspaceId === undefined ? [] : [item.workspaceId]);
    for (const { workspace } of workspaces) {
      if (workspace.projectIds.some((id) => repoProjects.some((p) => p.id === id))) {
        ids.add(workspace.id);
      }
    }
    for (const id of ids) {
      const total = totals.get(id) ?? { count: 0, bytes: 0 };
      totals.set(id, { count: total.count + 1, bytes: total.bytes + item.bytes });
    }
  }
  return [...totals].map(([workspaceId, total]) => ({
    workspaceId,
    note: cleanupNote(total.count, total.bytes),
  }));
};
