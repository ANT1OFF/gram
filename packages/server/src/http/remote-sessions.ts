import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface RemoteSession {
  readonly hash: string;
  readonly expiresAt: number;
  /** A fixed-vocabulary device and browser name, such as "iPhone · Safari"; never the user agent. */
  readonly label?: string;
  readonly pairedAt?: number;
  /** Rounded to the hour it was stored in, so a busy phone doesn't rewrite the file. */
  readonly lastSeenAt?: number;
}
export interface RemoteSessionStore {
  readonly read: () => RemoteSession[];
  readonly write: (sessions: readonly RemoteSession[]) => void;
}
export const sessionHash = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const assertPrivate = (stat: Stats, isDirectory: boolean) => {
  if (
    (isDirectory ? !stat.isDirectory() : !stat.isFile()) ||
    (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
  )
    throw new Error("Remote session storage must be a private owner-controlled file/directory");
};

const optionalLabel = (session: object) =>
  !("label" in session) ||
  (typeof session.label === "string" && /^[A-Za-z0-9 ·]{1,40}$/.test(session.label));
const optionalTime = (session: object, key: "pairedAt" | "lastSeenAt") => {
  if (!(key in session)) return true;
  const value: unknown = (session as Record<string, unknown>)[key];
  return Number.isSafeInteger(value) && Number(value) > 0;
};

/**
 * One private JSON file in `<dataDir>/remote-access`: opened without following links, refused
 * unless owner-only, bounded in size, and replaced atomically with the rename made durable.
 */
export const privateJsonFile = (dataDir: string, name: string, maxBytes: number) => {
  const directory = join(dataDir, "remote-access");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivate(lstatSync(directory), true);
  const path = join(directory, name);
  /** The parsed file, or undefined when there is none; throws on an unsafe or oversized file. */
  const read = (): unknown => {
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Remote access storage could not be opened safely", { cause: error });
    }
    try {
      const stat = fstatSync(fd);
      assertPrivate(stat, false);
      if (stat.size > maxBytes) throw new Error("Remote access storage is invalid");
      return JSON.parse(readFileSync(fd, "utf8"));
    } finally {
      closeSync(fd);
    }
  };
  /**
   * Replaces the file with `value`. `modified`, when given, is set as its modified time on the new
   * file before it replaces the old, so the two land together or neither does.
   */
  const write = (value: unknown, modified?: number) => {
    assertPrivate(lstatSync(directory), true);
    const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      writeFileSync(fd, JSON.stringify(value));
      if (modified !== undefined) futimesSync(fd, new Date(), new Date(modified));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, path);
      // Persist the rename as well as file contents before granting the browser access.
      if (process.platform !== "win32") {
        const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          fsyncSync(directoryFd);
        } finally {
          closeSync(directoryFd);
        }
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  };
  return { read, write };
};

/** Private, origin/port-bound hashes only; never persist invitation or browser bearer tokens. */
export const fileRemoteSessionStore = (
  dataDir: string,
  origin: string,
  port: number,
): RemoteSessionStore => {
  const file = privateJsonFile(dataDir, `${sessionHash(`${origin}\n${port}`)}.json`, 8192);
  const read = (): RemoteSession[] => {
    const value = file.read();
    if (value === undefined) return [];
    if (typeof value !== "object" || value === null)
      throw new Error("Remote session storage is invalid");
    const record = value as Record<string, unknown>;
    if (
      record.version !== 1 ||
      record.origin !== origin ||
      record.port !== port ||
      !Array.isArray(record.sessions) ||
      record.sessions.length > 8 ||
      !record.sessions.every(
        (session: unknown) =>
          typeof session === "object" &&
          session !== null &&
          "hash" in session &&
          typeof session.hash === "string" &&
          /^[a-f0-9]{64}$/.test(session.hash) &&
          "expiresAt" in session &&
          Number.isSafeInteger(session.expiresAt) &&
          Number(session.expiresAt) > 0 &&
          optionalLabel(session) &&
          optionalTime(session, "pairedAt") &&
          optionalTime(session, "lastSeenAt"),
      )
    )
      throw new Error("Remote session storage is invalid");
    return record.sessions as RemoteSession[];
  };
  return {
    read,
    write: (sessions) => {
      // Validate current storage before replacement; never repair an insecure/corrupt file silently.
      read();
      file.write({ version: 1, origin, port, sessions });
    },
  };
};
