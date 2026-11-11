import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CREDENTIAL_FOLDERS_IN_HOME,
  DEVICE_LIST_MAX_ENTRIES,
  DEVICE_READ_MAX_BYTES,
  type DeviceFileEntry,
  type DeviceRefusalReason,
  isCredentialFolder,
  isCredentialPath,
} from "@gram/contracts";

/**
 * The folders of a lent machine: which ones may be lent, and how a path inside one is checked and
 * read. Everything here runs in the desktop app's main process. Anything that doesn't fit is
 * refused rather than guessed at, and a check that can't be made counts as failed.
 *
 * These checks bound what is read through the device's own calls. They don't confine a command,
 * which runs as the person wherever it starts.
 */

/** Where the folders that may never be lent are, on this machine. */
export interface LendBounds {
  readonly home: string;
  /** Gram's own folders: its data, its lending settings and log, a joined host's folder. */
  readonly ownFolders: ReadonlyArray<string>;
  /** Where the agents keep their logins when configured elsewhere (`CLAUDE_CONFIG_DIR`, …). */
  readonly agentHomes: ReadonlyArray<string>;
}

export type Refused = { readonly ok: false; readonly why: DeviceRefusalReason };
const refused = (why: DeviceRefusalReason): Refused => ({ ok: false, why });

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

/** `inner` is `outer` or inside it. Both are real, absolute paths. */
const within = (outer: string, inner: string): boolean => {
  if (inner === outer) return true;
  const from = relative(outer, inner);
  return from !== "" && !from.startsWith(`..${sep}`) && from !== ".." && !isAbsolute(from);
};

/** Names compare without case: macOS folders are case-insensitive, and `.GIT` is `.git` there. */
const segmentsOf = (path: string): Array<string> =>
  path
    .split(sep)
    .filter((segment) => segment !== "")
    .map((segment) => segment.toLowerCase());

export type Lendable =
  | { readonly ok: true; readonly path: string; readonly device: number }
  | { readonly ok: false; readonly why: string };

/**
 * Whether `path` may be lent, and where it really is. Refuses the whole disk, the home folder and
 * anything above it, credential folders, agent login folders and Gram's own folders, in both
 * directions: a folder inside one of those, and a folder that contains one.
 */
export const checkLendable = async (path: string, bounds: LendBounds): Promise<Lendable> => {
  if (!isAbsolute(path)) return { ok: false, why: "Pick a folder by its full path." };
  let real: string;
  let stats: Stats;
  try {
    real = await fs.realpath(path);
    stats = await fs.stat(real);
  } catch {
    return { ok: false, why: "Gram can't open this folder." };
  }
  if (!stats.isDirectory()) return { ok: false, why: "This isn't a folder." };
  let home: string;
  try {
    home = await fs.realpath(bounds.home);
  } catch {
    return { ok: false, why: "Gram can't tell where your home folder is." };
  }
  if (real === resolve("/")) return { ok: false, why: "Gram won't lend the whole disk." };
  if (within(real, home))
    return { ok: false, why: "Gram won't lend your home folder as a whole, or a folder above it." };
  if (isCredentialFolder(real)) return { ok: false, why: "It holds credentials or sign-ins." };
  const forbidden = [
    ...CREDENTIAL_FOLDERS_IN_HOME.map((parts) => join(home, ...parts)),
    ...bounds.agentHomes,
    ...bounds.ownFolders,
  ];
  for (const folder of forbidden) {
    let where: string;
    try {
      where = await fs.realpath(folder);
    } catch (error) {
      // A folder that isn't there forbids nothing. Any other failure means it can't be compared.
      if (errorCode(error) === "ENOENT") continue;
      return { ok: false, why: "Gram couldn't check this folder against the ones it never lends." };
    }
    if (within(where, real)) return { ok: false, why: "It holds credentials or sign-ins." };
    if (within(real, where))
      return { ok: false, why: "It contains a folder that holds credentials or sign-ins." };
  }
  return { ok: true, path: real, device: stats.dev };
};

/** A lent folder as the device keeps it: where it really is, and the disk it is on. */
export interface LentFolder {
  readonly path: string;
  readonly device: number;
}

type Resolved = { readonly ok: true; readonly path: string; readonly stats: Stats } | Refused;

/**
 * The real path of `relativePath` inside a lent folder. It must be relative and without `..`,
 * resolve inside the folder on the same disk, and name neither `.git` nor a credential.
 */
const resolveInside = async (folder: LentFolder, relativePath: string): Promise<Resolved> => {
  if (relativePath.includes("\0") || isAbsolute(relativePath)) return refused("outside-folders");
  const parts = relativePath.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) return refused("outside-folders");
  let real: string;
  let stats: Stats;
  try {
    // The lent folder itself may have been replaced since it was lent.
    const root = await fs.realpath(folder.path);
    if (root !== folder.path) return refused("outside-folders");
    real = await fs.realpath(join(folder.path, ...parts));
    stats = await fs.stat(real);
  } catch (error) {
    return refused(errorCode(error) === "ENOENT" ? "not-a-file" : "outside-folders");
  }
  if (!within(folder.path, real)) return refused("outside-folders");
  if (stats.dev !== folder.device) return refused("outside-folders");
  const inside = segmentsOf(relative(folder.path, real));
  if (inside.includes(".git")) return refused("credential-path");
  if (isCredentialPath(real) || isCredentialFolder(real)) return refused("credential-path");
  return { ok: true, path: real, stats };
};

export type WorkingFolder = { readonly ok: true; readonly path: string } | Refused;

/** Where a command starts: the lent folder, or a folder inside it, by real path now. */
export const resolveWorkingFolder = async (
  folder: LentFolder,
  relativePath: string | undefined,
): Promise<WorkingFolder> => {
  const resolved = await resolveInside(folder, relativePath ?? "");
  if (!resolved.ok) return resolved;
  return resolved.stats.isDirectory()
    ? { ok: true, path: resolved.path }
    : refused("outside-folders");
};

export type FileTarget =
  | { readonly ok: true; readonly path: string; readonly size: number }
  | Refused;

/** The file a read names, for the ask to show before anything is opened. */
export const resolveLentFile = async (
  folder: LentFolder,
  relativePath: string,
): Promise<FileTarget> => {
  const resolved = await resolveInside(folder, relativePath);
  if (!resolved.ok) return resolved;
  if (!resolved.stats.isFile() || resolved.stats.nlink !== 1) return refused("not-a-file");
  return { ok: true, path: resolved.path, size: resolved.stats.size };
};

export type FileRead =
  | { readonly ok: true; readonly path: string; readonly data: Buffer; readonly truncated: boolean }
  | Refused;

/**
 * Reads a file inside a lent folder:
 *
 * 1. resolve its real path and require it inside the folder, on the same disk, with no `.git`
 *    segment and no credential name (`resolveInside`);
 * 2. open that path without following a final link and without blocking, and require the handle
 *    to be a regular file with one hard link, so a FIFO never blocks and a device never answers;
 * 3. `stat` the path again and require the handle's device and inode, so the file opened is the
 *    file checked;
 * 4. read at most `maxBytes` from the handle, counting bytes rather than trusting the size.
 *
 * A rename between steps by another process running as the person can still win; that process
 * can already read the file. `expectedPath`, when given, is the real path an ask showed: a file
 * that now resolves elsewhere is refused.
 */
export const readLentFile = async (
  folder: LentFolder,
  relativePath: string,
  maxBytes: number,
  expectedPath?: string,
): Promise<FileRead> => {
  const resolved = await resolveInside(folder, relativePath);
  if (!resolved.ok) return resolved;
  if (expectedPath !== undefined && resolved.path !== expectedPath)
    return refused("outside-folders");
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(
      resolved.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    return refused(errorCode(error) === "ELOOP" ? "outside-folders" : "not-a-file");
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) return refused("not-a-file");
    if (opened.dev !== folder.device) return refused("outside-folders");
    const again = await fs.stat(resolved.path).catch(() => undefined);
    if (again === undefined || again.dev !== opened.dev || again.ino !== opened.ino)
      return refused("outside-folders");
    const most = Math.max(1, Math.min(Math.floor(maxBytes), DEVICE_READ_MAX_BYTES));
    // One byte more than asked, to know whether there was more.
    const buffer = Buffer.alloc(most + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return {
      ok: true,
      path: resolved.path,
      data: buffer.subarray(0, Math.min(length, most)),
      truncated: length > most,
    };
  } catch {
    return refused("not-a-file");
  } finally {
    await handle.close().catch(() => undefined);
  }
};

export type FolderTarget = { readonly ok: true; readonly path: string } | Refused;

/** The folder a listing names, for the ask to show. */
export const resolveLentFolder = async (
  folder: LentFolder,
  relativePath: string,
): Promise<FolderTarget> => {
  const resolved = await resolveInside(folder, relativePath);
  if (!resolved.ok) return resolved;
  return resolved.stats.isDirectory() ? { ok: true, path: resolved.path } : refused("not-a-file");
};

export type FolderListed =
  | {
      readonly ok: true;
      readonly path: string;
      readonly entries: ReadonlyArray<DeviceFileEntry>;
      readonly truncated: boolean;
    }
  | Refused;

/**
 * The entries of a folder inside a lent folder: names, kinds and sizes, never contents. Entries
 * that name a credential, and `.git`, are left out. Links are reported as "other" and not followed.
 */
export const listLentFolder = async (
  folder: LentFolder,
  relativePath: string,
  limit: number,
  expectedPath?: string,
): Promise<FolderListed> => {
  const resolved = await resolveLentFolder(folder, relativePath);
  if (!resolved.ok) return resolved;
  if (expectedPath !== undefined && resolved.path !== expectedPath)
    return refused("outside-folders");
  const most = Math.max(1, Math.min(Math.floor(limit), DEVICE_LIST_MAX_ENTRIES));
  const entries: Array<DeviceFileEntry> = [];
  let truncated = false;
  try {
    const dir = await fs.opendir(resolved.path);
    try {
      for await (const entry of dir) {
        const full = join(resolved.path, entry.name);
        if (entry.name.toLowerCase() === ".git" || isCredentialPath(full)) continue;
        if (isCredentialFolder(full)) continue;
        if (entries.length === most) {
          truncated = true;
          break;
        }
        if (entry.isDirectory()) entries.push({ name: entry.name, kind: "folder" });
        else if (entry.isFile()) {
          const stats = await fs.lstat(full).catch(() => undefined);
          entries.push(
            stats === undefined
              ? { name: entry.name, kind: "file" }
              : { name: entry.name, kind: "file", size: stats.size },
          );
        } else entries.push({ name: entry.name, kind: "other" });
      }
    } finally {
      await dir.close().catch(() => undefined);
    }
  } catch {
    return refused("not-a-file");
  }
  return {
    ok: true,
    path: resolved.path,
    entries: entries.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    truncated,
  };
};
