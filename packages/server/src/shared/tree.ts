import {
  InvalidState,
  isSharedPath,
  SHARED_ABSENT,
  SHARED_FILE_MAX_BYTES,
  SHARED_FILES_MAX,
  SHARED_FOLDER_MAX_BYTES,
  SHARED_PART_BYTES,
  SHARED_RESERVED_PREFIX,
  type SharedEntry,
  type SharedListing,
  type SharedPart,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, rmdir, unlink, utimes } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isStrictlyInside } from "@gram/git";

const INCOMING = `${SHARED_RESERVED_PREFIX}incoming`;
const MAX_DEPTH = 32;
const MAX_HELD = 1_000;

export interface SharedWrite {
  readonly path: string;
  readonly offset: number;
  /** Base64. */
  readonly data: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
  /** The hash the file there must still have for this write to land; `absent` for none. */
  readonly ifMatch: string;
}

/** A shared folder's files on one machine, read and written as a sync does. */
export interface SharedTree {
  readonly root: string;
  /** Makes the folder when it isn't there; answers where it is. */
  readonly open: Effect.Effect<string, InvalidState>;
  readonly list: Effect.Effect<SharedListing, InvalidState>;
  readonly read: (
    path: string,
    offset: number,
    length: number,
  ) => Effect.Effect<SharedPart, InvalidState>;
  readonly write: (write: SharedWrite) => Effect.Effect<{ readonly placed: boolean }, InvalidState>;
  readonly remove: (
    path: string,
    ifMatch: string,
  ) => Effect.Effect<{ readonly removed: boolean }, InvalidState>;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const codeOf = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;

const invalid = (message: string) => new InvalidState({ message });

const attempt = <A>(what: string, run: () => Promise<A>): Effect.Effect<A, InvalidState> =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      error instanceof InvalidState ? error : invalid(`${what}: ${messageOf(error)}`),
  });

const hashFile = async (path: string): Promise<string> => {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
};

interface Known {
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}

const bytesUnder = async (folder: string): Promise<number> => {
  let total = 0;
  const walk = async (at: string, depth: number): Promise<void> => {
    const names = await readdir(at, { withFileTypes: true }).catch(() => []);
    for (const entry of names) {
      const absolute = join(at, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH + 1) await walk(absolute, depth + 1);
      } else if (entry.isFile()) {
        total += (await lstat(absolute).catch(() => undefined))?.size ?? 0;
      }
    }
  };
  await walk(folder, 0);
  return total;
};

/** The shared folder at `root` on this machine; `maxBytes` the most a sync fills it to. */
export const sharedTree = (
  root: string,
  maxBytes: number = SHARED_FOLDER_MAX_BYTES,
): SharedTree => {
  const base = resolve(root);
  const known = new Map<string, Known>();

  const resolveIn = async (path: string): Promise<string> => {
    if (!isSharedPath(path)) throw invalid(`Not a path in a shared folder: ${path}`);
    const parts = path.split("/");
    let at = base;
    for (const part of parts.slice(0, -1)) {
      at = join(at, part);
      const info = await lstat(at).catch((error: unknown) => {
        if (codeOf(error) === "ENOENT") return undefined;
        throw error;
      });
      if (info === undefined) break;
      if (!info.isDirectory()) throw invalid(`${path} goes through something that isn't a folder`);
    }
    return join(base, ...parts);
  };

  const hashOf = async (absolute: string, path: string): Promise<string> => {
    const info = await lstat(absolute).catch((error: unknown) => {
      if (codeOf(error) === "ENOENT") return undefined;
      throw error;
    });
    if (info === undefined) return SHARED_ABSENT;
    if (!info.isFile()) throw invalid(`${path} isn't a plain file`);
    const before = known.get(path);
    if (before !== undefined && before.size === info.size && before.mtimeMs === info.mtimeMs)
      return before.sha256;
    const sha256 = await hashFile(absolute);
    known.set(path, { size: info.size, mtimeMs: info.mtimeMs, sha256 });
    return sha256;
  };

  const openFolder = attempt("Couldn't make the shared folder", async () => {
    await mkdir(base, { recursive: true, mode: 0o700 });
    const info = await lstat(base);
    if (!info.isDirectory()) throw invalid(`${base} isn't a folder`);
    return base;
  });

  const list = attempt("Couldn't list the shared folder", async () => {
    const entries: SharedEntry[] = [];
    const held: string[] = [];
    const seen = new Set<string>();
    let complete = true;
    const hold = (path: string) => {
      if (held.length < MAX_HELD) held.push(path);
    };
    const walk = async (folder: string, prefix: string, depth: number): Promise<void> => {
      const names = await readdir(folder, { withFileTypes: true }).catch((error: unknown) => {
        if (codeOf(error) === "ENOENT") return [];
        throw error;
      });
      names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of names) {
        if (!complete) return;
        if (entry.name.startsWith(SHARED_RESERVED_PREFIX)) continue;
        const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        const absolute = join(folder, entry.name);
        if (entry.isDirectory()) {
          if (depth >= MAX_DEPTH || !isSharedPath(path)) hold(path);
          else await walk(absolute, path, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!isSharedPath(path)) {
          hold(path);
          continue;
        }
        const info = await lstat(absolute).catch(() => undefined);
        if (info === undefined || !info.isFile()) continue;
        if (info.size > SHARED_FILE_MAX_BYTES) {
          hold(path);
          continue;
        }
        if (entries.length >= SHARED_FILES_MAX) {
          complete = false;
          return;
        }
        const sha256 = await hashOf(absolute, path).catch(() => undefined);
        if (sha256 === undefined || sha256 === SHARED_ABSENT) continue;
        seen.add(path);
        entries.push({ path, size: info.size, mtimeMs: info.mtimeMs, sha256 });
      }
    };
    await walk(base, "", 0);
    for (const path of known.keys()) if (!seen.has(path)) known.delete(path);
    return { entries, held, complete };
  });

  const read = (path: string, offset: number, length: number) =>
    attempt(`Couldn't read ${path}`, async () => {
      const absolute = await resolveIn(path);
      const sha256 = await hashOf(absolute, path);
      if (sha256 === SHARED_ABSENT) throw invalid(`${path} isn't there`);
      const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        const want = Math.max(0, Math.min(length, SHARED_PART_BYTES, info.size - offset));
        const buffer = Buffer.alloc(want);
        let filled = 0;
        while (filled < want) {
          const { bytesRead } = await handle.read(buffer, filled, want - filled, offset + filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        return { data: buffer.subarray(0, filled).toString("base64"), size: info.size, sha256 };
      } finally {
        await handle.close();
      }
    });

  const incomingOf = (path: string, sha256: string) =>
    join(
      base,
      INCOMING,
      `${createHash("sha256").update(path).digest("hex").slice(0, 16)}-${sha256.slice(0, 16)}`,
    );

  const makeParents = async (absolute: string, path: string) => {
    const parts = path.split("/").slice(0, -1);
    let at = base;
    for (const part of parts) {
      at = join(at, part);
      await mkdir(at, { mode: 0o700 }).catch((error: unknown) => {
        if (codeOf(error) !== "EEXIST") throw error;
      });
      const info = await lstat(at);
      if (!info.isDirectory()) throw invalid(`${path} goes through something that isn't a folder`);
    }
    if (dirname(absolute) !== at) throw invalid(`${path} isn't inside the shared folder`);
  };

  const write = (request: SharedWrite) =>
    attempt(`Couldn't write ${request.path}`, async () => {
      const { path, offset, size, sha256, ifMatch, mtimeMs } = request;
      if (size > SHARED_FILE_MAX_BYTES) throw invalid(`${path} is too large to share`);
      if (!/^[0-9a-f]{64}$/.test(sha256)) throw invalid(`Not a file hash: ${sha256}`);
      const absolute = await resolveIn(path);
      const bytes = Buffer.from(request.data, "base64");
      if (bytes.length > SHARED_PART_BYTES || offset + bytes.length > size)
        throw invalid(`A part of ${path} that doesn't fit it`);
      if (offset === 0) {
        const replaced = (await lstat(absolute).catch(() => undefined))?.size ?? 0;
        if ((await bytesUnder(base)) - replaced + size > maxBytes)
          throw invalid(
            `The shared folder is full (${Math.round(maxBytes / 2 ** 20)} MB here), so ${path} isn't taken in`,
          );
      }
      await mkdir(join(base, INCOMING), { recursive: true, mode: 0o700 });
      const incoming = incomingOf(path, sha256);
      const handle = await open(
        incoming,
        offset === 0
          ? constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0)
          : constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      ).catch((error: unknown) => {
        if (codeOf(error) === "ENOENT") throw invalid(`${path}'s earlier parts aren't here`);
        throw error;
      });
      try {
        if ((await handle.stat()).size !== offset) {
          throw invalid(`${path}'s earlier parts aren't here`);
        }
        await handle.write(bytes, 0, bytes.length, offset);
        if (offset + bytes.length < size) return { placed: false };
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        if ((await hashFile(incoming)) !== sha256) throw invalid(`${path} didn't arrive whole`);
        if ((await hashOf(absolute, path)) !== ifMatch) return { placed: false };
        await makeParents(absolute, path);
        const seconds = mtimeMs / 1000;
        await utimes(incoming, seconds, seconds);
        await rename(incoming, absolute);
        const info = await lstat(absolute);
        known.set(path, { size: info.size, mtimeMs: info.mtimeMs, sha256 });
        return { placed: true };
      } finally {
        await rm(incoming, { force: true });
      }
    });

  const remove = (path: string, ifMatch: string) =>
    attempt(`Couldn't delete ${path}`, async () => {
      const absolute = await resolveIn(path);
      const now = await hashOf(absolute, path);
      if (now === SHARED_ABSENT) return { removed: true };
      if (now !== ifMatch) return { removed: false };
      await unlink(absolute);
      known.delete(path);
      let folder = dirname(absolute);
      while (isStrictlyInside(base, folder)) {
        const gone = await rmdir(folder).then(
          () => true,
          () => false,
        );
        if (!gone) break;
        folder = dirname(folder);
      }
      return { removed: true };
    });

  return { root: base, open: openFolder, list, read, write, remove };
};
