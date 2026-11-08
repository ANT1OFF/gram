import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** What a joined machine keeps: where its main Gram is and who it is there. No secret. */
export interface HostConfig {
  readonly version: 1;
  /** The main Gram's tailnet origin, `https://<device>.<tailnet>.ts.net`. */
  readonly origin: string;
  readonly hostId: string;
  readonly name: string;
}

/**
 * The host's own folder: `GRAM_HOST_HOME` when set, otherwise Application Support on a Mac and the
 * XDG config folder on Linux. It holds `host.json` and the private key `host-key.pem`.
 */
export const hostHome = (env: NodeJS.ProcessEnv = process.env, home = homedir()): string => {
  const set = env["GRAM_HOST_HOME"];
  if (set !== undefined && set !== "") return set;
  if (process.platform === "darwin")
    return join(home, "Library", "Application Support", "Gram Host");
  const xdg = env["XDG_CONFIG_HOME"];
  return join(xdg !== undefined && xdg.startsWith("/") ? xdg : join(home, ".config"), "gram-host");
};

const CONFIG = "host.json";
const KEY = "host-key.pem";

const ownedPrivate = (path: string, directory: boolean) => {
  const stat = lstatSync(path);
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
  )
    throw new Error(`${path} must be private to this user (chmod ${directory ? "700" : "600"}).`);
};

const ensureHome = (home: string) => {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  ownedPrivate(home, true);
};

/** Writes `name` in `home` owner-only, replacing it atomically with the rename made durable. */
const writePrivate = (home: string, name: string, text: string) => {
  ensureHome(home);
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
    typeof value.name !== "string"
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

/** Forgets the join: the config and the key. The folder and its logs stay. */
export const forgetJoined = (home: string) => {
  rmSync(join(home, CONFIG), { force: true });
  rmSync(join(home, KEY), { force: true });
};
