// Gram's one place for resolving, comparing and containing paths (lint: `gram/no-raw-path`).
//
// Resolution is always the native `realpath`, which returns the case the disk stores: the JS
// `fs.realpathSync` walks links but keeps the case as typed, so two spellings of one folder on a
// case-insensitive volume would stay two. Containment is by whole components, so `..build` is a
// name inside the root and only `..` or `../x` leaves it. Both sides of a containment check must be
// in one form: two real paths, two `physicalPath`s or two lexical paths, never one of each.

import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

/** The native real path of `path`; throws the filesystem's error when it doesn't resolve. */
export const realPathSync = (path: string): string => fs.realpathSync.native(path);

/** `realPathSync`, or `undefined` when `path` doesn't resolve. */
export const tryRealPathSync = (path: string): string | undefined => {
  try {
    return fs.realpathSync.native(path);
  } catch {
    return undefined;
  }
};

/** `realpath`, keeping the original spelling when the path doesn't resolve. */
export const canonicalizeOrOwned = (path: string): string => tryRealPathSync(path) ?? path;

/** The native real path of `path`; rejects with the filesystem's error when it doesn't resolve. */
export const realPath = (path: string): Promise<string> => fs.promises.realpath(path);

/** `realPath`, or `undefined` when `path` doesn't resolve. */
export const tryRealPath = (path: string): Promise<string | undefined> =>
  fs.promises.realpath(path).catch(() => undefined);

/** `canonicalizeOrOwned`, asynchronously: the real path, or `path` as given when it doesn't resolve. */
export const realPathOrOwned = (path: string): Promise<string> =>
  fs.promises.realpath(path).catch(() => path);

/**
 * Whether `path` is `root` or below it, by whole components. Both must already be in one form
 * (see the top of this file); this compares them as written.
 */
export const isInside = (root: string, path: string, platformPath = nodePath): boolean =>
  relativeInside(root, path, platformPath) !== undefined;

/** `isInside`, but not `root` itself. */
export const isStrictlyInside = (root: string, path: string, platformPath = nodePath): boolean => {
  const rel = relativeInside(root, path, platformPath);
  return rel !== undefined && rel !== "";
};

/** `path` relative to `root` when `isInside` holds (`""` for the root itself), else `undefined`. */
export const relativeInside = (
  root: string,
  path: string,
  platformPath = nodePath,
): string | undefined => {
  const rel = platformPath.relative(root, path);
  if (rel === "") return rel;
  // `relative` answers with an absolute path when there is no relative one (another drive).
  if (platformPath.isAbsolute(rel)) return undefined;
  return rel === ".." || rel.startsWith(`..${platformPath.sep}`) ? undefined : rel;
};

/**
 * `path` as the filesystem names it: the real path of its deepest part that exists, with the rest
 * as written. The real path carries the case the disk stores, so on a case-insensitive volume every
 * spelling of a folder comes out the same and on a case-sensitive one two folders stay two.
 */
export const physicalPath = (path: string): string => {
  const real = tryRealPathSync(path);
  if (real !== undefined) return real;
  const resolved = nodePath.resolve(path);
  const parent = nodePath.dirname(resolved);
  return parent === resolved
    ? resolved
    : nodePath.join(physicalPath(parent), nodePath.basename(resolved));
};

/** `physicalPath`, asynchronously. */
export const physicalPathAsync = async (path: string): Promise<string> => {
  const real = await tryRealPath(path);
  if (real !== undefined) return real;
  const resolved = nodePath.resolve(path);
  const parent = nodePath.dirname(resolved);
  return parent === resolved
    ? resolved
    : nodePath.join(await physicalPathAsync(parent), nodePath.basename(resolved));
};

/**
 * Whether `path` lies inside `root` by where both really are: `root`'s real path against the
 * physical path of `path`, so `/var/x` is inside `/private/var`, a link to a checkout holds the
 * checkout's files, and a link out of the root is outside. `false` when `root` doesn't resolve.
 * The answer doesn't depend on whether `path` itself exists.
 */
export const isPhysicallyInside = async (root: string, path: string): Promise<boolean> => {
  const realRoot = await tryRealPath(root);
  return realRoot !== undefined && isInside(realRoot, await physicalPathAsync(path));
};

/**
 * Which folder `path` is, for comparing two: its `physicalPath`, and on Windows also with either
 * separator, no trailing one and case folded, as `projectRootKey` folds. Elsewhere case counts,
 * macOS included: the real path already settles a case-insensitive volume, and a fold would join
 * two folders on a case-sensitive one.
 */
export const samePathKey = (path: string, platform: NodeJS.Platform = process.platform): string => {
  const physical = physicalPath(path);
  return platform === "win32"
    ? physical.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
    : physical;
};

/** Whether `a` and `b` are one folder by `samePathKey`, resolving links where the path exists. */
export const samePath = (a: string, b: string, platform: NodeJS.Platform = process.platform) =>
  samePathKey(a, platform) === samePathKey(b, platform);

/**
 * A project root in one spelling: the platform's separators, no trailing one, and on Windows an
 * upper-case drive letter, so `C:/Git/x/` and `c:\Git\x` are both `C:\Git\x`. Lexical only: a
 * realpath would also swap a symlink, a junction or an 8.3 name for its target. Segment case is
 * left alone, since only the filesystem knows it; `projectRootKey` is what folds it. On Windows a
 * path without a drive or a UNC share, such as a test's `/repo`, keeps its `/`.
 */
export const projectRoot = (path: string, platform: NodeJS.Platform = process.platform): string => {
  const windows = platform === "win32" && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(path);
  const platformPath = windows ? nodePath.win32 : nodePath.posix;
  const normalized = platformPath.normalize(path);
  const root = platformPath.parse(normalized).root;
  // A loop, not `/[\\/]+$/`: that regex backtracks polynomially on a run of separators.
  const separators = windows ? "/\\" : "/";
  let end = normalized.length;
  while (end > root.length && separators.includes(normalized[end - 1]!)) end--;
  const trimmed = end > root.length ? normalized.slice(0, end) : root;
  return windows ? trimmed.replace(/^[a-z](?=:)/, (drive) => drive.toUpperCase()) : trimmed;
};

/**
 * Which folder a project root names, for comparing two: `projectRoot`'s spelling, case-folded on
 * Windows, whose paths ignore case. Elsewhere case counts, macOS included, where a volume can be
 * case-sensitive and a fold would join two repositories.
 */
export const projectRootKey = (
  path: string,
  platform: NodeJS.Platform = process.platform,
): string =>
  platform === "win32" ? projectRoot(path, platform).toLowerCase() : projectRoot(path, platform);

/** A path git printed (always `/`-separated, `C:/…` on Windows) in the platform's own spelling. */
export const fromGitPath = (path: string, platformPath: typeof nodePath.win32 = nodePath): string =>
  platformPath.normalize(path);

/** The last path component, tolerating trailing separators. */
export const basename = (path: string): string => {
  const value = path;
  let end = value.length;
  while (end > 0 && (value[end - 1] === "/" || value[end - 1] === "\\")) end--;
  const trimmed = value.slice(0, end);
  return (
    trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || trimmed
  );
};

/** Expands `""`, `~` and `~/sub` to the home directory; everything else passes through. */
export const expandHome = (path: string, home: string = os.homedir()): string => {
  if (path === "" || path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return nodePath.join(home, path.slice(2));
  return path;
};

export const isDir = (path: string): boolean => {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Whether `dir` holds its own `.git` (a directory for a checkout, a gitlink file for a worktree). */
export const hasOwnGitDir = (dir: string): boolean => {
  try {
    fs.lstatSync(nodePath.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
};

/** Modification time in epoch ms; `0` when unreadable, the wire's "unknown". */
export const mtimeMs = (path: string): number => {
  try {
    return fs.statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};
