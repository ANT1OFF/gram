/**
 * The only unpacker for downloaded agent runtimes: a streaming `.tar.gz` reader that writes regular
 * files and directories under one destination and refuses everything else. It exists so that what a
 * vendor archive may contain is decided here, by one reviewed list, rather than by whichever `tar`
 * the machine has (bsdtar on macOS and Windows 10+, GNU tar elsewhere, each with its own defaults
 * for links, absolute paths and `..`). Run it only on bytes whose digest has been checked.
 */
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createGunzip } from "node:zlib";

export interface TarEntry {
  /** Archive path, `/`-separated, without a trailing slash. */
  readonly path: string;
  readonly type: "file" | "directory";
  readonly size: number;
  /** Permission bits, masked to `0o755` for files that were executable and `0o644` otherwise. */
  readonly mode: number;
}

export interface TarLimits {
  readonly maxEntries: number;
  /** Total unpacked bytes; a gzip bomb stops here instead of filling the disk. */
  readonly maxBytes: number;
}

export class UnsafeArchive extends Error {
  override readonly name = "UnsafeArchive";
}

const BLOCK = 512;

/** Rejects absolute paths, `..`, drive letters, alternate data streams and backslashes. */
export const safeArchivePath = (raw: string): string => {
  const trimmed = raw.replace(/\/+$/, "").replace(/^\.\//, "");
  if (trimmed === "" || trimmed === ".") throw new UnsafeArchive(`empty entry name`);
  if (trimmed.startsWith("/")) throw new UnsafeArchive(`absolute path: ${raw}`);
  if (/[\\:\0]/.test(trimmed)) throw new UnsafeArchive(`unsafe characters: ${raw}`);
  for (const segment of trimmed.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new UnsafeArchive(`unsafe path segment: ${raw}`);
    }
    // Windows strips trailing dots and spaces, so `bin. ` and `bin` would collide there.
    if (/[. ]$/.test(segment)) throw new UnsafeArchive(`trailing dot or space: ${raw}`);
  }
  return trimmed;
};

const readString = (block: Buffer, offset: number, length: number): string => {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString("utf8");
};

const readNumber = (block: Buffer, offset: number, length: number): number => {
  const field = block.subarray(offset, offset + length);
  // GNU base-256 for values that don't fit in octal; only positive ones are meaningful here.
  if ((field[0]! & 0x80) !== 0) {
    let value = field[0]! & 0x7f;
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i]!;
    return value;
  }
  const text = readString(block, offset, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new UnsafeArchive(`bad numeric field: ${text}`);
  return Number.parseInt(text, 8);
};

const checksumOk = (block: Buffer): boolean => {
  const stored = readNumber(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  return sum === stored;
};

/** PAX records, `"<len> <key>=<value>\n"` repeated. */
const parsePax = (data: Buffer): Map<string, string> => {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > data.length) {
      throw new UnsafeArchive("malformed pax header");
    }
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
};

const padded = (size: number) => Math.ceil(size / BLOCK) * BLOCK;

/** What to do with the bytes of the entry being read. */
type Sink =
  | { readonly kind: "header" }
  | { readonly kind: "meta"; readonly type: "pax" | "longname"; readonly size: number }
  | { readonly kind: "file"; readonly out: WriteStream; readonly size: number }
  | { readonly kind: "skip"; readonly size: number };

const write = (out: WriteStream, chunk: Buffer): Promise<void> =>
  new Promise((resolve, reject) => {
    out.write(chunk, (error) => (error ? reject(error) : resolve()));
  });

const close = (out: WriteStream): Promise<void> =>
  new Promise((resolve, reject) => {
    out.once("error", reject);
    out.end(() => resolve());
  });

/**
 * Unpacks `archive` into `dest`, which must exist and be empty, and returns what it wrote.
 * Throws `UnsafeArchive` for a link, device, FIFO, unsafe path, duplicate file, bad checksum or an
 * archive over `limits`; `dest` is then left part-written for the caller to delete. Aborting
 * `signal` stops it the same way.
 */
export const extractTarGz = async (
  archive: string,
  dest: string,
  limits: TarLimits,
  signal?: AbortSignal,
): Promise<ReadonlyArray<TarEntry>> => {
  const entries: Array<TarEntry> = [];
  const seen = new Set<string>();
  let total = 0;
  let pending: Buffer = Buffer.alloc(0);
  let sink: Sink = { kind: "header" };
  // `sink` changes inside the callbacks below, which TypeScript's narrowing can't see.
  const sinkNow = (): Sink => sink;
  /** Bytes still to consume for the current non-header sink, padding included. */
  let remaining = 0;
  let meta: Array<Buffer> = [];
  let paxPath: string | undefined;
  let paxSize: number | undefined;
  let longName: string | undefined;
  /** Set by `startEntry` at the end-of-archive blocks; an object, as the loops read it after awaits. */
  const end = { reached: false };
  let zeroBlocks = 0;

  const startEntry = async (header: Buffer): Promise<void> => {
    if (header.every((byte) => byte === 0)) {
      zeroBlocks++;
      if (zeroBlocks >= 2) end.reached = true;
      return;
    }
    zeroBlocks = 0;
    if (!checksumOk(header)) throw new UnsafeArchive("header checksum mismatch");
    const typeflag = String.fromCharCode(header[156]!);
    const headerSize = readNumber(header, 124, 12);
    if (typeflag === "x" || typeflag === "L") {
      if (headerSize > 1024 * 1024) throw new UnsafeArchive("oversized metadata header");
      sink = { kind: "meta", type: typeflag === "x" ? "pax" : "longname", size: headerSize };
      remaining = padded(headerSize);
      meta = [];
      return;
    }
    if (typeflag === "g") {
      // Global PAX defaults (comments, mtimes): nothing here that changes where a file goes.
      sink = { kind: "skip", size: headerSize };
      remaining = padded(headerSize);
      return;
    }
    const magic = readString(header, 257, 6);
    const prefix = magic.startsWith("ustar") ? readString(header, 345, 155) : "";
    const name = readString(header, 0, 100);
    const rawPath = paxPath ?? longName ?? (prefix === "" ? name : `${prefix}/${name}`);
    const size = paxSize ?? headerSize;
    paxPath = undefined;
    paxSize = undefined;
    longName = undefined;
    const path = safeArchivePath(rawPath);
    const mode = readNumber(header, 100, 8);
    if (entries.length >= limits.maxEntries) throw new UnsafeArchive("too many entries");
    if (typeflag === "5") {
      if (seen.has(path)) throw new UnsafeArchive(`duplicate entry: ${path}`);
      seen.add(path);
      await mkdir(join(dest, path), { recursive: true });
      entries.push({ path, type: "directory", size: 0, mode: 0o755 });
      sink = { kind: "skip", size };
      remaining = padded(size);
      return;
    }
    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "7") {
      throw new UnsafeArchive(`unsupported entry type '${typeflag}': ${path}`);
    }
    if (seen.has(path)) throw new UnsafeArchive(`duplicate entry: ${path}`);
    seen.add(path);
    total += size;
    if (total > limits.maxBytes) throw new UnsafeArchive("archive unpacks too large");
    const fileMode = (mode & 0o111) !== 0 ? 0o755 : 0o644;
    const target = join(dest, path);
    await mkdir(join(target, ".."), { recursive: true });
    // `wx`: never follow or replace something already there.
    const out = createWriteStream(target, { flags: "wx", mode: fileMode });
    await new Promise<void>((resolve, reject) => {
      out.once("open", () => resolve());
      out.once("error", reject);
    });
    entries.push({ path, type: "file", size, mode: fileMode });
    sink = { kind: "file", out, size };
    remaining = padded(size);
    if (size === 0) {
      await close(out);
      sink = { kind: "header" };
    }
  };

  /** Consumes the current sink's bytes from `chunk`, returning what is left over. */
  const feedSink = async (chunk: Buffer): Promise<Buffer> => {
    if (sink.kind === "header") return chunk;
    const take = Math.min(remaining, chunk.length);
    const consumed = padded(sink.size) - remaining;
    const dataLeft = Math.max(0, sink.size - consumed);
    const data = chunk.subarray(0, Math.min(take, dataLeft));
    if (sink.kind === "file" && data.length > 0) await write(sink.out, data);
    if (sink.kind === "meta" && data.length > 0) meta.push(Buffer.from(data));
    remaining -= take;
    if (remaining === 0) {
      if (sink.kind === "file") await close(sink.out);
      if (sink.kind === "meta") {
        const body = Buffer.concat(meta);
        if (sink.type === "pax") {
          const records = parsePax(body);
          paxPath = records.get("path") ?? paxPath;
          const sizeRecord = records.get("size");
          if (sizeRecord !== undefined) {
            if (!/^\d+$/.test(sizeRecord)) throw new UnsafeArchive("bad pax size");
            paxSize = Number(sizeRecord);
          }
        } else {
          longName = readString(body, 0, body.length);
        }
      }
      sink = { kind: "header" };
    }
    return chunk.subarray(take);
  };

  const source = createReadStream(archive);
  const input = source.pipe(createGunzip());
  // `pipe` forwards bytes, not errors: a read failure has to reach the stream being iterated, or
  // it would be an unhandled error that takes the server down.
  source.once("error", (error) => input.destroy(error));
  const abort = () => input.destroy(new UnsafeArchive("cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) abort();
    for await (const raw of input as AsyncIterable<Buffer>) {
      let chunk: Buffer = raw;
      while (chunk.length > 0 && !end.reached) {
        if (sink.kind !== "header") {
          chunk = await feedSink(chunk);
          continue;
        }
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        chunk = Buffer.alloc(0);
        while (pending.length >= BLOCK && sinkNow().kind === "header" && !end.reached) {
          const header = pending.subarray(0, BLOCK);
          pending = pending.subarray(BLOCK);
          await startEntry(header);
        }
        if (sinkNow().kind !== "header") {
          chunk = pending;
          pending = Buffer.alloc(0);
        }
      }
      if (end.reached) break;
    }
  } catch (error) {
    const open = sinkNow();
    if (open.kind === "file") open.out.destroy();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    input.destroy();
    source.destroy();
  }
  if (sinkNow().kind !== "header") throw new UnsafeArchive("archive ends inside an entry");
  if (!end.reached && zeroBlocks === 0 && entries.length === 0)
    throw new UnsafeArchive("empty archive");
  return entries;
};
