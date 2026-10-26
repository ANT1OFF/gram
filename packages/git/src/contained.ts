// File access confined to a checkout. A branch decides what its checkout contains, symlinks
// included, so a path joined onto a checkout is untrusted: every ancestor of the target must be a
// real directory, the target must not be a link, and its real path must stay under the checkout's.
// Windows junctions and symlinks both `lstat` as links, a stream or drive colon is refused, and the
// real-path checks catch any other reparse point that redirects a path.
//
// Node has no `openat`/`renameat`, so a swap between check and use can't be ruled out entirely.
// What can is done: the final component is opened no-follow where the platform has it, the open file
// is checked to be the one inspected, and writes land in a fresh exclusive temp file that is renamed
// into place, so a swapped destination is replaced rather than written through. The parent
// directory is held open (POSIX) and re-checked, identity and real path, as the last step before the
// rename and again after it. What remains is the gap between that last check and the rename's own
// path lookup: a same-user process racing it can move the parent directory, our temp file inside,
// out of the checkout and leave a link in its place, so the rename lands outside. That is detected
// afterwards and thrown, not prevented. Holding off an active local racer is the OS sandbox's job;
// what this module guarantees is against a checkout's static contents, links and junctions included.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { isInside, realPathSync } from "./paths.ts";

/** `O_NOFOLLOW` is POSIX-only; on Windows the post-open identity checks stand alone. */
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** Keeps a FIFO swapped in after the `lstat` from blocking the open; no effect on a regular file. */
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

const COPY_CHUNK = 64 * 1024;

const escape = (what: string) => new Error(`refusing ${what}: it leaves the checkout`);

/** A checkout's real path, the trusted anchor the other functions here check against. */
export const realRoot = (root: string): string => realPathSync(root);

/**
 * The segments of a checkout-relative path (`/`, or either separator on Windows); `undefined` for an
 * absolute path, an empty, `.` or `..` segment, or a Windows drive or stream colon.
 */
const relSegments = (rel: string): Array<string> | undefined => {
  if (rel === "" || nodePath.isAbsolute(rel) || nodePath.posix.isAbsolute(rel)) return undefined;
  const windows = process.platform === "win32";
  const parts = rel.split(windows ? /[\\/]/ : "/");
  const bad = (part: string) =>
    part === "" || part === "." || part === ".." || (windows && part.includes(":"));
  return parts.some(bad) ? undefined : parts;
};

/** Carries `ENOENT` so a caller can tell a missing file from a refused one. */
const missing = (path: string) =>
  Object.assign(new Error(`${path} does not exist`), { code: "ENOENT" });

const sameFile = (a: fs.BigIntStats, b: fs.BigIntStats) => a.dev === b.dev && a.ino === b.ino;

const lstatOrUndefined = (path: string): fs.BigIntStats | undefined =>
  fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });

/** Walks `dirs` under `root`, each a real directory and never a link, creating missing ones if asked. */
const walkDirs = (root: string, dirs: ReadonlyArray<string>, create: boolean): string => {
  let dir = root;
  for (const name of dirs) {
    dir = nodePath.join(dir, name);
    let stat = lstatOrUndefined(dir);
    if (stat === undefined && create) {
      try {
        fs.mkdirSync(dir);
      } catch (error) {
        // Someone else made it first; the lstat below judges what they made.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stat = lstatOrUndefined(dir);
    }
    if (stat === undefined) throw missing(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw escape(dir);
  }
  if (!isInside(root, realPathSync(dir))) throw escape(dir);
  return dir;
};

const split = (rel: string) => {
  const segments = relSegments(rel);
  if (segments === undefined) throw new Error(`refusing ${JSON.stringify(rel)}: not a plain path`);
  return { dirs: segments.slice(0, -1), name: segments.at(-1)! };
};

/**
 * Opens regular file `rel` under real `root` for reading, refusing a link anywhere on the way or a
 * file whose real path is elsewhere. The caller closes the descriptor.
 */
export const openInside = (root: string, rel: string): number => {
  const { dirs, name } = split(rel);
  const path = nodePath.join(walkDirs(root, dirs, false), name);
  const before = lstatOrUndefined(path);
  if (before === undefined) throw missing(path);
  if (before.isSymbolicLink() || !before.isFile()) throw escape(path);
  const fd = fs.openSync(path, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameFile(opened, before)) throw escape(path);
    if (!isInside(root, realPathSync(path))) throw escape(path);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
};

/** The UTF-8 text of regular file `rel` under real `root`, on `openInside`'s terms. */
export const readInside = (root: string, rel: string): string => {
  const fd = openInside(root, rel);
  try {
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
};

/** `O_DIRECTORY` is POSIX-only; Windows opens no directory through `fs.open`. */
const DIRECTORY = fs.constants.O_DIRECTORY;

/**
 * Directory `dir`'s identity, held open where the platform can so it can't be freed and its inode
 * reused while it is checked against.
 */
const holdDir = (dir: string): { readonly id: fs.BigIntStats; readonly release: () => void } => {
  if (DIRECTORY === undefined) {
    const id = lstatOrUndefined(dir);
    if (id === undefined || id.isSymbolicLink() || !id.isDirectory()) throw escape(dir);
    return { id, release: () => {} };
  }
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    return { id: fs.fstatSync(fd, { bigint: true }), release: () => fs.closeSync(fd) };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
};

export interface WriteOptions {
  /** Permission bits set on the written file, exactly. */
  readonly mode?: number | undefined;
  /**
   * The file the destination must still be when the write lands: same identity, size and
   * modification time, so an edit computed from what was read never replaces anything else.
   */
  readonly replacing?: fs.BigIntStats | undefined;
}

/**
 * Writes `rel` under real `root` through `fill`, creating missing parent directories. Refuses a link
 * among the ancestors or at the destination, and a destination that isn't a regular file. The
 * content goes to an exclusive temp file beside it, renamed over the destination once complete.
 */
export const writeInside = (
  root: string,
  rel: string,
  fill: (fd: number) => void,
  options: WriteOptions = {},
): void => {
  const { dirs, name } = split(rel);
  const dir = walkDirs(root, dirs, true);
  const path = nodePath.join(dir, name);
  const held = holdDir(dir);
  try {
    const checkDir = () => {
      const now = lstatOrUndefined(dir);
      if (now === undefined || now.isSymbolicLink() || !sameFile(now, held.id)) throw escape(dir);
      if (!isInside(root, realPathSync(dir))) throw escape(dir);
    };
    const checkDestination = () => {
      const existing = lstatOrUndefined(path);
      const { replacing } = options;
      if (replacing !== undefined) {
        const unchanged =
          existing !== undefined &&
          sameFile(existing, replacing) &&
          existing.size === replacing.size &&
          existing.mtimeNs === replacing.mtimeNs;
        if (!unchanged) throw new Error(`refusing ${path}: it changed since it was read`);
      } else if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile())) {
        throw escape(path);
      }
    };
    checkDir();
    checkDestination();
    // Not derived from `name`: a name near the 255-byte component limit would push it over.
    const tmp = nodePath.join(dir, `.sb-${randomBytes(8).toString("hex")}.tmp`);
    const fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    let renamed = false;
    try {
      let written: fs.BigIntStats;
      try {
        written = fs.fstatSync(fd, { bigint: true });
        const created = lstatOrUndefined(tmp);
        if (!written.isFile() || created === undefined || !sameFile(written, created)) {
          throw escape(tmp);
        }
        checkDir();
        fill(fd);
        if (options.mode !== undefined) fs.fchmodSync(fd, options.mode);
      } finally {
        fs.closeSync(fd);
      }
      checkDestination();
      // Last, so nothing but the rename's own path lookup comes between it and the rename.
      checkDir();
      fs.renameSync(tmp, path);
      renamed = true;
      // The rename resolved `dir` again; a parent swapped in that gap shows up here.
      const landed = lstatOrUndefined(path);
      checkDir();
      if (landed === undefined || !sameFile(landed, written)) throw escape(path);
    } finally {
      if (!renamed) fs.rmSync(tmp, { force: true });
    }
  } finally {
    held.release();
  }
};

/**
 * Copies regular file `rel` from real root `fromRoot` to the same relative path under real root
 * `toRoot`, on `openInside`'s terms for the source and `writeInside`'s for the destination. Keeps
 * the source's permission bits.
 */
export const copyInside = (fromRoot: string, toRoot: string, rel: string): void => {
  const src = openInside(fromRoot, rel);
  try {
    const mode = Number(fs.fstatSync(src, { bigint: true }).mode) & 0o777;
    const buffer = Buffer.allocUnsafe(COPY_CHUNK);
    writeInside(
      toRoot,
      rel,
      (dst) => {
        let position = 0;
        for (;;) {
          const read = fs.readSync(src, buffer, 0, COPY_CHUNK, position);
          if (read === 0) return;
          let written = 0;
          while (written < read) written += fs.writeSync(dst, buffer, written, read - written);
          position += read;
        }
      },
      { mode },
    );
  } finally {
    fs.closeSync(src);
  }
};
