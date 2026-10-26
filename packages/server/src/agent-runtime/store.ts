/**
 * The managed runtime store's on-disk layout, and the only code that writes it:
 *
 * ```
 * <root>/codex/
 *   active.json             which version runs, and the one before it
 *   versions/<version>-<target>/   an unpacked, verified package; never written once in place
 *   staging/<random>/       a download in progress; anything here at startup is deleted
 * ```
 *
 * A version directory is renamed into `versions/` only after its archive and entrypoint have been
 * verified and smoke-tested, and `active.json` is replaced by renaming a temp file over it, so a
 * crash at any point leaves the old selection or the new one, never a half-installed one. Nothing
 * here touches the user's own `codex`, PATH, `~/.codex` or any shell profile.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isStrictlyInside } from "@gram/git";

/** What was verified about one installed version; written once, when it is moved into place. */
export interface RuntimeReceipt {
  /** `<version>-<target>`, the directory name under `versions/`. */
  readonly id: string;
  readonly version: string;
  readonly target: string;
  /** SHA-256 of the archive it was unpacked from, as the gate approved it. */
  readonly archiveSha256: string;
  readonly archiveSize: number;
  /** The executable, relative to the version directory. */
  readonly entrypoint: string;
  /** SHA-256 of the executable as unpacked, checked again before each launch. */
  readonly entrypointSha256: string;
  readonly source: "bundled" | "catalog";
  readonly installedAt: string;
}

export interface ActiveRecord {
  readonly current?: RuntimeReceipt | undefined;
  /** What `rollback` returns to. */
  readonly previous?: RuntimeReceipt | undefined;
  /**
   * The current version hasn't yet started a session. A startup failure while this holds is the
   * update's fault, and rolls back on its own.
   */
  readonly unproven?: boolean | undefined;
  /** The last version that failed and was rolled back from, so it isn't offered again at once. */
  readonly rejected?: { readonly id: string; readonly message: string; readonly at: string };
}

/**
 * Where the store lives: `<dataDir>/agents` on macOS, beside the rest of Gram's per-user
 * state; `%LOCALAPPDATA%\Gram\agents` on Windows, because the data dir there is under the
 * roaming profile and a few hundred MB of executables must not follow the user between machines.
 */
export const runtimeRoot = (
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"] ?? win32.join(homedir(), "AppData", "Local");
    return win32.join(local, "Gram", "agents");
  }
  return posix.join(dataDir, "agents");
};

export const versionId = (version: string, target: string) => `${version}-${target}`;

const LOCKED = new Set(["EPERM", "EBUSY", "EACCES"]);
const codeOf = (error: unknown) => (error as { code?: string } | null)?.code;

/**
 * `rename`, retried briefly where Windows holds the file open (the indexer, antivirus); elsewhere
 * a single attempt.
 */
const renameRetrying = async (
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
  attempts = 8,
): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (platform !== "win32" || attempt >= attempts || !LOCKED.has(codeOf(error) ?? "")) {
        throw error;
      }
      await sleep(50 * attempt);
    }
  }
};

export const sha256File = (path: string, signal?: AbortSignal): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path, signal === undefined ? {} : { signal });
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", reject);
    input.once("end", () => resolvePromise(hash.digest("hex")));
  });

/** A file's SHA-256 (hex) and its npm-style SHA-512 integrity, in one read. */
export const hashFile = (
  path: string,
  signal?: AbortSignal,
): Promise<{ readonly sha256: string; readonly integrity: string }> =>
  new Promise((resolvePromise, reject) => {
    const sha256 = createHash("sha256");
    const sha512 = createHash("sha512");
    const input = createReadStream(path, signal === undefined ? {} : { signal });
    input.on("data", (chunk) => {
      sha256.update(chunk);
      sha512.update(chunk);
    });
    input.once("error", reject);
    input.once("end", () =>
      resolvePromise({
        sha256: sha256.digest("hex"),
        integrity: `sha512-${sha512.digest("base64")}`,
      }),
    );
  });

const isReceipt = (value: unknown): value is RuntimeReceipt => {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r["id"] === "string" &&
    typeof r["version"] === "string" &&
    typeof r["target"] === "string" &&
    typeof r["archiveSha256"] === "string" &&
    typeof r["archiveSize"] === "number" &&
    typeof r["entrypoint"] === "string" &&
    typeof r["entrypointSha256"] === "string" &&
    (r["source"] === "bundled" || r["source"] === "catalog") &&
    typeof r["installedAt"] === "string" &&
    r["id"] === versionId(r["version"] as string, r["target"] as string)
  );
};

const parseActive = (text: string): ActiveRecord => {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const rejected = record["rejected"] as ActiveRecord["rejected"] | undefined;
  return {
    ...(isReceipt(record["current"]) ? { current: record["current"] } : {}),
    ...(isReceipt(record["previous"]) ? { previous: record["previous"] } : {}),
    ...(record["unproven"] === true ? { unproven: true } : {}),
    ...(typeof rejected?.id === "string" && typeof rejected.message === "string"
      ? { rejected }
      : {}),
  };
};

export interface RuntimeStore {
  readonly dir: string;
  readonly versionsDir: string;
  readonly stagingDir: string;
  readonly versionDir: (id: string) => string;
  readonly executable: (receipt: RuntimeReceipt) => string;
  readonly readActive: () => Promise<ActiveRecord>;
  /** Replaces `active.json` atomically. */
  readonly writeActive: (record: ActiveRecord) => Promise<void>;
  /** A fresh, empty staging directory. */
  readonly makeStaging: () => Promise<string>;
  /** Moves a verified staging directory into `versions/<id>`, replacing a stale one not in use. */
  readonly commit: (staged: string, id: string) => Promise<void>;
  /**
   * Startup recovery: empties `staging/`, drops a selection whose files are gone (falling back to
   * the previous one), and returns the record that results.
   */
  readonly recover: () => Promise<ActiveRecord>;
  /** Deletes version directories other than `keep`. */
  readonly prune: (keep: ReadonlySet<string>) => Promise<void>;
  /** Whether the receipt's executable is there with the bytes it was installed with. */
  readonly intact: (receipt: RuntimeReceipt) => Promise<boolean>;
}

export const makeRuntimeStore = (
  root: string,
  agent: "codex",
  platform: NodeJS.Platform = process.platform,
): RuntimeStore => {
  const dir = join(root, agent);
  const versionsDir = join(dir, "versions");
  const stagingDir = join(dir, "staging");
  const activePath = join(dir, "active.json");
  const versionDir = (id: string) => join(versionsDir, id);
  const executable = (receipt: RuntimeReceipt) => join(versionDir(receipt.id), receipt.entrypoint);
  /** Executable fingerprints already hashed this run, so a launch rehashes only what changed. */
  const verified = new Map<string, string>();

  const readActive = async (): Promise<ActiveRecord> => {
    try {
      return parseActive(await readFile(activePath, "utf8"));
    } catch (error) {
      // Missing is the fresh state; a torn or hand-edited file selects nothing rather than guess.
      if (codeOf(error) === "ENOENT" || error instanceof SyntaxError) return {};
      throw error;
    }
  };

  const writeActive = async (record: ActiveRecord): Promise<void> => {
    await mkdir(dir, { recursive: true });
    const temp = join(dir, `.active-${randomUUID()}.json`);
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flush: true });
    try {
      await renameRetrying(temp, activePath, platform);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  };

  const intact = async (receipt: RuntimeReceipt): Promise<boolean> => {
    const path = executable(receipt);
    if (!isStrictlyInside(versionDir(receipt.id), path)) return false;
    try {
      const info = await stat(path);
      if (!info.isFile()) return false;
      const fingerprint = `${info.size}:${info.mtimeMs}:${info.ino}`;
      if (verified.get(path) === fingerprint) return true;
      const ok = (await sha256File(path)) === receipt.entrypointSha256;
      if (ok) verified.set(path, fingerprint);
      else verified.delete(path);
      return ok;
    } catch {
      // Unreadable is as good as missing: it can't be launched as what was verified.
      return false;
    }
  };

  return {
    dir,
    versionsDir,
    stagingDir,
    versionDir,
    executable,
    readActive,
    writeActive,
    intact,
    makeStaging: async () => {
      const path = join(stagingDir, randomUUID());
      await mkdir(path, { recursive: true, mode: 0o700 });
      return path;
    },
    commit: async (staged, id) => {
      await mkdir(versionsDir, { recursive: true });
      const target = versionDir(id);
      // Windows can't rename onto an existing directory; a leftover of the same id (a crash after
      // commit, before activation) isn't selected by anything, so it goes.
      await rm(target, { recursive: true, force: true, maxRetries: 5 });
      await renameRetrying(staged, target, platform);
    },
    recover: async () => {
      await rm(stagingDir, { recursive: true, force: true, maxRetries: 5 });
      for (const name of await readdir(dir).catch(() => [] as Array<string>)) {
        if (name.startsWith(".active-")) await rm(join(dir, name), { force: true });
      }
      const record = await readActive();
      const currentOk = record.current !== undefined && (await intact(record.current));
      const previousOk = record.previous !== undefined && (await intact(record.previous));
      if (record.current === undefined || currentOk) {
        if (record.previous === undefined || previousOk) return record;
        const { previous: _dropped, ...rest } = record;
        await writeActive(rest);
        return rest;
      }
      const recovered: ActiveRecord = previousOk ? { current: record.previous } : {};
      await writeActive(recovered);
      return recovered;
    },
    prune: async (keep) => {
      for (const name of await readdir(versionsDir).catch(() => [] as Array<string>)) {
        if (keep.has(name)) continue;
        // Best effort: on Windows a version some orphaned process still runs from stays locked,
        // and the next prune gets it.
        await rm(versionDir(name), { recursive: true, force: true, maxRetries: 3 }).catch(
          () => undefined,
        );
      }
    },
  };
};
