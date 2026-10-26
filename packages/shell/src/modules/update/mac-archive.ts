import { macFs, macFsPromises } from "./mac-fs.ts";
// Narrow ZIP reader for private arm64 releases. Never pass an uninspected archive to a system
// extractor: symlinks are created last and no archive path can write through one.

import { dirname, join, posix } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

export const MAX_ARCHIVE_BYTES = 600 * 1024 ** 2;
export const MAX_BUNDLE_BYTES = 1536 * 1024 ** 2;
export const MAX_ENTRIES = 20_000;

export function safeRelative(path: string): boolean {
  return (
    path.length > 0 &&
    path.length < 2048 &&
    !/[\\:]/.test(path) &&
    ![...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    !path.startsWith("/") &&
    path.split("/").every((p) => p !== "" && p !== "." && p !== "..")
  );
}

export function safeLink(path: string, target: string): boolean {
  if (
    !target ||
    target.length > 2048 ||
    /[\\:]/.test(target) ||
    [...target].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    target.startsWith("/")
  )
    return false;
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  return resolved !== ".." && !resolved.startsWith("../") && !resolved.startsWith("/");
}

interface Entry {
  name: string;
  mode: number;
  type: number;
  size: number;
  packed: number;
  offset: number;
  method: number;
  flags: number;
}

export async function extractMacArchive(archive: string, destination: string): Promise<string> {
  const handle = await open(archive, "r");
  const read = async (offset: number, length: number): Promise<Buffer> => {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) throw new Error("Truncated update ZIP");
    return buffer;
  };
  try {
    const total = (await handle.stat()).size;
    if (total < 22 || total > MAX_ARCHIVE_BYTES) throw new Error("Update ZIP exceeds size bounds");
    const tail = await read(Math.max(0, total - 65557), Math.min(total, 65557));
    let end = tail.length - 22;
    while (end >= 0 && tail.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0 || end + 22 + tail.readUInt16LE(end + 20) !== tail.length)
      throw new Error("Invalid ZIP end record");
    const count = tail.readUInt16LE(end + 10);
    const length = tail.readUInt32LE(end + 12);
    const start = tail.readUInt32LE(end + 16);
    if (
      tail.readUInt32LE(end + 4) !== 0 ||
      tail.readUInt16LE(end + 8) !== count ||
      count > MAX_ENTRIES ||
      length > 16 * 1024 ** 2 ||
      start + length !== total - tail.length + end
    )
      throw new Error("Unsupported multipart/ZIP64 update ZIP");
    const central = await read(start, length);
    const entries: Entry[] = [];
    const names = new Set<string>();
    let expanded = 0;
    let cursor = 0;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > length || central.readUInt32LE(cursor) !== 0x02014b50)
        throw new Error("Invalid ZIP directory");
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const next = cursor + 46 + nameLength + extraLength + commentLength;
      if (next > length) throw new Error("Truncated ZIP directory");
      const raw = central.subarray(cursor + 46, cursor + 46 + nameLength);
      const name = raw.toString("utf8");
      if (!Buffer.from(name).equals(raw)) throw new Error("Invalid ZIP filename encoding");
      const path = name.endsWith("/") ? name.slice(0, -1) : name;
      const folded = path.normalize("NFD").toLowerCase();
      const mode = central.readUInt32LE(cursor + 38) >>> 16;
      const type = mode & 0o170000;
      const size = central.readUInt32LE(cursor + 24);
      const packed = central.readUInt32LE(cursor + 20);
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      if (
        !safeRelative(path) ||
        names.has(folded) ||
        (mode & 0o7000) !== 0 ||
        ![0, 0o040000, 0o100000, 0o120000].includes(type) ||
        (flags & ~0x0808) !== 0 ||
        ![0, 8].includes(method) ||
        central.readUInt16LE(cursor + 34) !== 0 ||
        (name.endsWith("/") && (size !== 0 || ![0, 0o040000].includes(type))) ||
        (type === 0o040000 && !name.endsWith("/")) ||
        size > MAX_ARCHIVE_BYTES ||
        packed > MAX_ARCHIVE_BYTES
      )
        throw new Error("Unsafe or unsupported update ZIP entry");
      // ditto's resource-fork records are ignored, never extracted or executed.
      if (
        !(
          path === "Gram.app" ||
          path.startsWith("Gram.app/") ||
          path === "__MACOSX" ||
          path.startsWith("__MACOSX/")
        )
      )
        throw new Error("Unexpected bundle in update ZIP");
      names.add(folded);
      expanded += size;
      if (expanded > MAX_BUNDLE_BYTES) throw new Error("Update ZIP extraction exceeds size bounds");
      entries.push({
        name,
        mode,
        type,
        size,
        packed,
        offset: central.readUInt32LE(cursor + 42),
        method,
        flags,
      });
      cursor = next;
    }
    if (cursor !== length) throw new Error("Extra ZIP directory data");
    const byPath = new Map(entries.map((e) => [e.name.replace(/\/$/, ""), e]));
    const ranges: [number, number][] = [];
    for (const entry of entries) {
      let parent = posix.dirname(entry.name.replace(/\/$/, ""));
      while (parent !== ".") {
        const ancestor = byPath.get(parent);
        if (ancestor && !ancestor.name.endsWith("/"))
          throw new Error("ZIP entry beneath a file or symlink");
        parent = posix.dirname(parent);
      }
      if (entry.offset + 30 > start) throw new Error("Invalid ZIP local offset");
      const local = await read(entry.offset, 30);
      const n = local.readUInt16LE(26),
        x = local.readUInt16LE(28);
      if (
        local.readUInt32LE(0) !== 0x04034b50 ||
        local.readUInt16LE(6) !== entry.flags ||
        local.readUInt16LE(8) !== entry.method ||
        (await read(entry.offset + 30, n)).toString("utf8") !== entry.name
      )
        throw new Error("ZIP local header disagrees with directory");
      const dataOffset = entry.offset + 30 + n + x;
      if (dataOffset + entry.packed > start) throw new Error("ZIP entry runs past its data bounds");
      ranges.push([entry.offset, dataOffset + entry.packed]);
      entry.offset = dataOffset;
    }
    ranges.sort((a, b) => a[0] - b[0]);
    if (ranges.some((r, i) => i > 0 && r[0] < ranges[i - 1]![1]))
      throw new Error("Overlapping ZIP entries");
    await mkdir(destination, { mode: 0o700 });
    const links: { path: string; target: string }[] = [];
    for (const entry of entries) {
      if (!entry.name.startsWith("Gram.app/")) continue;
      const path = join(destination, entry.name);
      if (entry.name.endsWith("/")) {
        await mkdir(path, { recursive: true, mode: 0o755 });
        continue;
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o755 });
      if (entry.type === 0o120000) {
        if (entry.size > 2048 || entry.packed > 4096) throw new Error("Oversized ZIP symlink");
        const chunks: Buffer[] = [];
        await unpack(
          entry,
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              chunks.push(chunk);
              callback();
            },
          }),
        );
        const target = Buffer.concat(chunks).toString("utf8");
        if (!safeLink(entry.name.slice("Gram.app/".length), target))
          throw new Error("Unsafe ZIP symlink");
        links.push({ path, target });
      } else {
        await unpack(entry, createWriteStream(path, { flags: "wx", mode: 0o600 }));
        await chmod(path, entry.mode & 0o777 || 0o644);
      }
    }
    for (const link of links) await symlink(link.target, link.path);
    for (const entry of entries.toReversed()) {
      if (
        (entry.name === "Gram.app/" || entry.name.startsWith("Gram.app/")) &&
        entry.name.endsWith("/")
      )
        await chmod(join(destination, entry.name), entry.mode & 0o777 || 0o755);
    }
    return join(destination, "Gram.app");

    async function unpack(entry: Entry, output: NodeJS.WritableStream) {
      let bytes = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback(
            bytes > entry.size ? new Error("ZIP entry inflated past its bound") : null,
            chunk,
          );
        },
      });
      if (!entry.packed) {
        if (entry.size) throw new Error("Empty compressed ZIP entry");
        await pipeline(Readable.from([]), output);
        return;
      }
      const input = createReadStream(archive, {
        start: entry.offset,
        end: entry.offset + entry.packed - 1,
      });
      if (entry.method === 8) await pipeline(input, createInflateRaw(), limit, output);
      else await pipeline(input, limit, output);
      if (bytes !== entry.size) throw new Error("ZIP entry size mismatch");
    }
  } finally {
    await handle.close();
  }
}

const { createReadStream, createWriteStream } = macFs;
const { chmod, mkdir, open, symlink } = macFsPromises;
