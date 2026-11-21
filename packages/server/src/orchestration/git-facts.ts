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

const UNSHARED = new Set([" D", "??"]);

const SIGNED_MAX = 1024 * 1024;

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

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
    const buffer = Buffer.alloc(stat.size + 1);
    let read = 0;
    for (let got = -1; got !== 0 && read < buffer.length; read += got) {
      got = readSync(fd, buffer, read, buffer.length - read, read);
    }
    if (read > stat.size) return undefined;
    return createHash("sha1").update(buffer.subarray(0, read)).digest("base64url");
  } catch {
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

const STAGED_MAX = 1000;

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
  return { files: touched === 0 && !headMoved ? 1 : touched, headMoved };
};
