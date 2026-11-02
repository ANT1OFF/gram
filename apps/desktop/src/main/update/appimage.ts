// The Linux AppImage's own update steps, around electron-updater's check and download: where the
// running AppImage is and whether this user may replace it, what a downloaded candidate must be
// before it can be offered, and the replacement itself. There is no Squirrel.Mac, ShipIt or
// publisher signature on Linux: the candidate is the exact file the release's `latest-linux.yml`
// names, by its SHA-512, and GitHub's SHA-256 for the asset, written over the running AppImage
// with one rename only after Gram's stop fence.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, open, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import type { UpdateChannel } from "@gram/contracts";

import { offerable } from "./native-candidate.ts";
import type { CandidateSnapshot } from "./native-snapshot.ts";

export interface AppImageLocation {
  /** The AppImage file the AppImage runtime started from (`$APPIMAGE`). */
  readonly path: string;
  /** This user may replace it: its folder is writable and the file is this user's own. */
  readonly writable: boolean;
}

/**
 * The running AppImage, from the runtime's `$APPIMAGE`, or undefined when this isn't one (the .deb,
 * an unpacked build) or the variable doesn't name a plain file. A symlink is refused: the rename
 * would replace the link, not the file it opened.
 */
export async function locateAppImage(
  env: NodeJS.ProcessEnv,
  uid: number | undefined = process.getuid?.(),
): Promise<AppImageLocation | undefined> {
  const path = env["APPIMAGE"];
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

/** ELF, and the AppImage type 2 magic (`AI\x02`) at offset 8: what electron-builder writes. */
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
}

/**
 * What tells one file at `path` from another put there since. The inode alone doesn't: ext4 hands
 * a deleted file's inode number straight to the next one created, so a file removed and rewritten
 * keeps it. Its size and its modification and change times, to the nanosecond, change all the same.
 */
async function identity(path: string): Promise<FileIdentity> {
  const info = await lstat(path, { bigint: true });
  return {
    file: info.isFile(),
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  };
}

const sameFile = (a: FileIdentity, b: FileIdentity) =>
  a.file &&
  b.file &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs;

/**
 * Writes `snapshot` over the AppImage at `target` in one step: its bytes, streamed from the
 * snapshot's descriptor and digest-checked as they go (the last chunk is withheld unless they
 * match), into a new file beside it, synced and made executable, then renamed over `target`. Until
 * the rename the old AppImage is untouched; after it, the next launch runs the update. The running
 * process keeps the old file it mounted.
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
    await owned.sync();
    await owned.close();
    handle = undefined;
    await chmod(temp, 0o755);
    if (!sameFile(before, await identity(target)))
      throw new Error("The AppImage was replaced while the update was written.");
    await rename(temp, target);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  // The rename is durable once the folder is: best effort, since some filesystems refuse it.
  try {
    const dir = await open(dirname(target), constants.O_RDONLY);
    await dir.sync().finally(() => dir.close());
  } catch {
    // The rename itself already happened.
  }
}
