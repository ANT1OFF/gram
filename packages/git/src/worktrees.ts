// The worktree workflow: list, create (reusing an existing checkout for the branch), remove with the
// dirty guard and fs fallback, and the permission checklist. The caller owns thread state, so the
// one-thread-per-checkout guard takes the open checkouts as an argument.

import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { Checkout, WorktreeEntry } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  mergeSelectedIntoRoot,
  newRules,
  readPermissionRules,
  seedWorktreePermissions,
} from "./claude-settings.ts";
import { WorktreeError } from "./errors.ts";
import {
  branchExists,
  git,
  gitFailMsg,
  porcelainChanges,
  tryRepoRoots,
  tryRepoTop,
} from "./exec.ts";
import { expandHome, fromGitPath, isDir, mtimeMs, samePathKey, tryRealPathSync } from "./paths.ts";
import { Proc } from "./proc.ts";
import { listBaseRefs, localBaseRef, originBaseRef } from "./refs.ts";
import { copyWorktreeIncludes } from "./worktree-include.ts";

const invalid = (message: string) =>
  new WorktreeError({ reason: "invalidRequest", message, dirty: false });
const conflict = (message: string) =>
  new WorktreeError({ reason: "conflict", message, dirty: false });
const failed = (message: string) => new WorktreeError({ reason: "failed", message, dirty: false });
const toFailed = (error: { readonly message: string }) => failed(error.message);

// ---------------------------------------------------------------------------------------------
// Pure decisions

/** One checkout from `git worktree list --porcelain`. Bare entries never appear. */
export interface ParsedWorktree {
  readonly path: string;
  /** `refs/heads/` stripped; `undefined` when detached. */
  readonly branch: string | undefined;
  readonly detached: boolean;
}

/** Parse porcelain listing. The MAIN checkout stays first; bare and `worktree`-less blocks drop. */
export const parseWorktrees = (stdout: string): Array<ParsedWorktree> => {
  const out: Array<ParsedWorktree> = [];
  for (const rawBlock of stdout.replaceAll("\r\n", "\n").split("\n\n")) {
    const block = rawBlock.trim();
    if (block === "") continue;
    let path: string | undefined;
    let branch: string | undefined;
    let detached = false;
    let bare = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("branch "))
        branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      else if (line === "detached") detached = true;
      else if (line === "bare") bare = true;
    }
    if (path !== undefined && !bare) out.push({ path, branch, detached });
  }
  return out;
};

/** `parseWorktrees` with paths in the platform's spelling (git prints `C:/…` on Windows). */
const parseWorktreesNative = (stdout: string): Array<ParsedWorktree> =>
  parseWorktrees(stdout).map((w) => ({ ...w, path: fromGitPath(w.path) }));

/** ASCII alnum plus `. _ / -`, no leading `-` (git would read an option). Gates refs entering argv. */
export const isValidGitRefCharset = (raw: string): boolean =>
  raw !== "" && !raw.startsWith("-") && /^[A-Za-z0-9._/-]+$/.test(raw);

/** The branch that may enter git argv, or `undefined` when invalid. */
export const sanitizeBranch = (raw: string): string | undefined =>
  isValidGitRefCharset(raw) &&
  raw !== "HEAD" &&
  !raw.includes("..") &&
  !raw.endsWith(".") &&
  raw.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"))
    ? raw
    : undefined;

/** Names Windows reserves for devices, alone or before an extension (`con`, `aux.x`, `com1`). */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * The folder under `.worktrees/`: slashes flattened. A name Windows reserves for a device gets a
 * `wt-` prefix, since no folder can carry it there.
 */
export const folderName = (safeBranch: string): string => {
  const flat = safeBranch.replaceAll("/", "-");
  return WINDOWS_DEVICE_NAME.test(flat) ? `wt-${flat}` : flat;
};

export interface Placement {
  readonly worktreeDir: string;
  /** An existing registered checkout is reused; no `git worktree add`. */
  readonly reuse: boolean;
  /** The target is the repo's main checkout (the branch already lives there). */
  readonly isMainCheckout: boolean;
  readonly folderName: string;
}

/**
 * Where a create lands, before any git mutation: the checkout that already has `rawBranch` (matched
 * on the raw string, so an unrepresentable branch still finds its checkout), else
 * `<repo>/.worktrees/<folder>`. Only an exact branch match may reuse a checkout.
 */
export const planPlacement = (
  worktrees: ReadonlyArray<ParsedWorktree>,
  repoTop: string,
  rawBranch: string,
  safeBranch: string,
): Placement => {
  const existing = worktrees.find(
    (w) => rawBranch !== "" && w.branch === rawBranch && isDir(w.path),
  );
  const folder = folderName(safeBranch);
  const worktreeDir = existing?.path ?? nodePath.join(repoTop, ".worktrees", folder);
  const target = samePathKey(worktreeDir);
  const reuse = existing !== undefined;
  return {
    worktreeDir,
    reuse,
    isMainCheckout: target === samePathKey(repoTop),
    folderName: folder,
  };
};

/** Whether a thread is already open in `dir`: one thread per checkout. */
export const checkoutInUse = (openCheckouts: ReadonlyArray<string>, dir: string): boolean => {
  const target = samePathKey(dir);
  return openCheckouts.some((open) => samePathKey(open) === target);
};

/**
 * `git worktree remove` stderr that reads like a dirty/locked refusal. Locale-fragile (git localises
 * it), so only a secondary signal behind the porcelain check.
 */
export const matchesDirtyStderr = (error: string): boolean => {
  const lower = error.toLowerCase();
  return (
    lower.includes("modified or untracked") ||
    lower.includes("contains modified") ||
    (lower.includes("use ") && lower.includes("--force")) ||
    lower.includes("locked") ||
    lower.includes("not empty")
  );
};

// ---------------------------------------------------------------------------------------------
// Effects

const resolveRepoPath = (repoPath: string | undefined) => {
  const path = expandHome(repoPath ?? "");
  return path !== "" && fs.existsSync(path)
    ? Effect.succeed(path)
    : Effect.fail(invalid("repoPath must exist"));
};

const resolveRepoTop = (repoPath: string) =>
  tryRepoTop(repoPath).pipe(
    Effect.mapError(toFailed),
    Effect.flatMap((top) =>
      top === undefined
        ? Effect.fail(invalid("repoPath is not a git repository"))
        : Effect.succeed(top),
    ),
  );

const listParsed = (repoTop: string) =>
  git(repoTop, ["worktree", "list", "--porcelain"]).pipe(
    Effect.map((out) => (out.status === 0 ? parseWorktreesNative(out.stdout) : [])),
    Effect.orElseSucceed((): Array<ParsedWorktree> => []),
  );

export interface ListOptions {
  readonly openCheckouts: ReadonlyArray<string>;
  /** Epoch ms of the last agent activity in a checkout; 0 when unknown. */
  readonly lastActivity?: ((path: string) => number) | undefined;
}

export interface WorktreeList {
  readonly repoTop: string;
  readonly worktrees: ReadonlyArray<WorktreeEntry>;
}

/** Each worktree's HEAD commit, keyed by native path; an unborn HEAD has none. */
const parseWorktreeHeads = (stdout: string): Map<string, string> => {
  const heads = new Map<string, string>();
  for (const block of stdout.replaceAll("\r\n", "\n").split("\n\n")) {
    const lines = block.trim().split("\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    const head = lines.find((line) => line.startsWith("HEAD "))?.slice("HEAD ".length);
    if (path !== undefined && head !== undefined && !/^0+$/.test(head)) {
      heads.set(fromGitPath(path), head);
    }
  }
  return heads;
};

/** Committer time in epoch ms per commit, in one spawn; missing entries mean "unknown". */
const commitTimes = (repoTop: string, shas: ReadonlyArray<string>) =>
  shas.length === 0
    ? Effect.succeed(new Map<string, number>())
    : git(repoTop, ["show", "-s", "--format=%H %ct", ...new Set(shas)]).pipe(
        Effect.map((out) => {
          const times = new Map<string, number>();
          if (out.status !== 0) return times;
          for (const line of out.stdout.split("\n")) {
            const [sha, seconds] = line.trim().split(" ");
            if (sha && seconds) times.set(sha, Number(seconds) * 1000);
          }
          return times;
        }),
        Effect.orElseSucceed(() => new Map<string, number>()),
      );

/**
 * The repo's worktrees. Without agent activity, `lastActivity` is the time of the worktree's HEAD
 * commit, else the folder's mtime, else 0.
 */
export const listWorktrees = (repoPath: string, options: ListOptions) =>
  Effect.gen(function* () {
    const repoTop = yield* resolveRepoTop(yield* resolveRepoPath(repoPath));
    const out = yield* git(repoTop, ["worktree", "list", "--porcelain"]).pipe(
      Effect.mapError(toFailed),
    );
    if (out.status !== 0)
      return yield* Effect.fail(invalid(gitFailMsg(out, "git worktree list failed")));
    const open = new Set(options.openCheckouts.map((path) => samePathKey(path)));
    const heads = parseWorktreeHeads(out.stdout);
    const times = yield* commitTimes(repoTop, [...heads.values()]);
    const worktrees = parseWorktreesNative(out.stdout).map((w, i): WorktreeEntry => {
      const activity = options.lastActivity?.(w.path) ?? 0;
      const head = heads.get(w.path);
      const committed = head === undefined ? 0 : (times.get(head) ?? 0);
      return {
        path: w.path,
        ...(w.branch === undefined ? {} : { branch: w.branch }),
        detached: w.detached,
        isMain: i === 0,
        isOpen: open.has(samePathKey(w.path)),
        lastActivity: activity > 0 ? activity : committed > 0 ? committed : mtimeMs(w.path),
      };
    });
    return { repoTop, worktrees } satisfies WorktreeList;
  });

export interface BaseBranches {
  readonly branches: ReadonlyArray<string>;
  /** What an empty picker bases on; absent when nothing resolves (then: current HEAD). */
  readonly default?: string;
}

export const baseBranches = (repoPath: string) =>
  Effect.gen(function* () {
    const repoTop = yield* resolveRepoTop(yield* resolveRepoPath(repoPath));
    const branches = yield* listBaseRefs(repoTop);
    const fallback = yield* localBaseRef(repoTop);
    return {
      branches,
      ...(fallback === undefined ? {} : { default: fallback }),
    } satisfies BaseBranches;
  });

/** A usable `base` override: charset-gated and resolvable, else `undefined` (silent fallback). */
export const sanitizeBase = (
  repoTop: string,
  raw: string,
): Effect.Effect<string | undefined, never, Proc> => {
  const base = raw.trim();
  if (!isValidGitRefCharset(base)) return Effect.succeed(undefined);
  return branchExists(repoTop, base).pipe(Effect.map((ok) => (ok ? base : undefined)));
};

/**
 * One `git worktree add`: an existing local branch is checked out; a new branch starts from the
 * override, else an up-to-date origin default, else HEAD. Then `.worktreeinclude` copy and
 * permission seeding.
 */
export const addWorktree = (
  repoTop: string,
  safeBranch: string,
  worktreeDir: string,
  baseOverride: string | undefined,
) =>
  Effect.gen(function* () {
    // A checkout under `.worktrees/<branch>` can pass Windows' 260-character path limit, as removal can.
    const args = ["-c", "core.longpaths=true", "worktree", "add"];
    let startPoint: string | undefined;
    if (yield* branchExists(repoTop, safeBranch)) {
      startPoint = safeBranch;
    } else {
      // A new branch doesn't track its base: with `origin/main` as its upstream, a plain `git push`
      // refuses the name mismatch and the base reads as the branch's own pushed tip. Publishing sets it.
      args.push("--no-track", "-b", safeBranch);
      startPoint = baseOverride ?? (yield* originBaseRef(repoTop));
    }
    args.push(worktreeDir);
    if (startPoint !== undefined) args.push(startPoint);
    const out = yield* git(repoTop, args, { tier: "slow" }).pipe(Effect.mapError(toFailed));
    if (out.status !== 0) {
      return yield* Effect.fail(invalid(`git worktree failed: ${gitFailMsg(out, "")}`));
    }
    const copiedIncludes = yield* copyWorktreeIncludes(repoTop, worktreeDir);
    yield* seedWorktreePermissions(repoTop, worktreeDir);
    return { copiedIncludes, startPoint };
  });

export interface CreateWorktreeRequest {
  readonly repoPath: string;
  /** Required: a missing or unrepresentable branch is refused. */
  readonly branch?: string | undefined;
  /** Start point for a NEW branch; unresolvable values fall back silently. */
  readonly base?: string | undefined;
  readonly openCheckouts: ReadonlyArray<string>;
}

/** A line that already keeps the worktrees folder out of `git status`. */
const EXCLUDES_WORKTREES = /^\/?\.worktrees\/?\s*$/;

/**
 * Lists `.worktrees/` in the common git dir's `info/exclude`, never `.gitignore`, so the main
 * checkout's status doesn't show the folder as untracked. Added once, after the file's content and
 * in its line endings; the file is created when missing.
 */
export const excludeWorktreesFolder = (commonDir: string): void => {
  const file = nodePath.join(commonDir, "info", "exclude");
  let content = "";
  try {
    content = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (content.split(/\r?\n/).some((line) => EXCLUDES_WORKTREES.test(line))) return;
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const separator = content === "" || content.endsWith("\n") ? "" : eol;
  fs.mkdirSync(nodePath.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${separator}.worktrees/${eol}`);
};

export interface CreatedWorktree {
  readonly repoTop: string;
  readonly checkout: Checkout;
  readonly reused: boolean;
  readonly copiedIncludes: number;
}

export const createWorktree = (request: CreateWorktreeRequest) =>
  Effect.gen(function* () {
    const repoPath = yield* resolveRepoPath(request.repoPath);
    const rawBranch = (request.branch ?? "").trim();
    const safeBranch = sanitizeBranch(rawBranch);
    if (safeBranch === undefined)
      return yield* Effect.fail(invalid("branch must be a valid git branch name"));
    const repoTop = yield* resolveRepoTop(repoPath);
    const baseOverride =
      request.base === undefined ? undefined : yield* sanitizeBase(repoTop, request.base);

    // Prune first so a manually deleted worktree can't be "found" and handed out as a missing cwd.
    yield* Effect.ignore(git(repoTop, ["worktree", "prune"]));
    const worktrees = yield* listParsed(repoTop);
    const plan = planPlacement(worktrees, repoTop, rawBranch, safeBranch);
    if (plan.reuse && checkoutInUse(request.openCheckouts, plan.worktreeDir)) {
      return yield* Effect.fail(conflict("a thread is already open in that checkout"));
    }
    if (!plan.reuse && fs.existsSync(plan.worktreeDir)) {
      return yield* Effect.fail(
        invalid("the worktree folder already exists; choose a different branch name"),
      );
    }
    const added = plan.reuse
      ? { copiedIncludes: 0, startPoint: undefined }
      : yield* addWorktree(repoTop, safeBranch, plan.worktreeDir, baseOverride);
    // Reused checkouts too, so repos whose worktrees predate this get the line on their next open.
    // A git dir that can't be written doesn't block the checkout.
    if (!plan.isMainCheckout) {
      const roots = yield* tryRepoRoots(repoTop).pipe(Effect.orElseSucceed(() => undefined));
      if (roots !== undefined) {
        yield* Effect.try(() => excludeWorktreesFolder(roots.common)).pipe(Effect.ignore);
      }
    }
    const branch = rawBranch === "" ? undefined : rawBranch;
    const base = baseOverride ?? added.startPoint;
    const checkout: Checkout = {
      kind: plan.isMainCheckout ? "main" : "worktree",
      path: plan.worktreeDir,
      ...(branch === undefined ? {} : { branch }),
      ...(base === undefined || base === branch ? {} : { base }),
      ...(plan.isMainCheckout ? {} : { repoRoot: repoTop }),
    };
    return {
      repoTop,
      checkout,
      reused: plan.reuse,
      copiedIncludes: added.copiedIncludes,
    } satisfies CreatedWorktree;
  });

/**
 * Whether `origin` has `branch`, asked of origin itself (`ls-remote`): `absent` also when the repo
 * has no `origin`, while a network or sign-in failure fails, since it says nothing of the branch.
 */
const originBranch = (repoTop: string, branch: string) =>
  Effect.gen(function* () {
    const url = yield* git(repoTop, ["remote", "get-url", "origin"]).pipe(
      Effect.mapError(toFailed),
    );
    if (url.status !== 0) return "absent" as const;
    const out = yield* git(
      repoTop,
      [
        "-c",
        "credential.interactive=false",
        "ls-remote",
        "--exit-code",
        "origin",
        `refs/heads/${branch}`,
      ],
      { tier: "network" },
    ).pipe(Effect.mapError(toFailed));
    // `--exit-code`: 2 when origin answered and has no such ref.
    if (out.status === 0) return "present" as const;
    if (out.status === 2) return "absent" as const;
    return yield* Effect.fail(
      failed(`couldn't ask origin for ${branch}: ${gitFailMsg(out, "git ls-remote failed")}`),
    );
  });

export interface RestoreWorktreeRequest {
  readonly repoPath: string;
  /** Where the worktree was, to be recreated there. */
  readonly worktreeDir: string;
  readonly branch: string;
  /** The PR whose head recreates the branch when neither the repo nor `origin` has it. */
  readonly fromPr?: number | undefined;
  readonly openCheckouts: ReadonlyArray<string>;
}

/** What `restoreWorktree` did: `branchGone` changed nothing, since no branch was found to restore. */
export type RestoredWorktree =
  | { readonly kind: "restored"; readonly source: "local" | "origin" | "pr" }
  | { readonly kind: "branchGone" };

/**
 * Recreates a worktree deleted outside git (`rm -rf`) or by `git worktree remove`, at `worktreeDir`
 * on `branch`: its stale registration pruned, then the local branch checked out, else `origin`'s
 * fetched, else (`fromPr`) the PR's head fetched as the branch. Then `.worktreeinclude` and the
 * permission seeding a new worktree gets. A folder already at `worktreeDir`, or the branch checked
 * out elsewhere, refuses.
 */
export const restoreWorktree = (request: RestoreWorktreeRequest) =>
  Effect.gen(function* () {
    const repoTop = yield* resolveRepoTop(yield* resolveRepoPath(request.repoPath));
    const branch = request.branch.trim();
    if (!isValidGitRefCharset(branch)) {
      return yield* Effect.fail(invalid("branch must be a valid git branch name"));
    }
    if (fs.existsSync(request.worktreeDir)) {
      return yield* Effect.fail(
        invalid(`${request.worktreeDir} exists already: nothing to restore`),
      );
    }
    if (checkoutInUse(request.openCheckouts, request.worktreeDir)) {
      return yield* Effect.fail(conflict("A thread is open on this worktree — close it first."));
    }
    // The deleted folder is still registered until pruned, and git refuses to add over it.
    yield* git(repoTop, ["worktree", "prune"]).pipe(Effect.mapError(toFailed));
    const holder = (yield* listParsed(repoTop)).find((w) => w.branch === branch);
    if (holder !== undefined) {
      return yield* Effect.fail(conflict(`${branch} is checked out in ${holder.path}`));
    }
    const add = (args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const out = yield* git(repoTop, ["-c", "core.longpaths=true", "worktree", "add", ...args], {
          tier: "slow",
        }).pipe(Effect.mapError(toFailed));
        if (out.status !== 0) {
          return yield* Effect.fail(invalid(`git worktree failed: ${gitFailMsg(out, "")}`));
        }
      });
    let source: "local" | "origin" | "pr";
    if (yield* branchExists(repoTop, `refs/heads/${branch}`)) {
      yield* add([request.worktreeDir, branch]);
      source = "local";
    } else {
      // Only the remote may still have it, e.g. once the local branch was deleted after a merge.
      // Asked of origin itself: a remote-tracking ref can outlive the branch GitHub deleted.
      const remote = yield* originBranch(repoTop, branch);
      if (remote === "present") {
        const fetched = yield* git(
          repoTop,
          ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
          { tier: "network" },
        ).pipe(Effect.mapError(toFailed));
        if (fetched.status !== 0) {
          return yield* Effect.fail(
            failed(`couldn't fetch ${branch}: ${gitFailMsg(fetched, "git fetch failed")}`),
          );
        }
        yield* add(["-b", branch, request.worktreeDir, `origin/${branch}`]);
        source = "origin";
      } else if (request.fromPr !== undefined) {
        // A ref of its own rather than the shared `FETCH_HEAD`, which a sibling worktree's
        // background fetch can overwrite between the fetch and the read.
        const ref = `refs/gram/restore/pr-${request.fromPr}-${process.pid}-${Date.now()}`;
        const fetched = yield* git(
          repoTop,
          ["fetch", "origin", `+refs/pull/${request.fromPr}/head:${ref}`],
          { tier: "network" },
        ).pipe(Effect.mapError(toFailed));
        if (fetched.status !== 0) {
          return yield* Effect.fail(
            failed(`couldn't fetch the PR's head: ${gitFailMsg(fetched, "git fetch failed")}`),
          );
        }
        // No upstream: `origin/<branch>` is gone, and publishing sets one.
        yield* add(["--no-track", "-b", branch, request.worktreeDir, ref]).pipe(
          Effect.ensuring(Effect.ignore(git(repoTop, ["update-ref", "-d", ref]))),
        );
        source = "pr";
      } else {
        return { kind: "branchGone" } satisfies RestoredWorktree;
      }
    }
    yield* copyWorktreeIncludes(repoTop, request.worktreeDir);
    yield* seedWorktreePermissions(repoTop, request.worktreeDir);
    const roots = yield* tryRepoRoots(repoTop).pipe(Effect.orElseSucceed(() => undefined));
    if (roots !== undefined) {
      yield* Effect.try(() => excludeWorktreesFolder(roots.common)).pipe(Effect.ignore);
    }
    return { kind: "restored", source } satisfies RestoredWorktree;
  });

export type WorktreeCleanliness = "clean" | "dirty" | "unknown";

/**
 * Whether the checkout holds uncommitted work, via porcelain (locale-proof). `unknown` when git
 * can't say: an unreadable index or status, or `dir` not being its OWN toplevel (`git status` walks
 * up, so a half-removed worktree would report the enclosing repo's state). A missing `dir` is
 * `clean`: nothing is left to lose.
 */
export const worktreeCleanliness = (dir: string): Effect.Effect<WorktreeCleanliness, never, Proc> =>
  Effect.gen(function* () {
    if (!fs.existsSync(dir)) return "clean" as const;
    const top = yield* git(dir, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
    const own = tryRealPathSync(dir);
    if (top.status !== 0 || own === undefined || tryRealPathSync(top.stdout.trim()) !== own)
      return "unknown" as const;
    const status = yield* git(dir, ["status", "--porcelain"]);
    if (status.status !== 0 || status.truncated) return "unknown" as const;
    return porcelainChanges(status.stdout) > 0 ? ("dirty" as const) : ("clean" as const);
  }).pipe(Effect.orElseSucceed(() => "unknown" as const));

/** Whether `dir` is a registered NON-main worktree of the repo. Case-sensitive where the fs is. */
export const isRegisteredWorktree = (
  repoPath: string,
  dir: string,
): Effect.Effect<boolean, never, Proc> =>
  Effect.gen(function* () {
    const target = tryRealPathSync(dir);
    if (target === undefined) return false;
    const worktrees = yield* listParsed(repoPath);
    return worktrees.slice(1).some((w) => tryRealPathSync(w.path) === target);
  });

/** `rm -rf` with retries for a just-released Windows file lock; an absent dir counts as done. */
export const removeDirAllResilient = (path: string): Effect.Effect<void, WorktreeError> =>
  Effect.gen(function* () {
    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.rmSync(path, { recursive: true, force: true });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < 2) yield* Effect.sleep("150 millis");
      }
    }
    return yield* Effect.fail(failed(`couldn't delete the worktree directory: ${lastError}`));
  });

/**
 * The git side of removal. A dirty refusal fails with `dirty: true` (offer force), and so does a
 * checkout whose status git can't read: without force the dir is deleted only once git has shown it
 * clean. Otherwise git couldn't FINISH (long path, held file): delete the dir ourselves, but only
 * when it is still a registered non-main worktree, then prune, so a retry converges.
 */
export const removeWorktreeDir = (repoPath: string, worktreeDir: string, force: boolean) =>
  Effect.gen(function* () {
    const args = ["-c", "core.longpaths=true", "worktree", "remove", worktreeDir];
    if (force) args.push("--force");
    const out = yield* git(repoPath, args, { tier: "slow" }).pipe(Effect.mapError(toFailed));
    if (out.status === 0) return;
    const error = gitFailMsg(out, "git worktree remove failed");
    if (!force) {
      const state = matchesDirtyStderr(error) ? "dirty" : yield* worktreeCleanliness(worktreeDir);
      if (state !== "clean") {
        const message =
          state === "dirty" ? error : `git couldn't read the worktree's status: ${error}`;
        return yield* Effect.fail(
          new WorktreeError({ reason: "invalidRequest", message, dirty: true }),
        );
      }
    }
    if (yield* isRegisteredWorktree(repoPath, worktreeDir)) {
      yield* removeDirAllResilient(worktreeDir);
    }
    const prune = yield* git(repoPath, ["worktree", "prune"]).pipe(Effect.mapError(toFailed));
    if (prune.status !== 0) {
      return yield* Effect.fail(failed(gitFailMsg(prune, "git worktree prune failed")));
    }
  });

export interface RemoveWorktreeRequest {
  readonly repoPath: string;
  readonly worktreeDir: string;
  readonly force?: boolean | undefined;
  /** Checklist picks to union back into the root settings; merged only after a successful remove. */
  readonly mergeRules?: ReadonlyArray<string> | undefined;
  readonly openCheckouts: ReadonlyArray<string>;
}

export const removeWorktree = (request: RemoveWorktreeRequest) =>
  Effect.gen(function* () {
    if (request.worktreeDir === "") return yield* Effect.fail(invalid("worktreeDir required"));
    const repoPath = yield* resolveRepoPath(request.repoPath);
    if (checkoutInUse(request.openCheckouts, request.worktreeDir)) {
      return yield* Effect.fail(conflict("A thread is open on this worktree — close it first."));
    }
    const selected = request.mergeRules ?? [];
    const pending =
      selected.length > 0 && (yield* isRegisteredWorktree(repoPath, request.worktreeDir))
        ? readPermissionRules(request.worktreeDir)
        : undefined;
    yield* removeWorktreeDir(repoPath, request.worktreeDir, request.force ?? false);
    if (pending !== undefined) {
      const repoTop = yield* tryRepoTop(repoPath).pipe(Effect.orElseSucceed(() => undefined));
      if (repoTop !== undefined) yield* mergeSelectedIntoRoot(repoTop, pending, selected);
    }
  });

/** Rules approved inside a registered worktree that the root lacks (excluded ones filtered). */
export const pendingPermissions = (repoPath: string, worktreeDir: string) =>
  Effect.gen(function* () {
    const repoTop = yield* resolveRepoTop(yield* resolveRepoPath(repoPath));
    if (!(yield* isRegisteredWorktree(repoTop, worktreeDir))) {
      return yield* Effect.fail(invalid("worktreeDir is not a registered worktree of this repo"));
    }
    return newRules(readPermissionRules(worktreeDir), readPermissionRules(repoTop));
  });

// ---------------------------------------------------------------------------------------------
// Service

export class Worktrees extends Context.Service<
  Worktrees,
  {
    readonly list: (
      repoPath: string,
      options: ListOptions,
    ) => Effect.Effect<WorktreeList, WorktreeError>;
    readonly baseBranches: (repoPath: string) => Effect.Effect<BaseBranches, WorktreeError>;
    readonly create: (
      request: CreateWorktreeRequest,
    ) => Effect.Effect<CreatedWorktree, WorktreeError>;
    readonly remove: (request: RemoveWorktreeRequest) => Effect.Effect<void, WorktreeError>;
    readonly restore: (
      request: RestoreWorktreeRequest,
    ) => Effect.Effect<RestoredWorktree, WorktreeError>;
    readonly pendingPermissions: (
      repoPath: string,
      worktreeDir: string,
    ) => Effect.Effect<ReadonlyArray<string>, WorktreeError>;
  }
>()("@gram/git/Worktrees") {}

export const WorktreesLive = Layer.effect(
  Worktrees,
  Effect.gen(function* () {
    const proc = yield* Proc;
    const provide = Effect.provideService(Proc, proc);
    return {
      list: (repoPath, options) => provide(listWorktrees(repoPath, options)),
      baseBranches: (repoPath) => provide(baseBranches(repoPath)),
      create: (request) => provide(createWorktree(request)),
      remove: (request) => provide(removeWorktree(request)),
      restore: (request) => provide(restoreWorktree(request)),
      pendingPermissions: (repoPath, worktreeDir) =>
        provide(pendingPermissions(repoPath, worktreeDir)),
    };
  }),
);
