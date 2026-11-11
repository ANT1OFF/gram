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

/** A disk that doesn't answer in this long counts as a check that couldn't be made. */
export const FOLDER_DEADLINE_MS = 10_000;

/** `work`'s answer, or `late` when it fails or the disk doesn't answer in time. */
const withDeadline = <A>(work: Promise<A>, late: A): Promise<A> =>
  new Promise((done) => {
    const timer = setTimeout(() => done(late), FOLDER_DEADLINE_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        done(value);
      },
      () => {
        clearTimeout(timer);
        done(late);
      },
    );
  });

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

/** Credential names the shared list doesn't have, which a device refuses as well. */
const DEVICE_CREDENTIAL_NAME =
  /(?:\.env$|^id_(?:rsa|dsa|ecdsa|ed25519|xmss)|^kubeconfig$|^terraform\.tfstate|^service[-_]?account.*\.json$|\.p8$|\.asc$)/;

/** A Git folder by its name: `.git`, or a bare repository's `name.git`. */
const gitName = (lower: string): boolean => lower === ".git" || lower.endsWith(".git");

/**
 * Whether names inside a lent folder say Git or credential, judged on the names alone and on
 * every one of them, so the answer says nothing about what is on the disk.
 */
const namesCredential = (parts: ReadonlyArray<string>): boolean => {
  if (parts.length === 0) return false;
  const lower = parts.map((part) => part.toLowerCase());
  if (lower.some((part) => gitName(part) || DEVICE_CREDENTIAL_NAME.test(part))) return true;
  if (isCredentialFolder(parts.join("/"))) return true;
  return parts.some((_, index) => isCredentialPath(parts.slice(0, index + 1).join("/")));
};

/** A folder that is a Git folder whatever its name: a bare repository or a separate Git folder. */
const holdsGit = async (folder: string): Promise<boolean> => {
  const there = await Promise.all(
    ["HEAD", "objects", "refs"].map((name) =>
      fs.lstat(join(folder, name)).then(
        () => true,
        () => false,
      ),
    ),
  );
  return there.every(Boolean);
};

/**
 * Folders of the system and its pseudo-filesystems: lending one, or a folder that holds one,
 * would hand over the machine rather than a project. `/run` is only refused where sign-ins live,
 * since removable disks are mounted under it.
 */
const SYSTEM_FOLDERS = [
  "/proc",
  "/sys",
  "/dev",
  "/etc",
  "/boot",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/run/user",
  "/run/secrets",
  "/run/credentials",
  "/var/lib",
  "/var/log",
  "/var/run",
  "/var/db",
  "/System",
  "/Library",
  "/private/etc",
  "/private/var/db",
  "/private/var/root",
];

/** Real paths of `folders` that exist, or undefined when one can't be compared. */
const realFolders = async (
  folders: ReadonlyArray<string>,
): Promise<ReadonlyArray<string> | undefined> => {
  const real: Array<string> = [];
  for (const folder of folders) {
    try {
      real.push(await fs.realpath(folder));
    } catch (error) {
      // A folder that isn't there forbids nothing. Any other failure means it can't be compared.
      if (errorCode(error) !== "ENOENT") return undefined;
    }
  }
  return real;
};

/** Where the folders that hold credentials, sign-ins or Gram's own data really are now. */
const forbiddenFolders = async (bounds: LendBounds): Promise<ReadonlyArray<string> | undefined> => {
  let home: string;
  try {
    home = await fs.realpath(bounds.home);
  } catch {
    return undefined;
  }
  return realFolders([
    ...CREDENTIAL_FOLDERS_IN_HOME.map((parts) => join(home, ...parts)),
    ...bounds.agentHomes,
    ...bounds.ownFolders,
  ]);
};

export type Lendable =
  | {
      readonly ok: true;
      readonly path: string;
      readonly device: number;
      readonly inode: number;
    }
  | { readonly ok: false; readonly why: string };

const checkLendableNow = async (path: string, bounds: LendBounds): Promise<Lendable> => {
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
  if (segmentsOf(real).some(gitName) || (await holdsGit(real)))
    return { ok: false, why: "It is a Git folder, or inside one. Lend the project instead." };
  if (isCredentialFolder(real)) return { ok: false, why: "It holds credentials or sign-ins." };
  if (sep === "/") {
    const system = await realFolders(SYSTEM_FOLDERS);
    if (system === undefined)
      return { ok: false, why: "Gram couldn't check this folder against the ones it never lends." };
    if (system.some((folder) => within(folder, real) || within(real, folder)))
      return { ok: false, why: "Gram won't lend a system folder, or a folder that holds one." };
  }
  const forbidden = await forbiddenFolders(bounds);
  if (forbidden === undefined)
    return { ok: false, why: "Gram couldn't check this folder against the ones it never lends." };
  for (const where of forbidden) {
    if (within(where, real)) return { ok: false, why: "It holds credentials or sign-ins." };
    if (within(real, where))
      return { ok: false, why: "It contains a folder that holds credentials or sign-ins." };
  }
  return { ok: true, path: real, device: stats.dev, inode: stats.ino };
};

/**
 * Whether `path` may be lent, and where it really is. Refuses the whole disk, the home folder and
 * anything above it, system folders, Git folders, credential folders, agent login folders and
 * Gram's own folders, in both directions: a folder inside one of those, and a folder that
 * contains one.
 */
export const checkLendable = (path: string, bounds: LendBounds): Promise<Lendable> =>
  withDeadline(checkLendableNow(path, bounds), {
    ok: false,
    why: "Gram can't open this folder.",
  });

/**
 * A lent folder as the device keeps it: where it really is, the disk it is on and which folder it
 * was, so a folder moved into its place isn't taken for it.
 */
export interface LentFolder {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
  readonly bounds: LendBounds;
}

type Resolved = { readonly ok: true; readonly path: string; readonly stats: Stats } | Refused;

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;

/**
 * The real path of `relativePath` inside a lent folder.
 *
 * The names are judged first and alone: a path that leaves the folder, or names Git or a
 * credential anywhere in it, is refused without looking at the disk, so a refusal doesn't say
 * whether anything is there. Then the path is walked a name at a time, and the walk stops at the
 * first link that leaves the folder, with the same answer whatever lies behind it. What it
 * arrives at must be on the folder's disk and outside every folder that is never lent, as those
 * are now.
 */
const resolveInside = async (folder: LentFolder, relativePath: string): Promise<Resolved> => {
  if (relativePath.includes("\0") || isAbsolute(relativePath)) return refused("outside-folders");
  const parts = relativePath.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
  // `..` climbs, and a name that starts with it is how macOS spells a file's other forks.
  if (parts.some((part) => part.startsWith(".."))) return refused("outside-folders");
  if (
    sep === "\\" &&
    parts.some((part) => part.includes(":") || /[. ]$/.test(part) || WINDOWS_DEVICE_NAME.test(part))
  )
    return refused("outside-folders");
  if (namesCredential(parts)) return refused("credential-path");
  let current = folder.path;
  let stats: Stats;
  try {
    // The lent folder itself may have been replaced since it was lent, by a link or a folder.
    const root = await fs.realpath(folder.path);
    if (root !== folder.path) return refused("outside-folders");
    stats = await fs.stat(root);
    if (stats.dev !== folder.device || stats.ino !== folder.inode)
      return refused("outside-folders");
  } catch {
    return refused("outside-folders");
  }
  for (const part of parts) {
    const next = join(current, part);
    try {
      stats = await fs.lstat(next);
    } catch {
      return refused("not-a-file");
    }
    if (stats.isSymbolicLink()) {
      let target: string;
      try {
        target = await fs.realpath(next);
        stats = await fs.stat(target);
      } catch {
        // A link that can't be followed is answered like one that leaves.
        return refused("outside-folders");
      }
      if (!within(folder.path, target)) return refused("outside-folders");
      if (namesCredential(segmentsOf(relative(folder.path, target))))
        return refused("credential-path");
      current = target;
    } else current = next;
    if (stats.isDirectory() && (await holdsGit(current))) return refused("credential-path");
  }
  if (stats.dev !== folder.device) return refused("outside-folders");
  const forbidden = await forbiddenFolders(folder.bounds);
  if (forbidden === undefined) return refused("outside-folders");
  if (forbidden.some((where) => within(where, current))) return refused("credential-path");
  return { ok: true, path: current, stats };
};

export type WorkingFolder = { readonly ok: true; readonly path: string } | Refused;

/** Where a command starts: the lent folder, or a folder inside it, by real path now. */
export const resolveWorkingFolder = (
  folder: LentFolder,
  relativePath: string | undefined,
): Promise<WorkingFolder> =>
  withDeadline(
    resolveInside(folder, relativePath ?? "").then((resolved): WorkingFolder =>
      !resolved.ok
        ? resolved
        : resolved.stats.isDirectory()
          ? { ok: true, path: resolved.path }
          : refused("outside-folders"),
    ),
    refused("outside-folders"),
  );

export type FileTarget =
  | { readonly ok: true; readonly path: string; readonly size: number }
  | Refused;

/** The file a read names, for the ask to show before anything is opened. */
export const resolveLentFile = (folder: LentFolder, relativePath: string): Promise<FileTarget> =>
  withDeadline(
    resolveInside(folder, relativePath).then((resolved): FileTarget => {
      if (!resolved.ok) return resolved;
      if (!resolved.stats.isFile() || resolved.stats.nlink !== 1) return refused("not-a-file");
      return { ok: true, path: resolved.path, size: resolved.stats.size };
    }),
    refused("not-a-file"),
  );

/** Flags this platform doesn't have are left out; Windows has none of the three. */
const flag = (value: number | undefined): number => value ?? 0;

/**
 * Whether an open handle is the file or folder at `path`, asked of the kernel: on Linux the
 * handle's own name can be read back, and a folder swapped for a link on the way to it shows as
 * another name. Other platforms can't be asked, and answer yes.
 */
const handleIsAt = async (handle: fs.FileHandle, path: string): Promise<boolean> => {
  if (process.platform !== "linux") return true;
  try {
    return (await fs.readlink(`/proc/self/fd/${handle.fd}`)) === path;
  } catch {
    return false;
  }
};

export type FileRead =
  | { readonly ok: true; readonly path: string; readonly data: Buffer; readonly truncated: boolean }
  | Refused;

const readLentFileNow = async (
  folder: LentFolder,
  relativePath: string,
  maxBytes: number,
  expectedPath: string | undefined,
): Promise<FileRead> => {
  const resolved = await resolveInside(folder, relativePath);
  if (!resolved.ok) return resolved;
  if (expectedPath !== undefined && resolved.path !== expectedPath)
    return refused("outside-folders");
  // Nothing but a regular file is opened: opening a FIFO or a terminal is itself an act.
  if (!resolved.stats.isFile() || resolved.stats.nlink !== 1) return refused("not-a-file");
  if (!Number.isFinite(maxBytes)) return refused("too-large");
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(
      resolved.path,
      constants.O_RDONLY |
        flag(constants.O_NOFOLLOW) |
        flag(constants.O_NONBLOCK) |
        flag(constants.O_NOCTTY),
    );
  } catch (error) {
    return refused(errorCode(error) === "ELOOP" ? "outside-folders" : "not-a-file");
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) return refused("not-a-file");
    if (opened.dev !== folder.device) return refused("outside-folders");
    if (opened.dev !== resolved.stats.dev || opened.ino !== resolved.stats.ino)
      return refused("outside-folders");
    if (!(await handleIsAt(handle, resolved.path))) return refused("outside-folders");
    const again = await resolveInside(folder, relativePath);
    if (!again.ok || again.path !== resolved.path || again.stats.ino !== opened.ino)
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

/**
 * Reads a file inside a lent folder:
 *
 * 1. resolve its real path and require it inside the folder, on the same disk, with no Git or
 *    credential name (`resolveInside`), and a regular file with one hard link;
 * 2. open that path without following a final link and without blocking, and require the handle
 *    to be that same file by device and inode;
 * 3. ask the kernel where the handle is (Linux) and resolve the path again, and require both to
 *    be the path checked, so a folder swapped for a link on the way isn't read through;
 * 4. read at most `maxBytes` from the handle, counting bytes rather than trusting the size.
 *
 * Off Linux the handle can't be asked where it is, so a swap of a folder above the file, timed
 * between the checks by another process running as the person, can still win there.
 * `expectedPath`, when given, is the real path an ask showed: a file that now resolves elsewhere
 * is refused.
 */
export const readLentFile = (
  folder: LentFolder,
  relativePath: string,
  maxBytes: number,
  expectedPath?: string,
): Promise<FileRead> =>
  withDeadline(
    readLentFileNow(folder, relativePath, maxBytes, expectedPath),
    refused("not-a-file"),
  );

export type FolderTarget = { readonly ok: true; readonly path: string } | Refused;

/** The folder a listing names, for the ask to show. */
export const resolveLentFolder = (
  folder: LentFolder,
  relativePath: string,
): Promise<FolderTarget> =>
  withDeadline(
    resolveInside(folder, relativePath).then((resolved): FolderTarget =>
      !resolved.ok
        ? resolved
        : resolved.stats.isDirectory()
          ? { ok: true, path: resolved.path }
          : refused("not-a-file"),
    ),
    refused("not-a-file"),
  );

export type FolderListed =
  | {
      readonly ok: true;
      readonly path: string;
      readonly entries: ReadonlyArray<DeviceFileEntry>;
      readonly truncated: boolean;
    }
  | Refused;

/** A listing looks at no more names than this; a folder with more is listed as cut short. */
export const DEVICE_LIST_SCAN_MAX = 10_000;

const listLentFolderNow = async (
  folder: LentFolder,
  relativePath: string,
  limit: number,
  expectedPath: string | undefined,
): Promise<FolderListed> => {
  const resolved = await resolveInside(folder, relativePath);
  if (!resolved.ok) return resolved;
  if (!resolved.stats.isDirectory()) return refused("not-a-file");
  if (expectedPath !== undefined && resolved.path !== expectedPath)
    return refused("outside-folders");
  if (!Number.isFinite(limit)) return refused("too-large");
  const most = Math.max(1, Math.min(Math.floor(limit), DEVICE_LIST_MAX_ENTRIES));
  // On Linux the folder is held open and read through the handle, so what is listed is the
  // folder that was checked. Elsewhere it is read by path and the path checked again after.
  let handle: fs.FileHandle | undefined;
  let base = resolved.path;
  try {
    if (process.platform === "linux") {
      handle = await fs.open(
        resolved.path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const opened = await handle.stat();
      if (opened.dev !== resolved.stats.dev || opened.ino !== resolved.stats.ino)
        return refused("outside-folders");
      if (!(await handleIsAt(handle, resolved.path))) return refused("outside-folders");
      base = `/proc/self/fd/${handle.fd}`;
    }
    const names: Array<string> = [];
    let truncated = false;
    const dir = await fs.opendir(base);
    try {
      for await (const entry of dir) {
        if (namesCredential([entry.name])) continue;
        if (names.length === DEVICE_LIST_SCAN_MAX) {
          truncated = true;
          break;
        }
        names.push(entry.name);
      }
    } finally {
      await dir.close().catch(() => undefined);
    }
    names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (names.length > most) truncated = true;
    const entries: Array<DeviceFileEntry> = [];
    for (const name of names.slice(0, most)) {
      const stats = await fs.lstat(join(base, name)).catch(() => undefined);
      if (stats === undefined) continue;
      if (stats.isDirectory()) entries.push({ name, kind: "folder" });
      else if (stats.isFile())
        // A hard-linked file can't be read, and its size is another file's size.
        entries.push(
          stats.nlink === 1 ? { name, kind: "file", size: stats.size } : { name, kind: "file" },
        );
      else entries.push({ name, kind: "other" });
    }
    const again = await resolveInside(folder, relativePath);
    if (!again.ok || again.path !== resolved.path || again.stats.ino !== resolved.stats.ino)
      return refused("outside-folders");
    return { ok: true, path: resolved.path, entries, truncated };
  } catch {
    return refused("not-a-file");
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

/**
 * The entries of a folder inside a lent folder: names, kinds and sizes, never contents. Entries
 * that name a credential or Git are left out. Links are reported as "other" and not followed. The
 * names are sorted before they are cut to `limit`, so a short listing is the same one each time.
 */
export const listLentFolder = (
  folder: LentFolder,
  relativePath: string,
  limit: number,
  expectedPath?: string,
): Promise<FolderListed> =>
  withDeadline(listLentFolderNow(folder, relativePath, limit, expectedPath), refused("not-a-file"));
