import {
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  closeSync,
  rmSync,
  type Stats,
} from "node:fs";
import * as nodePath from "node:path";

import {
  VERIFY_EVIDENCE_MANIFEST,
  VERIFY_EVIDENCE_MAX_BYTES,
  VERIFY_EVIDENCE_MAX_ITEMS,
  type FileImage,
  type VerifyEvidence,
  type VerifyEvidenceKind,
} from "@gram/contracts";

const MANIFEST_MAX_BYTES = 64 * 1024;
const CAPTION_MAX = 200;

/** The evidence folder of the run whose output is `log`. */
export const evidenceDirOf = (log: string) => `${log}.evidence`;

/**
 * The folder for a run about to start, emptied of an earlier run's files under the same log;
 * `undefined` when it can't be made.
 */
export const freshEvidenceDir = (log: string): string | undefined => {
  const dir = evidenceDirOf(log);
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch {
    return undefined;
  }
};

const lstat = (path: string): Stats | undefined => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};

const names = (dir: string): readonly string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const bytesUnder = (path: string, depth = 0): number => {
  const stat = lstat(path);
  if (stat === undefined) return 0;
  if (!stat.isDirectory()) return stat.size;
  if (depth > 8) return 0;
  return names(path).reduce(
    (sum, name) => sum + bytesUnder(nodePath.join(path, name), depth + 1),
    0,
  );
};

/** The bytes the evidence of `log`'s run takes. */
export const evidenceBytes = (log: string) => bytesUnder(evidenceDirOf(log));

/** Removes the evidence of `log`'s run, returning the bytes it took. */
export const removeEvidence = (log: string): number => {
  const dir = evidenceDirOf(log);
  const bytes = bytesUnder(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (_goneAlreadyOrTheNextSweepTriesAgain) {}
  return bytes;
};

const MEDIA: Record<string, { kind: VerifyEvidenceKind; mediaType?: string }> = {
  ".png": { kind: "screenshot", mediaType: "image/png" },
  ".jpg": { kind: "screenshot", mediaType: "image/jpeg" },
  ".jpeg": { kind: "screenshot", mediaType: "image/jpeg" },
  ".gif": { kind: "screenshot", mediaType: "image/gif" },
  ".webp": { kind: "screenshot", mediaType: "image/webp" },
  ".svg": { kind: "screenshot", mediaType: "image/svg+xml" },
  ".webm": { kind: "video" },
  ".mp4": { kind: "video" },
};

const mediaOf = (file: string) => MEDIA[nodePath.extname(file).toLowerCase()];

const plainName = (file: string) =>
  file !== "" &&
  file.length <= 255 &&
  file !== VERIFY_EVIDENCE_MANIFEST &&
  !file.startsWith(".") &&
  !/[/\\\0]/.test(file);

const regularFile = (dir: string, file: string): Stats | undefined => {
  if (!plainName(file)) return undefined;
  const stat = lstat(nodePath.join(dir, file));
  return stat?.isFile() === true ? stat : undefined;
};

const readBounded = (path: string, max: number): Buffer | undefined => {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(max + 1);
    const read = readSync(fd, buffer, 0, max + 1, 0);
    return read > max ? undefined : buffer.subarray(0, read);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

const KINDS: ReadonlySet<string> = new Set(["screenshot", "video", "snapshot", "log"]);

const manifestItems = (dir: string) => {
  if (lstat(nodePath.join(dir, VERIFY_EVIDENCE_MANIFEST))?.isFile() !== true) return undefined;
  const bytes = readBounded(nodePath.join(dir, VERIFY_EVIDENCE_MANIFEST), MANIFEST_MAX_BYTES);
  if (bytes === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  const items = (parsed as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return undefined;
  return items.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const { file, caption, kind } = item as Record<string, unknown>;
    if (typeof file !== "string") return [];
    return [
      {
        file,
        caption: typeof caption === "string" ? caption.trim().slice(0, CAPTION_MAX) : undefined,
        kind:
          typeof kind === "string" && KINDS.has(kind) ? (kind as VerifyEvidenceKind) : undefined,
      },
    ];
  });
};

/**
 * What `log`'s run left to show: the manifest's items in its order, or without one the folder's
 * images and videos by name. Only regular files directly in the folder count, at most
 * `VERIFY_EVIDENCE_MAX_ITEMS` of them; a name listed twice shows once.
 */
export const listEvidence = (log: string): readonly VerifyEvidence[] => {
  const dir = evidenceDirOf(log);
  if (lstat(dir)?.isDirectory() !== true) return [];
  const listed =
    manifestItems(dir) ??
    names(dir)
      .filter((file) => mediaOf(file) !== undefined)
      .toSorted()
      .map((file) => ({ file, caption: undefined, kind: undefined }));
  const seen = new Set<string>();
  const out: VerifyEvidence[] = [];
  for (const item of listed) {
    if (out.length >= VERIFY_EVIDENCE_MAX_ITEMS) break;
    if (seen.has(item.file)) continue;
    const stat = regularFile(dir, item.file);
    if (stat === undefined) continue;
    seen.add(item.file);
    const kind = item.kind ?? mediaOf(item.file)?.kind ?? "snapshot";
    out.push({
      file: item.file,
      kind,
      ...(item.caption === undefined || item.caption === "" ? {} : { caption: item.caption }),
      size: stat.size,
    });
  }
  return out;
};

/**
 * One picture `log`'s run listed, as `fs.image` serves one; `undefined` for a name it didn't list
 * or a file that isn't a picture. Larger than `VERIFY_EVIDENCE_MAX_BYTES` comes without its bytes.
 */
export const evidenceImage = (log: string, file: string): FileImage | undefined => {
  const mediaType = mediaOf(file)?.mediaType;
  if (mediaType === undefined) return undefined;
  if (!listEvidence(log).some((item) => item.file === file)) return undefined;
  const path = nodePath.join(evidenceDirOf(log), file);
  const stat = regularFile(evidenceDirOf(log), file);
  if (stat === undefined) return undefined;
  if (stat.size > VERIFY_EVIDENCE_MAX_BYTES)
    return { path: file, mediaType, size: stat.size, tooLarge: true };
  const bytes = readBounded(path, VERIFY_EVIDENCE_MAX_BYTES);
  if (bytes === undefined) return { path: file, mediaType, size: stat.size, tooLarge: true };
  return {
    path: file,
    mediaType,
    size: bytes.length,
    tooLarge: false,
    base64: bytes.toString("base64"),
  };
};
