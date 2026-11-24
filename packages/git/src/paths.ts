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
  if (platformPath.isAbsolute(rel)) return undefined;
  return rel === ".." || rel.startsWith(`..${platformPath.sep}`) ? undefined : rel;
};

const foreignRoots = new Set<string>();

/** Paths `noteForeignPath` was given that cross a kept folder: kept folders only grow, so they stay so. */
const crossingRoots = new Set<string>();

const keptRoots = new Set<string>();

const folded = (path: string): string =>
  process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path;

const FIRST_RETRY_MS = 250;
const LAST_RETRY_MS = 30_000;

/**
 * Paths that aren't on this disk yet, asked of it again until they are: the first time at the
 * next `settle`, then after a wait that doubles up to half a minute, so a folder that never comes
 * (a deleted worktree) costs a realpath per half minute, not one per path compared.
 */
export class PendingPaths {
  private readonly due = new Map<string, { at: number; wait: number }>();
  private next = Number.POSITIVE_INFINITY;

  get size(): number {
    return this.due.size;
  }

  has(path: string): boolean {
    return this.due.has(path);
  }

  add(path: string): void {
    if (this.due.has(path)) return;
    const now = Date.now();
    this.due.set(path, { at: now, wait: FIRST_RETRY_MS });
    if (now < this.next) this.next = now;
  }

  /** The pending paths that are there now, which stop being pending; the rest wait on. */
  settle(): ReadonlyArray<string> {
    const now = Date.now();
    if (now < this.next) return [];
    const there: Array<string> = [];
    let next = Number.POSITIVE_INFINITY;
    for (const [path, entry] of this.due) {
      if (entry.at > now) {
        if (entry.at < next) next = entry.at;
        continue;
      }
      if (tryRealPathSync(path) !== undefined) {
        this.due.delete(path);
        there.push(path);
        continue;
      }
      entry.at = now + entry.wait;
      entry.wait = Math.min(entry.wait * 2, LAST_RETRY_MS);
      if (entry.at < next) next = entry.at;
    }
    this.next = next;
    return there;
  }

  clear(): void {
    this.due.clear();
    this.next = Number.POSITIVE_INFINITY;
  }
}

const keptPending = new PendingPaths();

/**
 * Every spelling of `path` on this disk: as resolved, as the disk names it (`diskPath`, the real
 * path of its deepest part that exists), and that real path as each linked folder above `path`
 * spells it. On macOS `/var` is a link to `/private/var`, so a folder kept through a link in
 * `/var/folders/x` is matched as `/private/var/folders/x/...` and as `/var/folders/x/...` alike.
 * Only `path`'s own folders are asked of the disk, each once: a path compared with these never is.
 */
export const pathForms = (path: string): ReadonlyArray<string> => {
  const resolved = nodePath.resolve(path);
  const asked = new Map<string, string>();
  const onDisk = (at: string): string => {
    const known = asked.get(at);
    if (known !== undefined) return known;
    const real = tryRealPathSync(at);
    const parent = nodePath.dirname(at);
    const named =
      real ?? (parent === at ? at : nodePath.join(onDisk(parent), nodePath.basename(at)));
    asked.set(at, named);
    return named;
  };
  const real = onDisk(resolved);
  const forms = new Set([resolved, real]);
  for (
    let at = nodePath.dirname(resolved);
    nodePath.dirname(at) !== at;
    at = nodePath.dirname(at)
  ) {
    const atReal = onDisk(at);
    if (atReal === at) continue;
    const rest = relativeInside(atReal, real);
    if (rest !== undefined) forms.add(rest === "" ? at : nodePath.join(at, rest));
  }
  return [...forms];
};

/** Keeps every spelling of `resolved`, and drops the marks that cross one newly kept. */
const keepForms = (resolved: string): void => {
  const added: Array<string> = [];
  for (const form of pathForms(resolved)) {
    const at = folded(form);
    if (keptRoots.has(at)) continue;
    keptRoots.add(at);
    added.push(at);
  }
  if (added.length > 0) dropCrossingMarks(added);
};

const settleKept = (): void => {
  for (const resolved of keptPending.settle()) keepForms(resolved);
};

const crossesKept = (path: string): boolean => {
  const at = folded(path);
  for (const kept of keptRoots) if (isInside(at, kept) || isInside(kept, at)) return true;
  return false;
};

/**
 * Marks `path` and everything below it as another machine's: `physicalPath`, `samePathKey` and
 * `samePath` compare it as written and never touch the filesystem for it. A folder that was another
 * machine's stays so for a key already handed out, unless it turns out to cross one of this
 * machine's (`keepPathsHere`): that one is never another's. Relative paths are ignored: a host's
 * paths are always absolute. A path noted before is settled at once, without asking the disk.
 */
export const noteForeignPath = (path: string): void => {
  if (!nodePath.isAbsolute(path)) return;
  settleKept();
  const at = nodePath.resolve(path);
  // Every mark is checked against each kept folder as that folder is kept (`dropCrossingMarks`),
  // so a path already marked or already refused needs no second look.
  if (foreignRoots.has(at) || crossingRoots.has(at)) return;
  if (crossesKept(at)) crossingRoots.add(at);
  else foreignRoots.add(at);
};

/**
 * Keeps `paths` this machine's, whatever another machine says: no `noteForeignPath` takes one of
 * them, a folder above one or a folder below one, and a mark that did already goes. Each is kept by
 * every spelling of it on this disk (`pathForms`): as resolved (a relative one against the working
 * directory), by its real path, and through the links above it. One that isn't there yet is kept
 * by its real path too once it is (`PendingPaths`).
 */
export const keepPathsHere = (paths: Iterable<string>): void => {
  for (const path of paths) {
    const resolved = nodePath.resolve(path);
    if (keptRoots.has(folded(resolved)) || keptPending.has(resolved)) continue;
    if (tryRealPathSync(resolved) === undefined) keptPending.add(resolved);
    keepForms(resolved);
  }
};

const dropCrossingMarks = (kept: ReadonlyArray<string>): void => {
  for (const root of foreignRoots) {
    const at = folded(root);
    if (kept.some((form) => isInside(at, form) || isInside(form, at))) {
      foreignRoots.delete(root);
      crossingRoots.add(root);
    }
  }
};

/** Whether `path` is at or below a folder `noteForeignPath` marked, by its lexical form. */
export const isForeignPath = (path: string): boolean => {
  if (foreignRoots.size === 0 || !nodePath.isAbsolute(path)) return false;
  for (let at = nodePath.resolve(path); ;) {
    if (foreignRoots.has(at)) return true;
    const parent = nodePath.dirname(at);
    if (parent === at) return false;
    at = parent;
  }
};

/** Forgets every `noteForeignPath` and `keepPathsHere`, for tests. */
export const forgetForeignPathsForTest = (): void => {
  foreignRoots.clear();
  crossingRoots.clear();
  keptRoots.clear();
  keptPending.clear();
};

/**
 * `path` as the filesystem names it: the real path of its deepest part that exists, with the rest
 * as written. The real path carries the case the disk stores, so on a case-insensitive volume every
 * spelling of a folder comes out the same and on a case-sensitive one two folders stay two. A path
 * on another machine (`noteForeignPath`) is only resolved lexically.
 */
export const physicalPath = (path: string): string =>
  isForeignPath(path) ? nodePath.resolve(path) : diskPath(path);

/**
 * `path` as this machine's own disk names it, whatever another machine holds there
 * (`noteForeignPath`): for what reads this disk at a path, where a link is followed whoever's
 * folder the path also names.
 */
export const diskPath = (path: string): string => {
  const real = tryRealPathSync(path);
  if (real !== undefined) return real;
  const resolved = nodePath.resolve(path);
  const parent = nodePath.dirname(resolved);
  return parent === resolved
    ? resolved
    : nodePath.join(diskPath(parent), nodePath.basename(resolved));
};

/** `physicalPath`, asynchronously. */
export const physicalPathAsync = async (path: string): Promise<string> => {
  if (isForeignPath(path)) return nodePath.resolve(path);
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
  a === b || samePathKey(a, platform) === samePathKey(b, platform);

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
