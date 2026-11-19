import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isStrictlyInside } from "@gram/git";
import { randomBytes } from "node:crypto";

/** What a joined machine keeps: where its main Gram is and who it is there. No secret. */
export interface HostConfig {
  readonly version: 1;
  /** The main Gram's tailnet origin, `https://<device>.<tailnet>.ts.net`. */
  readonly origin: string;
  readonly hostId: string;
  readonly name: string;
  /**
   * Set by `gram-host provision`: the host made its key for a control plane to register, and
   * `origin` is that Gram's provisioned-host address rather than a tailnet one.
   */
  readonly provisioned?: true;
}

/**
 * The host's own folder: `GRAM_HOST_HOME` when set, otherwise Application Support on a Mac and the
 * XDG config folder on Linux. It holds `host.json`, the private key `host-key.pem`
 * and, when the user sent one, the Claude token `claude-oauth-token`.
 */
export const hostHome = (env: NodeJS.ProcessEnv = process.env, home = homedir()): string => {
  const set = env["GRAM_HOST_HOME"];
  if (set !== undefined && set !== "") return set;
  if (process.platform === "darwin")
    return join(home, "Library", "Application Support", "Gram Host");
  const xdg = env["XDG_CONFIG_HOME"];
  return join(xdg !== undefined && xdg.startsWith("/") ? xdg : join(home, ".config"), "gram-host");
};

/** Where the host keeps the files users attach to its sessions: `attachments` in its folder. */
export const hostAttachments = (env: NodeJS.ProcessEnv = process.env, home = homedir()): string =>
  join(hostHome(env, home), "attachments");

/**
 * Where the host keeps its mirrors of workspaces' shared folders, one folder each:
 * `GRAM_HOST_SHARED` when set, otherwise `shared` in the host's own folder.
 */
export const hostShared = (env: NodeJS.ProcessEnv = process.env, home = homedir()): string => {
  const set = env["GRAM_HOST_SHARED"];
  return set !== undefined && set !== "" ? set : join(hostHome(env, home), "shared");
};

/**
 * Where the host keeps its clones of the repositories workers placed on it work in:
 * `GRAM_HOST_REPOS` when set, otherwise `repos` in the host's own folder.
 */
export const hostRepos = (env: NodeJS.ProcessEnv = process.env, home = homedir()): string => {
  const set = env["GRAM_HOST_REPOS"];
  return set !== undefined && set !== "" ? set : join(hostHome(env, home), "repos");
};

const CONFIG = "host.json";
const KEY = "host-key.pem";
/** A token from `claude setup-token` the user sent from the main machine; never anything else. */
export const CLAUDE_TOKEN = "claude-oauth-token";

/**
 * What `claude setup-token` prints: `sk-ant-oat`, a two-digit version, then base64url. Anything
 * else is refused, so the file can't be made to carry another kind of key.
 */
export const CLAUDE_TOKEN_SHAPE = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,1000}$/;

const ownedPrivate = (path: string, directory: boolean) => {
  const stat = lstatSync(path);
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
  )
    throw new Error(`${path} must be private to this user (chmod ${directory ? "700" : "600"}).`);
};

/** Creates a private destination, or refuses an unsafe existing folder before a join. */
export const ensureHostHome = (home: string) => {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  ownedPrivate(home, true);
};

/** Writes `name` in `home` owner-only, replacing it atomically with the rename made durable. */
const writePrivate = (home: string, name: string, text: string) => {
  ensureHostHome(home);
  const path = join(home, name);
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
};

/**
 * Writes `name` in `home` owner-only unless it is there already: made in full beside it, then linked
 * into place, which fails rather than replace one that another writer made first.
 */
const createPrivate = (home: string, name: string, text: string) => {
  ensureHostHome(home);
  const path = join(home, name);
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    syncFolder(home);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
};

/** Reads `name` in `home` without following a link, refused unless owner-only; undefined if none. */
const readPrivate = (home: string, name: string): string | undefined => {
  let fd: number;
  try {
    fd = openSync(join(home, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 16 * 1024 ||
      (process.platform !== "win32" &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    )
      throw new Error(`${join(home, name)} must be a private file of this user (chmod 600).`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
};

export const readHostConfig = (home: string): HostConfig | undefined => {
  const text = readPrivate(home, CONFIG);
  if (text === undefined) return undefined;
  const value = JSON.parse(text) as Partial<HostConfig> | null;
  if (
    value === null ||
    value.version !== 1 ||
    typeof value.origin !== "string" ||
    typeof value.hostId !== "string" ||
    typeof value.name !== "string" ||
    (value.provisioned !== undefined && value.provisioned !== true)
  )
    throw new Error(`${join(home, CONFIG)} isn't a gram-host config.`);
  return value as HostConfig;
};

export const readHostKey = (home: string): string | undefined => readPrivate(home, KEY);

/** Keeps a join: the key first, so a config never names a key that isn't there. */
export const writeJoined = (home: string, config: HostConfig, privateKeyPem: string) => {
  writePrivate(home, KEY, privateKeyPem);
  writePrivate(home, CONFIG, `${JSON.stringify(config, null, 2)}\n`);
};

/** Forgets the join: the config, the key and any Claude token. The folder and its logs stay. */
export const forgetJoined = (home: string) => {
  forgetClaudeToken(home);
  rmSync(join(home, CONFIG), { force: true });
  rmSync(join(home, KEY), { force: true });
};

/**
 * The file in the host's folder that names the disk it runs on (`HostHello.diskId`). Made the first
 * time the host starts there and never copied with its clones: a host brought back on a new disk
 * with its key and join but not this file makes a new one, and so says it is on another disk.
 */
export const DISK_ID = "disk-id";
const DISK_ID_SHAPE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The id of the disk `home` is on, made and kept owner-only on first use. One that isn't an id
 * (cut short, edited) is replaced: the host then says it is on another disk, which only makes
 * Gram put its folders back first. Throws when the folder or the file isn't private to this user.
 */
/** A new disk id, as its file holds it. */
const newDiskId = () => `${randomBytes(16).toString("base64url")}\n`;

export const hostDiskId = (home: string): string => {
  const read = () => {
    const kept = readPrivate(home, DISK_ID)?.trim();
    return kept !== undefined && DISK_ID_SHAPE.test(kept) ? kept : undefined;
  };
  const kept = read();
  // Said only once durable: an id another start of the host just made is synced here too.
  if (kept !== undefined) {
    syncFolder(home);
    return kept;
  }
  // None there: made only if none is there still, so two hosts starting at once on one disk both
  // read back whichever was made first.
  if (readPrivate(home, DISK_ID) === undefined) {
    createPrivate(home, DISK_ID, newDiskId());
    const first = read();
    if (first !== undefined) {
      syncFolder(home);
      return first;
    }
  }
  // One there that isn't an id (cut short, edited): replaced by one host at a time, each looking
  // again once it holds the lock, so a repair never replaces an id another host just made.
  return withLock(join(home, `${DISK_ID}.lock`), () => {
    const now = read();
    if (now !== undefined) {
      syncFolder(home);
      return now;
    }
    writePrivate(home, DISK_ID, newDiskId());
    syncFolder(home);
    const repaired = read();
    if (repaired === undefined) throw new Error(`${join(home, DISK_ID)} couldn't be made.`);
    return repaired;
  });
};

/**
 * Gives `home` a new disk id, once its host is told this disk is the machine now
 * (`gram-host new-disk`): at its next start it says a disk the main Gram hasn't seen, so it comes
 * back as the machine replaced afresh, owing a resume, rather than a disk it was replaced from.
 * Answers the new id.
 */
export const renewDiskId = (home: string): string =>
  withLock(join(home, `${DISK_ID}.lock`), () => {
    const before = readPrivate(home, DISK_ID)?.trim();
    let made = newDiskId();
    while (made.trim() === before) made = newDiskId();
    writePrivate(home, DISK_ID, made);
    syncFolder(home);
    return made.trim();
  });

/** The folder in a work volume of its own that holds that volume's id (`hostIdentity`). */
export const VOLUME_ID_FOLDER = ".gram-volume";

/** Whether `repos` is on storage of its own: outside `home`, or on another device. */
const onOwnStorage = (home: string, repos: string): boolean => {
  if (!isStrictlyInside(home, repos)) return true;
  try {
    return statSync(repos).dev !== statSync(home).dev;
  } catch (error) {
    // Not made yet: it will be, inside the home folder. Anything else can't be told: its own.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
};

/**
 * The id a host says of its disk (`HostHello.diskId`): its home folder's (`hostDiskId`), and,
 * when its clones (`GRAM_HOST_REPOS`) are on storage of their own, that volume's too, kept in it.
 * A work volume swapped or wiped under a home that stays then reads as another disk, owing a
 * resume. One whose id can't be kept is unknown, never guessed: a new id each start, which owes
 * a resume each time.
 */
export const hostIdentity = (
  home: string,
  repos: string,
): { readonly diskId: string; readonly unknown?: true } => {
  const own = hostDiskId(home);
  if (!onOwnStorage(home, repos)) return { diskId: own };
  try {
    mkdirSync(repos, { recursive: true });
    const volume = hostDiskId(join(repos, VOLUME_ID_FOLDER));
    syncFolder(repos);
    return { diskId: `${own}-${volume}` };
  } catch {
    return { diskId: `${own}-${newDiskId().trim()}`, unknown: true };
  }
};

/** How long a lock left by a host that died holding it is waited out before it is taken. */
const LOCK_STALE_MS = 30_000;

/** Runs `run` holding the lock folder `path`, made exclusively; one older than a crash is taken. */
const withLock = <A>(path: string, run: () => A): A => {
  const until = Date.now() + LOCK_STALE_MS + 5_000;
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let age = 0;
      try {
        age = Date.now() - lstatSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (age > LOCK_STALE_MS) rmSync(path, { recursive: true, force: true });
      else if (Date.now() > until) throw new Error(`${path} is held.`, { cause: error });
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return run();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
};

/** Makes what was renamed or linked into `folder` durable, where the platform can. */
const syncFolder = (folder: string) => {
  if (process.platform === "win32") return;
  const fd = openSync(folder, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

/** The refusal for a token that isn't `CLAUDE_TOKEN_SHAPE`; it never quotes what it was given. */
export const NOT_A_CLAUDE_TOKEN = "That isn't a token from `claude setup-token`.";

/** Keeps `token` owner-only in `home`, replacing any kept before. */
export const writeClaudeToken = (home: string, token: string) => {
  if (!CLAUDE_TOKEN_SHAPE.test(token)) throw new Error(NOT_A_CLAUDE_TOKEN);
  writePrivate(home, CLAUDE_TOKEN, `${token}\n`);
};

/**
 * The kept token, or undefined when there is none or the file doesn't hold one. A file that isn't
 * private to this user throws, naming only its path.
 */
export const readClaudeToken = (home: string): string | undefined => {
  const token = readPrivate(home, CLAUDE_TOKEN)?.trim();
  return token !== undefined && CLAUDE_TOKEN_SHAPE.test(token) ? token : undefined;
};

/** Deletes the kept token; true when there was a file to delete. */
export const forgetClaudeToken = (home: string): boolean => {
  const path = join(home, CLAUDE_TOKEN);
  let there = true;
  try {
    lstatSync(path);
  } catch {
    there = false;
  }
  rmSync(path, { force: true });
  return there;
};
