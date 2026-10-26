// Downloads one pinned speech model into `<root>/staging/<id>/`, checks every file's size and
// sha256, and only then renames the directory to `<root>/models/<id>/`, so a directory there is
// always a complete, verified model. Partial files resume with a `Range` request after the bytes
// already on disk are hashed again; a host that ignores the range and answers 200 restarts the file.

import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  SPEECH_MODEL_VERIFIED_FILE,
  type SpeechInstallFailure,
  type SpeechModelFile,
  type SpeechModelManifest,
  type SpeechVerifiedModel,
} from "@gram/contracts";

/**
 * One HTTP request, never following a redirect: a 3xx comes back as it is, with its `location`, so
 * the store checks each hop's host before anything is sent there. Electron's `net` under the desktop
 * shell, Node's `fetch` elsewhere.
 */
export type SpeechFetch = (
  url: string,
  init: { readonly headers: Record<string, string>; readonly signal: AbortSignal },
) => Promise<Response>;

/** Free bytes at `path`, or `undefined` when the disk couldn't be asked. */
export type FreeBytes = (path: string) => Promise<number | undefined>;

export const freeBytesAt: FreeBytes = async (path) => {
  try {
    const stats = await statfs(path);
    return stats.bavail * stats.bsize;
  } catch {
    // No answer is no disk check: the write itself still fails with ENOSPC.
    return undefined;
  }
};

const gb = (bytes: number) => (bytes / 1e9).toFixed(1);

/** Kept free beyond the model itself, so a download never fills the disk to the last byte. */
const DISK_HEADROOM_BYTES = 256 * 1024 * 1024;

export interface DownloadOptions {
  readonly manifest: SpeechModelManifest;
  /** `<dataDir>/speech`. */
  readonly root: string;
  /** `https://huggingface.co`, or a mirror serving the Hub's `resolve` paths. */
  readonly base: string;
  readonly fetch: SpeechFetch;
  readonly signal: AbortSignal;
  readonly freeBytes?: FreeBytes | undefined;
  readonly now?: (() => number) | undefined;
  /** Opens a partial file; tests make its writes fail as a full disk would. */
  readonly open?: typeof open | undefined;
  /** Moves the verified model into place; tests make it fail as a cross-device move would. */
  readonly rename?: typeof rename | undefined;
  /** Bytes on disk of the model's total, as they arrive. */
  readonly onProgress: (receivedBytes: number, totalBytes: number) => void;
  /** Every file is in; they are being hashed again before the move. */
  readonly onVerifying: () => void;
}

export type DownloadOutcome =
  | { readonly ok: true; readonly verified: SpeechVerifiedModel }
  | {
      readonly ok: false;
      /** `undefined` when the download was cancelled. */
      readonly reason: SpeechInstallFailure | undefined;
      readonly message: string;
      /** Bytes on disk the next install resumes from. */
      readonly resumableBytes: number;
    };

class Failed extends Error {
  readonly reason: SpeechInstallFailure;
  constructor(reason: SpeechInstallFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

export const stagingDir = (root: string, id: string) => join(root, "staging", id);
export const modelDir = (root: string, id: string) => join(root, "models", id);
const partialOf = (path: string) => `${path}.partial`;

/**
 * `base` without trailing slashes. A loop, not `/\/+$/`, which backtracks quadratically on a long
 * run of slashes that isn't at the end (CodeQL js/polynomial-redos).
 */
const withoutTrailingSlashes = (base: string): string => {
  let end = base.length;
  while (end > 0 && base[end - 1] === "/") end--;
  return base.slice(0, end);
};

/** `{base}/{repo}/resolve/{revision}/{path}`, the Hub's own path, which mirrors also serve. */
export const fileUrl = (base: string, manifest: SpeechModelManifest, file: SpeechModelFile) =>
  `${withoutTrailingSlashes(base)}/${manifest.repo}/resolve/${manifest.revision}/${file.path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

/**
 * Whether a download may end up at `url` after redirects: the configured base's host, or Hugging
 * Face and the CDN it redirects to (`*.hf.co`, Xet's `*.xethub.hf.co`).
 */
const allowedHost = (base: string, url: string): boolean => {
  let host: string;
  let protocol: string;
  try {
    ({ host, protocol } = new URL(url));
  } catch {
    return false;
  }
  if (protocol !== "https:") return false;
  if (host === new URL(base).host) return true;
  return host === "huggingface.co" || host === "hf.co" || host.endsWith(".hf.co");
};

const sizeOf = async (path: string): Promise<number | undefined> => {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
};

const hashFile = async (path: string, hash: Hash = createHash("sha256")): Promise<Hash> => {
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash;
};

const errorCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
};

const FS_FULL = new Set(["ENOSPC", "EDQUOT"]);

const proxyHelp = (base: string) =>
  `Ask for ${new URL(base).host === "huggingface.co" ? "huggingface.co and *.hf.co" : new URL(base).host} to be allowed through the proxy, or set GRAM_HF_BASE to a mirror you can reach.`;

/** A fetch that threw: cut off, unreachable, or refused by a proxy or TLS inspection. */
const networkFailure = (error: unknown, base: string): Failed => {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const text = [String(error), String(cause ?? ""), errorCode(cause) ?? ""].join(" ");
  if (/PROXY|TUNNEL_CONNECTION|ERR_CERT|SSL|certificate/i.test(text))
    return new Failed("proxy", `A proxy or the firewall stopped the download. ${proxyHelp(base)}`);
  if (/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(text))
    return new Failed(
      "network",
      `Couldn't look up ${new URL(base).host}. Check the network, then try again.`,
    );
  return new Failed("network", "The download was cut off. Try again to resume where it stopped.");
};

const httpFailure = (status: number, base: string): Failed => {
  if (status === 407)
    return new Failed("proxy", `The proxy asked for credentials (HTTP 407). ${proxyHelp(base)}`);
  if ((status === 401 || status === 403) && new URL(base).host !== "huggingface.co")
    return new Failed(
      "http",
      `${new URL(base).host} refused the download (HTTP ${status}). A npm registry Hugging Face remote needs a token and the model's repo on its allowlist.`,
    );
  return new Failed("http", `The model host answered HTTP ${status}. Try again later.`);
};

/** Bytes on disk toward the model, finished and partial files alike. */
export const bytesOnDisk = async (root: string, manifest: SpeechModelManifest): Promise<number> => {
  const staging = stagingDir(root, manifest.id);
  let total = 0;
  for (const file of manifest.files) {
    const path = join(staging, file.path);
    total += Math.min(file.size, (await sizeOf(path)) ?? (await sizeOf(partialOf(path))) ?? 0);
  }
  return total;
};

const REVISION_FILE = ".revision";

/** Clears staging left by another revision of the model, whose partial bytes would never verify. */
const prepareStaging = async (staging: string, revision: string) => {
  const stamp = join(staging, REVISION_FILE);
  const previous = await readFile(stamp, "utf8").catch(() => undefined);
  if (previous !== undefined && previous !== revision) await rm(staging, { recursive: true });
  await mkdir(staging, { recursive: true });
  if (previous !== revision) await writeFile(stamp, revision);
};

/** Hugging Face redirects once, to its CDN; a mirror may add one. More is a loop. */
const MAX_REDIRECTS = 5;

/**
 * `url`, following redirects by hand: each hop's host is checked before it is asked for anything,
 * and every hop that names the repo's revision must name the pinned one.
 */
const fetchFollowing = async (
  options: DownloadOptions,
  url: string,
  headers: Record<string, string>,
): Promise<Response> => {
  const { base, manifest, signal } = options;
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowedHost(base, target))
      throw new Failed(
        "http",
        `The download was redirected to ${hostOf(target)}, which isn't a model host.`,
      );
    let response: Response;
    try {
      response = await options.fetch(target, { headers, signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw networkFailure(error, base);
    }
    const commit = response.headers.get("x-repo-commit");
    if (commit !== null && commit !== manifest.revision)
      throw new Failed(
        "verification",
        `The host served revision ${commit.slice(0, 12)} instead of the pinned one.`,
      );
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) return response;
    await response.body?.cancel().catch(() => undefined);
    target = new URL(location, target).toString();
  }
  throw new Failed("http", "The model host redirected too many times.");
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "an address that isn't a URL";
  }
};

/** Fetches one file into `<path>.partial`, resuming it, and renames it to `path` once it hashes. */
const fetchFile = async (
  options: DownloadOptions,
  file: SpeechModelFile,
  path: string,
  progress: (delta: number) => void,
) => {
  const { manifest, base, signal } = options;
  const partial = partialOf(path);
  await mkdir(dirname(path), { recursive: true });
  let offset = (await sizeOf(partial)) ?? 0;
  if (offset > file.size) {
    progress(-offset);
    await rm(partial);
    offset = 0;
  }
  // The bytes already on disk are hashed again rather than trusted from an earlier run.
  let hash = offset > 0 ? await hashFile(partial) : createHash("sha256");

  if (offset < file.size) {
    const response = await fetchFollowing(
      options,
      fileUrl(base, manifest, file),
      offset > 0 ? { Range: `bytes=${offset}-` } : {},
    );
    if (response.status === 200 && offset > 0) {
      // The host ignored the range: start the file again.
      progress(-offset);
      offset = 0;
      hash = createHash("sha256");
    } else if (response.status === 206) {
      const start = /^bytes (\d+)-/.exec(response.headers.get("content-range") ?? "")?.[1];
      if (Number(start) !== offset)
        throw new Failed("http", "The model host answered a different range than was asked for.");
    } else if (response.status !== 200) {
      throw httpFailure(response.status, base);
    }
    if (response.body === null) throw new Failed("http", "The model host sent no body.");

    const handle = await (options.open ?? open)(partial, offset === 0 ? "w" : "a");
    try {
      for await (const chunk of response.body) {
        if (offset + chunk.byteLength > file.size) {
          await handle.close().catch(() => undefined);
          await rm(partial, { force: true });
          progress(-offset);
          throw new Failed("verification", `${file.path} is larger than the pinned size.`);
        }
        await handle.write(chunk);
        hash.update(chunk);
        offset += chunk.byteLength;
        progress(chunk.byteLength);
      }
    } catch (error) {
      if (error instanceof Failed || signal.aborted) throw error;
      if (FS_FULL.has(errorCode(error) ?? ""))
        throw new Failed("disk-space", "The disk filled up. Free some space, then try again.");
      if (errorCode(error) !== undefined)
        throw new Failed("filesystem", `Couldn't write the model: ${String(error)}`);
      throw networkFailure(error, base);
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (offset < file.size)
      throw new Failed(
        "network",
        "The connection closed before the file was complete. Try again to resume.",
      );
  }

  if (hash.digest("hex") !== file.sha256) {
    await rm(partial, { force: true });
    progress(-offset);
    throw new Failed("verification", `${file.path} doesn't match its pinned sha256.`);
  }
  await rename(partial, path);
};

/**
 * Downloads and installs `manifest`'s model, resuming whatever an earlier run left in staging.
 * Never rejects: a failure, or `signal` aborting, comes back as `ok: false` with the bytes kept.
 */
export const downloadModel = async (options: DownloadOptions): Promise<DownloadOutcome> => {
  const { manifest, root, signal } = options;
  const staging = stagingDir(root, manifest.id);
  const total = manifest.files.reduce((sum, file) => sum + file.size, 0);
  const failed = async (reason: SpeechInstallFailure | undefined, message: string) => ({
    ok: false as const,
    reason,
    message,
    resumableBytes: await bytesOnDisk(root, manifest).catch(() => 0),
  });

  try {
    await prepareStaging(staging, manifest.revision);
    let received = await bytesOnDisk(root, manifest);
    const free = await (options.freeBytes ?? freeBytesAt)(root);
    const needed = total - received;
    if (free !== undefined && free < needed + DISK_HEADROOM_BYTES) {
      return await failed(
        "disk-space",
        `The model needs ${gb(needed)} GB more and the disk has ${gb(free)} GB free. Free some space, then try again.`,
      );
    }
    options.onProgress(received, total);
    const progress = (delta: number) => {
      received += delta;
      options.onProgress(received, total);
    };

    for (const file of manifest.files) {
      if (signal.aborted) return await failed(undefined, "Cancelled.");
      const path = join(staging, file.path);
      if ((await sizeOf(path)) === file.size) continue;
      await rm(path, { force: true });
      await fetchFile(options, file, path, progress);
    }

    options.onVerifying();
    for (const file of manifest.files) {
      // Cancelled while hashing: the files stay staged and the next install checks them again.
      if (signal.aborted) return await failed(undefined, "Cancelled.");
      const path = join(staging, file.path);
      if (
        (await sizeOf(path)) !== file.size ||
        (await hashFile(path)).digest("hex") !== file.sha256
      ) {
        await rm(path, { force: true });
        return await failed("verification", `${file.path} doesn't match its pinned sha256.`);
      }
    }

    if (signal.aborted) return await failed(undefined, "Cancelled.");
    const verified: SpeechVerifiedModel = { ...manifest, verifiedAt: (options.now ?? Date.now)() };
    await rm(join(staging, REVISION_FILE), { force: true });
    await writeFile(
      join(staging, "NOTICE"),
      `${manifest.name}\n${manifest.license.attribution}.\n${manifest.license.url}\n\nSource: https://huggingface.co/${manifest.source.repo} at ${manifest.source.revision}\n`,
    );
    // Written last: the speech process treats a directory with it as complete.
    await writeFile(join(staging, SPEECH_MODEL_VERIFIED_FILE), JSON.stringify(verified, null, 2));
    await install(root, manifest.id, options.rename ?? rename);
    return { ok: true, verified };
  } catch (error) {
    if (signal.aborted) return await failed(undefined, "Cancelled.");
    if (error instanceof Failed) return await failed(error.reason, error.message);
    if (FS_FULL.has(errorCode(error) ?? ""))
      return await failed("disk-space", "The disk filled up. Free some space, then try again.");
    return await failed("filesystem", `Couldn't write the model: ${String(error)}`);
  }
};

const replacedDir = (root: string, id: string) => join(root, "staging", `${id}.replaced`);

/**
 * Puts back an installed model that a replacement moved aside and then didn't finish replacing,
 * say because the app quit between the two renames. Only under the model's reservation, or before
 * the store serves anything: it renames into `models/<id>`.
 */
export const recoverReplaced = async (root: string, id: string) => {
  const old = replacedDir(root, id);
  if ((await sizeOf(old)) === undefined) return;
  if ((await sizeOf(modelDir(root, id))) === undefined) await rename(old, modelDir(root, id));
  else await rm(old, { recursive: true, force: true });
};

/**
 * Moves verified staging into place. An older copy is moved aside first and put back if the move
 * fails, so a failed update leaves what was installed in place.
 */
const install = async (root: string, id: string, move: typeof rename) => {
  const target = modelDir(root, id);
  await mkdir(dirname(target), { recursive: true });
  await recoverReplaced(root, id);
  const old = replacedDir(root, id);
  const hadOld = (await sizeOf(target)) !== undefined;
  if (hadOld) await rename(target, old);
  try {
    await move(stagingDir(root, id), target);
  } catch (error) {
    if (hadOld) await rename(old, target);
    throw error;
  }
  if (hadOld) await rm(old, { recursive: true, force: true });
};

/**
 * The installed copy of `manifest`, read from its `verified.json` and checked by size alone:
 * every byte was hashed when it was installed, and 660 MB isn't hashed again on each status.
 */
export const readInstalled = async (
  root: string,
  manifest: SpeechModelManifest,
): Promise<{ readonly sizeBytes: number; readonly installedAt: number } | undefined> => {
  const dir = modelDir(root, manifest.id);
  let verified: { revision?: unknown; verifiedAt?: unknown };
  try {
    verified = JSON.parse(await readFile(join(dir, SPEECH_MODEL_VERIFIED_FILE), "utf8")) as {
      revision?: unknown;
      verifiedAt?: unknown;
    };
  } catch {
    return undefined;
  }
  if (verified.revision !== manifest.revision || typeof verified.verifiedAt !== "number")
    return undefined;
  let sizeBytes = 0;
  for (const file of manifest.files) {
    if ((await sizeOf(join(dir, file.path))) !== file.size) return undefined;
    sizeBytes += file.size;
  }
  return { sizeBytes, installedAt: verified.verifiedAt };
};

/** Deletes the installed model and anything staged for it. */
export const removeModel = async (root: string, id: string) => {
  await rm(modelDir(root, id), { recursive: true, force: true });
  await rm(stagingDir(root, id), { recursive: true, force: true });
  await rm(replacedDir(root, id), { recursive: true, force: true });
};
