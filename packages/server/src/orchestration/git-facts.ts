// What the orchestration service reads from git itself, off the hot path: the paths a worker has
// changed (for the overlap check), the same for a worktree it holds in another repo,
// and a before-and-after of a workspace root around an orchestrator's turn (drift). All go
// through `git()`, so they are bounded at the `local` tier, and all answer "nothing" when git
// fails: none is worth failing a digest over.

import {
  dirtyContentHash,
  git,
  localBaseRef,
  originOwnerRepo,
  porcelainPath,
  type Proc,
} from "@gram/git";
import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
} from "node:fs";
import { join } from "node:path";

const lines = (stdout: string): ReadonlyArray<string> =>
  stdout.split("\n").filter((line) => line.trim() !== "");

const status = (cwd: string) =>
  git(cwd, ["-c", "core.quotepath=false", "status", "--porcelain"]).pipe(
    Effect.map((out) => (out.status === 0 ? out.stdout : undefined)),
  );

/**
 * Porcelain codes that change nothing another worktree can collide with: a file removed from the
 * working tree and not staged (` D`), and one git doesn't track (`??`). A shell alias that deletes
 * the same build output in every worktree made every live pair of workers overlap.
 */
const UNSHARED = new Set([" D", "??"]);

/** The most of a file `changedPaths` reads to tell two worktrees' copies of it apart. */
const SIGNED_MAX = 1024 * 1024;

// Opened without following a last-component symlink and without blocking on a FIFO, then checked
// to be a regular file on the descriptor itself, and read no further than the cap: a committed link
// to `/dev/zero` or a pipe must not hang the server, which reads these synchronously.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * What a changed path holds in the checkout now: a hash of its content, of its target for a
 * symlink, `-` when it is gone, and `undefined` when it is too big or isn't a regular file, which
 * compares equal to nothing.
 */
const signatureOf = (cwd: string, path: string): string | undefined => {
  const full = join(cwd, path);
  let fd: number | undefined;
  try {
    const link = lstatSync(full, { throwIfNoEntry: false });
    if (link === undefined) return "-";
    if (link.isSymbolicLink()) {
      return `link:${createHash("sha1").update(readlinkSync(full)).digest("base64url")}`;
    }
    if (!link.isFile() || link.size > SIGNED_MAX) return undefined;
    fd = openSync(full, OPEN_FLAGS);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > SIGNED_MAX) return undefined;
    // One byte over what it said, to tell a file still growing from one read whole.
    const buffer = Buffer.alloc(stat.size + 1);
    let read = 0;
    for (let got = -1; got !== 0 && read < buffer.length; read += got) {
      got = readSync(fd, buffer, read, buffer.length - read, read);
    }
    if (read > stat.size) return undefined;
    return createHash("sha1").update(buffer.subarray(0, read)).digest("base64url");
  } catch {
    // A file replaced by a link or a directory between the checks, or gone since.
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

/** A checkout's changed paths, and what each holds now where that could be read. */
export interface ChangedPaths {
  readonly files: ReadonlyArray<string>;
  /** By path; two worktrees whose copies hash the same made the same change, which isn't a conflict. */
  readonly signatures: Readonly<Record<string, string>>;
}

export const noChangedPaths: ChangedPaths = { files: [], signatures: {} };

/** Whether two samples say the same: the same paths, each holding the same. */
export const sameChangedPaths = (a: ChangedPaths, b: ChangedPaths): boolean =>
  a.files.length === b.files.length &&
  a.files.every(
    (file, index) => file === b.files[index] && a.signatures[file] === b.signatures[file],
  );

/** The most paths whose index entries `changedPaths` asks for; past it nothing is signed. */
const STAGED_MAX = 1000;

/**
 * Each path's blob in the index, absent for one not in it; `undefined` when git can't say or
 * there are too many paths to ask about.
 */
const indexBlobs = (
  cwd: string,
  files: ReadonlyArray<string>,
): Effect.Effect<ReadonlyMap<string, string> | undefined, never, Proc> =>
  Effect.gen(function* () {
    if (files.length === 0) return new Map<string, string>();
    if (files.length > STAGED_MAX) return undefined;
    const out = yield* git(cwd, ["ls-files", "--stage", "-z", "--", ...files]);
    if (out.status !== 0) return undefined;
    const blobs = new Map<string, string>();
    for (const entry of out.stdout.split("\0")) {
      // `<mode> <blob> <stage>\t<path>`; a conflicted path has several entries, all kept.
      const tab = entry.indexOf("\t");
      if (tab < 0) continue;
      const [, blob, stage] = entry.slice(0, tab).split(" ");
      const path = entry.slice(tab + 1);
      blobs.set(path, `${blobs.get(path) ?? ""}${stage}:${blob}`);
    }
    return blobs;
  }).pipe(Effect.orElseSucceed((): ReadonlyMap<string, string> | undefined => undefined));

/**
 * The paths a checkout has changed, relative to its repo: what is uncommitted, plus what its
 * commits changed since it left `base` when a base is known. Unstaged deletions and untracked
 * files are left out (`UNSHARED`). Sorted, without duplicates; empty outside a repo or when git
 * fails.
 */
export const changedPaths = (
  cwd: string,
  base: string | undefined,
): Effect.Effect<ChangedPaths, never, Proc> =>
  Effect.gen(function* () {
    const paths = new Set<string>();
    for (const line of lines((yield* status(cwd)) ?? "")) {
      if (UNSHARED.has(line.slice(0, 2))) continue;
      const path = porcelainPath(line);
      if (path !== undefined) paths.add(path);
    }
    if (base !== undefined) {
      const committed = yield* git(cwd, [
        "-c",
        "core.quotepath=false",
        "diff",
        "--name-only",
        `${base}...HEAD`,
      ]);
      if (committed.status === 0) for (const path of lines(committed.stdout)) paths.add(path);
    }
    const files = [...paths].toSorted();
    const signatures: Record<string, string> = {};
    // What is staged commits whatever the working tree holds, so two copies match only when their
    // index entries do too: different staged edits whose files were then deleted are no match.
    const staged = yield* indexBlobs(cwd, files);
    if (staged === undefined) return { files, signatures };
    yield* Effect.sync(() => {
      for (const path of files) {
        const signature = signatureOf(cwd, path);
        if (signature !== undefined) signatures[path] = `${staged.get(path) ?? "-"} ${signature}`;
      }
    });
    return { files, signatures };
  }).pipe(Effect.orElseSucceed(() => noChangedPaths));

/**
 * A worktree a worker holds beside its own, as the ledger and the overlap check read it: its
 * `changedPaths` against the repo's own default branch, which needn't be the first repo's.
 */
export interface ExtraCheckoutFacts extends ChangedPaths {
  /** `owner/repo` of its `origin`, which is how one of the worker's PRs is matched to it. */
  readonly repo: string | undefined;
  /** The branch observed while sampling the held worktree; absent on a detached head. */
  readonly branch?: string | undefined;
}

/**
 * What git has checked out at `path` now: a branch, a detached HEAD, or `unknown` when git couldn't
 * be asked or `path` isn't a repo. `symbolic-ref --quiet` exits 1 only for a detached HEAD.
 */
export type CheckedOut =
  | { readonly kind: "branch"; readonly branch: string }
  | { readonly kind: "detached" }
  | { readonly kind: "unknown" };

export const checkedOut = (path: string): Effect.Effect<CheckedOut, never, Proc> =>
  git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]).pipe(
    Effect.map((head): CheckedOut => {
      const branch = head.stdout.trim();
      if (head.status === 0 && branch !== "") return { kind: "branch", branch };
      return head.status === 1 ? { kind: "detached" } : { kind: "unknown" };
    }),
    Effect.orElseSucceed((): CheckedOut => ({ kind: "unknown" })),
  );

/** The branch checked out at `path` now, read from git; `undefined` on a detached HEAD or no repo. */
const checkedOutBranch = (path: string): Effect.Effect<string | undefined, never, Proc> =>
  git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]).pipe(
    Effect.map((head) => (head.status === 0 ? head.stdout.trim() || undefined : undefined)),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * Nothing publishes a git state for such a worktree (the thread's state follows its own checkout
 * alone), so the service samples it itself. No fetch: the base is whatever `origin` last said.
 */
export const extraCheckoutFacts = (path: string): Effect.Effect<ExtraCheckoutFacts, never, Proc> =>
  Effect.gen(function* () {
    const base = yield* localBaseRef(path);
    const branch = yield* checkedOutBranch(path);
    return {
      ...(yield* changedPaths(path, base)),
      repo: yield* originOwnerRepo(path),
      ...(branch === undefined ? {} : { branch }),
    };
  });

/** A workspace root as drift detection sees it at one moment. */
export interface RootMark {
  readonly head: string;
  /** The porcelain lines, one per dirty entry. */
  readonly entries: ReadonlyArray<string>;
  /** Moves when an already-dirty file is edited again, which the porcelain text doesn't show. */
  readonly contentHash: string;
}

/** `HEAD` and the working tree of `root`; `undefined` outside a repo or when git fails. */
export const markRoot = (root: string): Effect.Effect<RootMark | undefined, never, Proc> =>
  Effect.gen(function* () {
    const head = yield* git(root, ["rev-parse", "HEAD"]);
    const text = yield* status(root);
    if (head.status !== 0 || text === undefined) return undefined;
    return {
      head: head.stdout.trim(),
      entries: lines(text),
      contentHash: dirtyContentHash(root, text),
    };
  }).pipe(Effect.orElseSucceed(() => undefined));

/** What moved in a root across a turn; `undefined` when nothing did. */
export const driftBetween = (
  before: RootMark,
  after: RootMark,
): { readonly files: number; readonly headMoved: boolean } | undefined => {
  const known = new Set(before.entries);
  const gone = new Set(after.entries);
  const appeared = after.entries.filter((entry) => !known.has(entry)).length;
  const cleared = before.entries.filter((entry) => !gone.has(entry)).length;
  const headMoved = before.head !== after.head;
  const touched = Math.max(appeared, cleared);
  if (touched === 0 && !headMoved && before.contentHash === after.contentHash) return undefined;
  // Same entries under a new content hash: a dirty file was edited again. At least that one.
  return { files: touched === 0 && !headMoved ? 1 : touched, headMoved };
};
