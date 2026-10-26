// Thin git/gh wrappers over `Proc`, plus the small porcelain and rev-parse helpers shared by the
// worktree, state and diff modules.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as Effect from "effect/Effect";
import type { ProcError } from "./errors.ts";
import { canonicalizeOrOwned, fromGitPath } from "./paths.ts";
import { Proc, type ProcOutput, type RunOptions } from "./proc.ts";
import { splitGhInclude } from "./rate-limit-headers.ts";

export type GitOptions = Omit<RunOptions, "cwd">;

/**
 * Run `git` in `cwd`. `GIT_OPTIONAL_LOCKS=0` so a child killed at its bound can't strand an optional
 * `.git/index.lock` (SIGKILL bypasses git's tempfile cleanup).
 */
export const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  options: GitOptions = {},
): Effect.Effect<ProcOutput, ProcError, Proc> =>
  Effect.gen(function* () {
    const proc = yield* Proc;
    return yield* proc.run("git", args, {
      ...options,
      cwd,
      env: { GIT_OPTIONAL_LOCKS: "0", ...options.env },
    });
  });

const GH_TIMEOUT_MS = 10_000;

/** Run `gh` in `cwd`; bounded at 10 s by default since `gh` network calls are known to hang. */
export const gh = (
  cwd: string,
  args: ReadonlyArray<string>,
  options: GitOptions = {},
): Effect.Effect<ProcOutput, ProcError, Proc> =>
  Effect.gen(function* () {
    const proc = yield* Proc;
    return yield* proc.run("gh", args, { timeoutMs: GH_TIMEOUT_MS, ...options, cwd });
  });

/**
 * `gh api …` with the response headers asked for, and taken back off the output before the caller
 * parses it. The headers are for whoever wraps `Proc`: they carry GitHub's own count of the hour's
 * allowance, on a refusal too, and that is the only reading of it that can be trusted. `--include`
 * goes last so the arguments still open `api graphql …`.
 */
export const ghApi = (
  cwd: string,
  args: ReadonlyArray<string>,
  options: GitOptions = {},
): Effect.Effect<ProcOutput, ProcError, Proc> =>
  gh(cwd, ["api", ...args, "--include"], options).pipe(
    Effect.map((out) => ({ ...out, stdout: splitGhInclude(out.stdout).body })),
  );

/** What a failed command said: trimmed stderr, else stdout, else `fallback`. */
export const gitFailMsg = (out: ProcOutput, fallback: string): string => {
  if (out.stderr.trim() !== "") return out.stderr.trim();
  if (out.stdout.trim() !== "") return out.stdout.trim();
  return fallback.trim();
};

/**
 * The work-tree toplevel for `cwd`, or `undefined` outside a repo. A timed-out probe stays an error:
 * repo-ness is then unknown, never "not a repo".
 */
export const tryRepoTop = (cwd: string): Effect.Effect<string | undefined, ProcError, Proc> =>
  git(cwd, ["rev-parse", "--show-toplevel"]).pipe(
    Effect.map((out) => {
      const top = out.stdout.trim();
      return out.status === 0 && top !== "" ? fromGitPath(top) : undefined;
    }),
  );

/** `tryRepoTop` for callers whose "unknown" path is the same skip as "not a repo". */
export const repoTop = (cwd: string): Effect.Effect<string | undefined, never, Proc> =>
  tryRepoTop(cwd).pipe(Effect.orElseSucceed(() => undefined));

/** Whether `ref` resolves in `cwd`; a timeout reads as `false`. */
export const branchExists = (cwd: string, ref: string): Effect.Effect<boolean, never, Proc> =>
  git(cwd, ["rev-parse", "--verify", "--quiet", ref]).pipe(
    Effect.map((out) => out.status === 0),
    Effect.orElseSucceed(() => false),
  );

export interface RepoRoots {
  /** The shared `.git` of the repo and all its linked worktrees. */
  readonly common: string;
  /** This checkout's working-tree toplevel. */
  readonly top: string;
  /** This checkout's own git dir: `common` for the main checkout, below it for a linked worktree. */
  readonly gitDir: string;
}

/** The watch roots and the checkout's git dir in one spawn, canonicalised; `undefined` for a non-repo or a bare repo. */
export const tryRepoRoots = (cwd: string): Effect.Effect<RepoRoots | undefined, ProcError, Proc> =>
  git(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
    "--show-toplevel",
    "--git-dir",
  ]).pipe(
    Effect.map((out) => {
      const [common, top, gitDir] = out.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      return common !== undefined && top !== undefined && gitDir !== undefined
        ? {
            common: canonicalizeOrOwned(common),
            top: canonicalizeOrOwned(top),
            gitDir: canonicalizeOrOwned(gitDir),
          }
        : undefined;
    }),
  );

/** Changed entries in `git status --porcelain` output. CR-tolerant. */
export const porcelainChanges = (stdout: string): number =>
  stdout.split("\n").filter((line) => line.trim() !== "").length;

/**
 * The working-tree path of one porcelain line (run with `core.quotepath=false`): skip the status
 * columns, take a rename/copy destination, strip quotes. Not a full C unquoter.
 */
export const porcelainPath = (line: string): string | undefined => {
  const trimmedLine = line.replace(/\r$/, "");
  if (trimmedLine.length < 3) return undefined;
  const rest = trimmedLine.slice(3);
  const code = trimmedLine.slice(0, 2);
  const target = /[RC]/.test(code) ? (rest.split(" -> ").at(-1) ?? rest) : rest;
  const path = target.trim().replace(/^"+|"+$/g, "");
  return path === "" ? undefined : path;
};

/** A stable, cheap, non-cryptographic-purpose digest of `parts`. */
export const stableHash = (parts: ReadonlyArray<string | number | bigint>): string => {
  const hash = createHash("sha1");
  for (const part of parts) {
    hash.update(String(part));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
};

/**
 * A content signal for the dirty entries, folded into `changesToken`: porcelain reports codes and
 * names only, so a second edit to an already-dirty file leaves it byte-identical. One `stat` per
 * entry: size, mtime, and on Unix inode + ctime (an editor's atomic save can keep size and mtime).
 */
export const dirtyContentHash = (workTree: string, status: string): string => {
  const parts: Array<string | bigint> = [];
  for (const line of status.split("\n")) {
    const path = porcelainPath(line);
    if (path === undefined) continue;
    try {
      const stat = fs.statSync(nodePath.join(workTree, path), { bigint: true });
      parts.push(path, stat.size, stat.mtimeNs, stat.ino, stat.ctimeNs);
    } catch {
      // A deleted entry contributes nothing; its status code already moved the porcelain text.
    }
  }
  return stableHash(parts);
};
