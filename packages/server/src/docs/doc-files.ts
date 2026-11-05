// The file layer under a workspace's docs (`docs.ts`): every read and write of `<root>/<ws>/<name>`
// with the two folders above the file pinned for the whole operation.
//
// Node has no `openat`, so a path is resolved again by each call. What stops a folder swapped in
// mid-operation (a link put in place of the docs root or the workspace folder, then perhaps put
// back) is identity: each operation `lstat`s both folders first, refuses a link, a non-folder or
// one another user owns, and keeps their device and inode. After it opens a file it checks that
// the file at the confined path now is the one it opened, and that both folders are still the
// pinned ones. A read whose check fails returns nothing it read. A write checks its fresh temp file
// the same way before writing any content into it, renames it over the target (replacing a link
// there, never writing through one), and checks the result again.

import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

/** A refusal whose message is safe to show: it names no absolute path. */
export class DocRefusal extends Error {}

/** What a bounded read found, so no file's own text can pass for a verdict. */
export type ReadResult =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "NotPlain" }
  | { readonly _tag: "TooBig" }
  | { readonly _tag: "Read"; readonly text: string };

/**
 * Test seams for a racing writer and a full disk: each runs where an attacker or a fault could
 * act, between a check and the I/O it guards. Never set outside tests.
 */
export interface DocFileHooks {
  /** After the folders are pinned, before a file is opened (read) or created (write). */
  readonly beforeOpen?: (path: string) => Promise<void>;
  /** After a file is opened or created, before it is checked. */
  readonly afterOpen?: (path: string) => Promise<void>;
  /** In place of `rename`, to fail a commit. */
  readonly rename?: (from: string, to: string) => Promise<void>;
}

interface Pin {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

/** Both folders over a workspace's docs, pinned. */
export interface DocFolder {
  readonly dir: string;
  readonly pins: readonly [Pin, Pin];
}

const MOVED = "The docs folder changed during the operation, so nothing was read or written";
const NOT_PLAIN_FOLDER =
  "The docs folder is a link, not a folder, or not yours, so nothing was read or written";

/** A read's check failed: the folder or the file at the path changed under it. */
class Moved extends DocRefusal {
  constructor() {
    super(MOVED);
  }
}
const READ_ATTEMPTS = 8;

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | undefined)?.code;
const uid = typeof process.getuid === "function" ? process.getuid() : undefined;

const statOrMissing = async (path: string): Promise<Stats | undefined> => {
  try {
    return await lstat(path);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return undefined;
    throw error;
  }
};

/** A real folder of this user's at `path`, pinned; `undefined` when there is none. */
const pin = async (path: string): Promise<Pin | undefined> => {
  const stats = await statOrMissing(path);
  if (stats === undefined) return undefined;
  if (stats.isSymbolicLink() || !stats.isDirectory() || (uid !== undefined && stats.uid !== uid)) {
    throw new DocRefusal(NOT_PLAIN_FOLDER);
  }
  return { path, dev: stats.dev, ino: stats.ino };
};

const stillPinned = async (pins: readonly Pin[]) => {
  for (const each of pins) {
    const now = await statOrMissing(each.path);
    if (
      now === undefined ||
      now.isSymbolicLink() ||
      !now.isDirectory() ||
      now.dev !== each.dev ||
      now.ino !== each.ino
    ) {
      throw new Moved();
    }
  }
};

/** The file at `path` is still the one `opened` is. */
const sameFile = async (path: string, opened: Stats) => {
  const now = await statOrMissing(path);
  if (now === undefined || now.dev !== opened.dev || now.ino !== opened.ino) {
    throw new Moved();
  }
};

/**
 * The workspace's folder under `root`, both pinned. `create` makes the root (0700) and the folder
 * (0700) when missing; without it a missing one is `undefined`. The root itself must be a folder,
 * never a link; the data dir above it may be reached through one (`/tmp` on macOS).
 */
export const openFolder = async (
  root: string,
  workspace: string,
  create: boolean,
): Promise<DocFolder | undefined> => {
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  const rootPin = await pin(root);
  if (rootPin === undefined) return undefined;
  const dir = join(root, workspace);
  if (create) {
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
    }
  }
  const dirPin = await pin(dir);
  if (dirPin === undefined) return undefined;
  await stillPinned([rootPin]);
  return { dir, pins: [rootPin, dirPin] };
};

/**
 * `name`'s first `max` bytes, or with `whole` the whole file refused past `max`: read without
 * following a link, from a singly linked regular file, and checked to be the file at the confined
 * path in the pinned folders once read.
 */
export const readPinned = async (
  folder: DocFolder,
  name: string,
  max: number,
  options: { readonly whole: boolean; readonly hooks?: DocFileHooks | undefined },
): Promise<ReadResult> => {
  // A save renamed over the file between its open and its check fails the check as a swap would:
  // the read is tried again, and only a read whose checks pass is answered.
  for (let attempt = 1; ; attempt++) {
    try {
      return await readOnce(folder, name, max, options);
    } catch (error) {
      if (!(error instanceof Moved) || attempt >= READ_ATTEMPTS) throw error;
    }
  }
};

const readOnce = async (
  folder: DocFolder,
  name: string,
  max: number,
  options: { readonly whole: boolean; readonly hooks?: DocFileHooks | undefined },
): Promise<ReadResult> => {
  const path = join(folder.dir, name);
  await options.hooks?.beforeOpen?.(path);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (codeOf(error) === "ENOENT") {
      await stillPinned(folder.pins);
      return { _tag: "Missing" };
    }
    // `O_NOFOLLOW` on a link fails with ELOOP (EMLINK on some BSDs).
    if (codeOf(error) === "ELOOP" || codeOf(error) === "EMLINK") return { _tag: "NotPlain" };
    throw error;
  }
  try {
    await options.hooks?.afterOpen?.(path);
    const opened = await handle.stat();
    // No link left: a save renamed over it since the open, which the read is tried again for.
    if (opened.nlink === 0) throw new Moved();
    if (!opened.isFile() || opened.nlink !== 1) return { _tag: "NotPlain" };
    if (options.whole && opened.size > max) return { _tag: "TooBig" };
    const bytes = Buffer.alloc(max + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (after.nlink === 0) throw new Moved();
    if (after.nlink !== 1) return { _tag: "NotPlain" };
    if (options.whole && length > max) return { _tag: "TooBig" };
    await sameFile(path, opened);
    await stillPinned(folder.pins);
    return { _tag: "Read", text: bytes.subarray(0, Math.min(length, max)).toString("utf8") };
  } finally {
    await handle.close();
  }
};

/**
 * Writes `content` to `name` atomically: a fresh temp file (0600, `O_EXCL`, no link followed) that
 * is checked to be in the pinned folders before any content goes in, then renamed over the target,
 * then checked again. A failure at any step leaves the old file whole.
 */
export const writePinned = async (
  folder: DocFolder,
  name: string,
  content: string,
  hooks?: DocFileHooks,
): Promise<void> => {
  const target = join(folder.dir, name);
  const existing = await statOrMissing(target);
  if (existing?.isDirectory()) throw new DocRefusal(`${name} is a folder`);
  const temp = join(folder.dir, `.tmp-${randomUUID()}`);
  await hooks?.beforeOpen?.(temp);
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let closed = false;
  let renamed = false;
  try {
    await hooks?.afterOpen?.(temp);
    const created = await handle.stat();
    await sameFile(temp, created);
    await stillPinned(folder.pins);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    await (hooks?.rename ?? rename)(temp, target);
    renamed = true;
    await sameFile(target, created);
    await stillPinned(folder.pins);
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    if (!renamed) await unlink(temp).catch(() => undefined);
    throw error;
  }
};

/** The names of the regular files in the pinned workspace folder. */
export const listPinned = async (folder: DocFolder): Promise<string[]> => {
  const entries = await readdir(folder.dir, { withFileTypes: true });
  await stillPinned(folder.pins);
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
};
