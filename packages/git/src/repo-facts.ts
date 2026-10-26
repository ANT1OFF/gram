// What the git sweep asks of every checkout on every pass although it rarely changes: the repo's
// roots and `origin`'s URL. Each is a `git` run, and asked of eight checkouts every 15 s they were a
// third of an idle server's processes. Kept per checkout they cost a few `stat`s instead:
//
// - the roots stand while the checkout, its toplevel and its git dir are all there and are still
//   the same repo: a removed worktree is asked again (and found gone) on its next read, and a
//   clone, `git init` or new worktree in its folder is read anew, its `.git` being another file;
// - the URL stands while the repo's config files are unchanged, so `git remote set-url`, `remote
//   add` or a new clone in the same folder is read at once.
//
// Both are asked again after `REPO_FACTS_TTL_MS` regardless, for config no stat sees (an include,
// the global file). A path that isn't on disk is never kept, so fakes answering for made-up paths
// see every call. Kept per `Proc`, as the PR resolver is, so a test's fake never shares a cache.

import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as Effect from "effect/Effect";
import type { ProcError } from "./errors.ts";
import { git, tryRepoRoots, type RepoRoots } from "./exec.ts";
import { tryRealPathSync } from "./paths.ts";
import { Proc } from "./proc.ts";

/** How long a kept root or URL answers before it is asked again, unchanged files or not. */
export const REPO_FACTS_TTL_MS = 5 * 60_000;

interface Kept<A> {
  readonly value: A;
  readonly at: number;
}

interface Facts {
  /** With the checkout's `rootsIdentity` as it was read. */
  readonly roots: Map<string, Kept<RepoRoots> & { readonly identity: string }>;
  /** With the config stamp it was read under. */
  readonly origins: Map<string, Kept<string | undefined> & { readonly stamp: string }>;
}

const byProc = new WeakMap<Proc["Service"], Facts>();

const factsOf = (proc: Proc["Service"]): Facts => {
  const existing = byProc.get(proc);
  if (existing !== undefined) return existing;
  const created: Facts = { roots: new Map(), origins: new Map() };
  byProc.set(proc, created);
  return created;
};

const present = (path: string): boolean => {
  try {
    return fs.existsSync(path);
  } catch {
    return false;
  }
};

/** Identity of one file as of now: `-` when it doesn't exist, `undefined` when it can't be read. */
const fileStamp = (path: string): string | undefined => {
  try {
    const stat = fs.statSync(path, { throwIfNoEntry: false });
    return stat === undefined ? "-" : `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
};

/**
 * What says `roots` still answer for `cwd`: where `cwd` resolves to, whether it holds a `.git` of its
 * own (a repo started below a toplevel), and which `.git` the toplevel has. A clone, `git init` or
 * worktree made where another was leaves a new `.git`, so another inode and birth time, even when
 * the old git dir is still there. `undefined` when any of it can't be read.
 */
const rootsIdentity = (cwd: string, roots: RepoRoots): string | undefined => {
  const real = tryRealPathSync(cwd);
  if (real === undefined) return undefined;
  try {
    // As bigints: on NTFS a file index past 2^53 would round as a number.
    const dotGit = fs.statSync(nodePath.join(roots.top, ".git"), {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (dotGit === undefined) return undefined;
    const own = present(nodePath.join(cwd, ".git"));
    // Where the filesystem keeps no birth time, the change time stands in, missing more often.
    const born = dotGit.birthtimeNs === 0n ? `c${dotGit.ctimeNs}` : `${dotGit.birthtimeNs}`;
    return `${real}|${own}|${dotGit.dev}:${dotGit.ino}:${born}`;
  } catch {
    return undefined;
  }
};

/** The repo's own config files as of now: the shared one and the checkout's `config.worktree`. */
const configStamp = (roots: RepoRoots): string | undefined => {
  const shared = fileStamp(nodePath.join(roots.common, "config"));
  const own = fileStamp(nodePath.join(roots.gitDir, "config.worktree"));
  return shared === undefined || own === undefined ? undefined : `${roots.common}|${shared}|${own}`;
};

/** `tryRepoRoots`, kept per checkout while its folders stand and are still that repo's. */
export const cachedRepoRoots = (
  cwd: string,
): Effect.Effect<RepoRoots | undefined, ProcError, Proc> =>
  Effect.gen(function* () {
    const facts = factsOf(yield* Proc);
    const kept = facts.roots.get(cwd);
    if (
      kept !== undefined &&
      Date.now() - kept.at < REPO_FACTS_TTL_MS &&
      present(kept.value.gitDir) &&
      rootsIdentity(cwd, kept.value) === kept.identity
    ) {
      return kept.value;
    }
    facts.roots.delete(cwd);
    const at = Date.now();
    const roots = yield* tryRepoRoots(cwd);
    const identity = roots === undefined ? undefined : rootsIdentity(cwd, roots);
    if (roots !== undefined && identity !== undefined) {
      facts.roots.set(cwd, { value: roots, at, identity });
    }
    return roots;
  });

const readOriginUrl = (cwd: string) =>
  git(cwd, ["config", "--get", "remote.origin.url"]).pipe(
    Effect.map((out) => ({
      // 1 is "no such key": as much an answer as a URL.
      known: out.status === 0 || out.status === 1,
      url: out.status === 0 ? out.stdout.trim() || undefined : undefined,
    })),
  );

/**
 * `remote.origin.url` of `cwd`'s repo, `undefined` without one; kept per checkout while the repo's
 * config files are unchanged. Fails as the `git config` run does.
 */
export const cachedOriginUrl = (cwd: string): Effect.Effect<string | undefined, ProcError, Proc> =>
  Effect.gen(function* () {
    if (!present(cwd)) return (yield* readOriginUrl(cwd)).url;
    const facts = factsOf(yield* Proc);
    const roots = yield* cachedRepoRoots(cwd).pipe(Effect.orElseSucceed(() => undefined));
    // Stamped before the read, so a change landing during it is seen by the next one.
    const stamp = roots === undefined ? undefined : configStamp(roots);
    const kept = facts.origins.get(cwd);
    if (
      kept !== undefined &&
      stamp !== undefined &&
      kept.stamp === stamp &&
      Date.now() - kept.at < REPO_FACTS_TTL_MS
    ) {
      return kept.value;
    }
    facts.origins.delete(cwd);
    const at = Date.now();
    const read = yield* readOriginUrl(cwd);
    if (read.known && stamp !== undefined) {
      facts.origins.set(cwd, { value: read.url, stamp, at });
    }
    return read.url;
  });
