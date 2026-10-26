// The verified update's own bytes. electron-updater's cache is a shared path anything running as
// the user can replace, so the download is copied once into a private directory, held open by
// descriptor, verified there, and served to Squirrel.Mac from that descriptor alone, with its
// SHA-256 checked again on the very bytes served.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  open,
  opendir,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

const CHUNK = 1024 * 1024;
const PREFIX = "gram-native-candidate-";
const STALE_MS = 24 * 60 * 60_000;

/** Best-effort crash cleanup: bound both the directory scan and the number of removals. */
export async function sweepStaleCandidateDirs(temp: string, now = Date.now()): Promise<number> {
  const uid = process.getuid?.();
  if (uid === undefined) return 0;
  let removed = 0;
  let scanned = 0;
  try {
    for await (const entry of await opendir(temp)) {
      if (++scanned > 4096 || removed >= 32) break;
      if (!entry.name.startsWith(PREFIX)) continue;
      const path = join(temp, entry.name);
      try {
        const info = await lstat(path);
        if (
          !info.isDirectory() ||
          info.uid !== uid ||
          (info.mode & 0o7777) !== 0o700 ||
          now - info.mtimeMs < STALE_MS
        )
          continue;
        await rm(path, { recursive: true, force: true });
        removed++;
      } catch {
        // Keep unreadable/locked entries for a later launch.
      }
    }
  } catch {
    // The temp root may already have gone away.
  }
  return removed;
}

export interface CandidateSnapshot {
  /** The private copy's path, for the unpacking checks; never what Squirrel.Mac is served. */
  readonly path: string;
  readonly size: number;
  /** The SHA-256 of the bytes the descriptor held when the snapshot was taken. */
  readonly sha256: string;
  /**
   * Streams the descriptor's bytes to `write`, hashing them as they go, and withholds the last
   * chunk unless the whole stream's SHA-256 is `sha256` and its length `size`: a stream that
   * doesn't match never completes, and rejects instead.
   */
  deliver(write: (chunk: Buffer) => Promise<void>): Promise<void>;
  /** Whether the private path still names the descriptor's file, unchanged in size. */
  intact(): Promise<boolean>;
  close(): Promise<void>;
}

async function digestOf(handle: FileHandle, size: number): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(CHUNK);
  for (let at = 0; at < size;) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, size - at), at);
    if (bytesRead === 0) throw new Error("The update snapshot ended early.");
    hash.update(buffer.subarray(0, bytesRead));
    at += bytesRead;
  }
  return hash.digest("hex");
}

/** Copies `source` into a fresh private directory under `tempDir` and holds the copy open. */
export async function snapshotCandidate(
  source: string,
  tempDir: string,
): Promise<CandidateSnapshot> {
  const dir = await mkdtemp(join(tempDir, PREFIX));
  const path = join(dir, "candidate.zip");
  let handle: FileHandle | undefined;
  try {
    await chmod(dir, 0o700);
    await copyFile(source, path, constants.COPYFILE_EXCL);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    await handle.chmod(0o400);
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1) throw new Error("The update snapshot isn't a file.");
    const { size, ino, dev } = info;
    const sha256 = await digestOf(handle, size);
    const owned = handle;
    let closed = false;
    let closing: Promise<void> | undefined;
    return {
      path,
      size,
      sha256,
      async deliver(write) {
        if (closed) throw new Error("The update snapshot is closed.");
        const hash = createHash("sha256");
        let held: Buffer | undefined;
        for (let at = 0; at < size;) {
          const buffer = Buffer.alloc(Math.min(CHUNK, size - at));
          const { bytesRead } = await owned.read(buffer, 0, buffer.length, at);
          if (bytesRead === 0) throw new Error("The update snapshot ended early.");
          const chunk = buffer.subarray(0, bytesRead);
          hash.update(chunk);
          at += bytesRead;
          if (held) await write(held);
          held = chunk;
        }
        if ((await owned.stat()).size !== size || hash.digest("hex") !== sha256)
          throw new Error("The update's bytes changed after they were verified.");
        if (held) await write(held);
      },
      async intact() {
        if (closed) return false;
        try {
          const now = await stat(path);
          return now.ino === ino && now.dev === dev && now.size === size;
        } catch {
          return false;
        }
      },
      close() {
        closed = true;
        closing ??= (async () => {
          await owned.close().catch(() => {});
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        })();
        return closing;
      },
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
