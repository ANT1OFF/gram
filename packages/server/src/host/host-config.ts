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

/** Forgets the join: the config, the key and any Claude token. The folder and its logs stay. */
export const forgetJoined = (home: string) => {
  forgetClaudeToken(home);
  rmSync(join(home, CONFIG), { force: true });
  rmSync(join(home, KEY), { force: true });
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
