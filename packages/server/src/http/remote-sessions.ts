import { createHash, randomBytes } from "node:crypto";
import {
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
  type Stats,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface RemoteSession {
  readonly hash: string;
  readonly expiresAt: number;
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

/** Private, origin/port-bound hashes only; never persist invitation or browser bearer tokens. */
export const fileRemoteSessionStore = (
  dataDir: string,
  origin: string,
  port: number,
): RemoteSessionStore => {
  const directory = join(dataDir, "remote-access");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivate(lstatSync(directory), true);
  const path = join(directory, `${sessionHash(`${origin}\n${port}`)}.json`);
  const read = (): RemoteSession[] => {
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("Remote session storage could not be opened safely", { cause: error });
    }
    try {
      const stat = fstatSync(fd);
      assertPrivate(stat, false);
      if (stat.size > 4096) throw new Error("Remote session storage is invalid");
      const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
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
            Number(session.expiresAt) > 0,
        )
      )
        throw new Error("Remote session storage is invalid");
      return record.sessions as RemoteSession[];
    } finally {
      closeSync(fd);
    }
  };
  return {
    read,
    write: (sessions) => {
      // Validate current storage before replacement; never repair an insecure/corrupt file silently.
      assertPrivate(lstatSync(directory), true);
      read();
      const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
      let fd: number | undefined;
      try {
        fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        writeFileSync(fd, JSON.stringify({ version: 1, origin, port, sessions }));
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
    },
  };
};
