import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import type { UpdateChannel } from "@gram/contracts";

import { appImageOrigin, nodeExecFs, type ExecFs } from "../appimage-origin.ts";
import { offerable } from "./native-candidate.ts";
import type { CandidateSnapshot } from "./native-snapshot.ts";

export interface AppImageLocation {
  /** The AppImage file the AppImage runtime started from (`$APPIMAGE`). */
  readonly path: string;
  /** This user may replace it: its folder is writable and the file is this user's own. */
  readonly writable: boolean;
}

/**
 * The running AppImage, or undefined when this process isn't running from one. `$APPIMAGE` counts
 * only when this process's own executable (`execPath`) is inside `$APPDIR`'s mount
 * (`appImageOrigin`, the rule autostart uses too): every process an AppImage starts inherits both,
 * so a .deb install opened from another AppImage's terminal would otherwise take that app's file
 * for its own, and an update would overwrite it with Gram. It must also name a plain `.AppImage`
 * file; a symlink is refused, since the rename would replace the link, not the file it opened.
 */
export async function locateAppImage(
  env: Readonly<Record<string, string | undefined>>,
  execPath: string,
  uid: number | undefined = process.getuid?.(),
  fs: ExecFs = nodeExecFs,
): Promise<AppImageLocation | undefined> {
  const origin = appImageOrigin(env, execPath, fs);
  if (!origin.fromMount) return undefined;
  const path = origin.appImage;
  if (!path || !isAbsolute(path) || path.includes("\0") || !path.endsWith(".AppImage"))
    return undefined;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size < 1) return undefined;
    let writable = uid !== undefined && info.uid === uid;
    if (writable) {
      try {
        await access(dirname(path), constants.W_OK | constants.X_OK);
      } catch {
        writable = false;
      }
    }
    return { path, writable };
  } catch {
    return undefined;
  }
}

const APPIMAGE_MAGIC = [0x7f, 0x45, 0x4c, 0x46];
const APPIMAGE_TYPE2 = [0x41, 0x49, 0x02];

async function readHead(file: string): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Refuses `snapshot` unless it is the update the feed offered: `version` strictly newer than the
 * running one on `channel`, the manifest's SHA-512 and GitHub's SHA-256 and size for the asset, and
 * an AppImage (type 2) by its header. electron-updater has checked the SHA-512 on its own download
 * already; this checks it again on Gram's private copy, which is what gets installed.
 */
export async function verifyAppImageCandidate(options: {
  readonly snapshot: Pick<CandidateSnapshot, "path" | "size" | "sha256" | "sha512" | "intact">;
  readonly version: string;
  readonly currentVersion: string;
  readonly channel: UpdateChannel;
  readonly expected: {
    readonly sha512: string | undefined;
    readonly digest: string;
    readonly size: number;
  };
}): Promise<void> {
  const { snapshot, expected } = options;
  if (!offerable(options.version, options.currentVersion, options.channel))
    throw new Error(`${options.version} isn't an update this install takes on its channel.`);
  if (!expected.sha512 || snapshot.sha512 !== expected.sha512)
    throw new Error("The downloaded AppImage doesn't match the release's SHA-512 for it.");
  if (`sha256:${snapshot.sha256}` !== expected.digest)
    throw new Error("The downloaded AppImage doesn't match GitHub's SHA-256 for it.");
  if (snapshot.size !== expected.size)
    throw new Error("The downloaded AppImage isn't the size GitHub gives for it.");
  const head = await readHead(snapshot.path);
  if (
    !APPIMAGE_MAGIC.every((byte, i) => head[i] === byte) ||
    !APPIMAGE_TYPE2.every((byte, i) => head[8 + i] === byte)
  )
    throw new Error("The download isn't an AppImage.");
  if (!(await snapshot.intact()))
    throw new Error("The downloaded update changed while it was being verified.");
}

interface FileIdentity {
  readonly file: boolean;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly mode: number;
}

async function identity(path: string): Promise<FileIdentity> {
  const info = await lstat(path, { bigint: true });
  return {
    file: info.isFile(),
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
    mode: Number(info.mode & 0o777n),
  };
}

const sameFile = (a: FileIdentity, b: FileIdentity) =>
  a.file &&
  b.file &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs &&
  a.mode === b.mode;

/**
 * Writes `snapshot` over the AppImage at `target` in one step: its bytes, streamed from the
 * snapshot's descriptor and digest-checked as they go (the last chunk is withheld unless they
 * match), into a new file beside it, given the old file's permissions through its own descriptor
 * (a 0700 AppImage stays 0700; only the owner's execute bit is ever added) and synced, then renamed
 * over `target`. Until the rename the old AppImage is untouched; after it, the next launch runs the
 * update. The running process keeps the old file it mounted.
 */
export async function installAppImage(
  snapshot: Pick<CandidateSnapshot, "deliver">,
  target: string,
): Promise<void> {
  const before = await identity(target);
  if (!before.file) throw new Error("The AppImage to replace isn't a file any more.");
  const temp = join(
    dirname(target),
    `.${basename(target)}.gram-update-${randomBytes(6).toString("hex")}`,
  );
  let handle: FileHandle | undefined = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const owned = handle;
    await snapshot.deliver(async (chunk) => {
      for (let at = 0; at < chunk.length;) {
        const { bytesWritten } = await owned.write(chunk, at, chunk.length - at);
        at += bytesWritten;
      }
    });
    await owned.chmod(before.mode | 0o100);
    await owned.sync();
    await owned.close();
    handle = undefined;
    if (!sameFile(before, await identity(target)))
      throw new Error("The AppImage was replaced while the update was written.");
    await rename(temp, target);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  try {
    const dir = await open(dirname(target), constants.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch (_theRenameItselfAlreadyHappened) {}
}
