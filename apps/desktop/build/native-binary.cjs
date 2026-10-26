"use strict";
// Identifies the OS and CPU a native binary targets from its file header, so the packaging checks
// don't depend on how each native package lays out its prebuilds.
const fs = require("node:fs");
const path = require("node:path");

const MACHO_CPU = { 0x01000007: "x64", 0x0100000c: "arm64" };
const PE_MACHINE = { 0x014c: "ia32", 0x8664: "x64", 0xaa64: "arm64" };
const ELF_MACHINE = { 0x03: "ia32", 0x3e: "x64", 0xb7: "arm64" };

/**
 * @param {Buffer} buf the start of a file (4 KiB covers the PE header offset)
 * @returns {{ platform: "darwin" | "win32" | "linux", arch: string } | null} null when the bytes
 *   aren't a Mach-O, PE or ELF binary
 */
function identifyBinary(buf) {
  if (buf.length < 20) return null;
  if (buf.readUInt32LE(0) === 0xfeedfacf) {
    return { platform: "darwin", arch: MACHO_CPU[buf.readUInt32LE(4)] ?? "unknown" };
  }
  // A fat Mach-O; the small arch count tells it apart from a Java class file (same magic).
  if (buf.readUInt32BE(0) === 0xcafebabe && buf.readUInt32BE(4) < 20) {
    return { platform: "darwin", arch: "universal" };
  }
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    const pe = buf.readUInt32LE(0x3c);
    if (pe + 6 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) return null;
    return { platform: "win32", arch: PE_MACHINE[buf.readUInt16LE(pe + 4)] ?? "unknown" };
  }
  if (buf.readUInt32LE(0) === 0x464c457f) {
    return { platform: "linux", arch: ELF_MACHINE[buf.readUInt16LE(18)] ?? "unknown" };
  }
  return null;
}

function readHeader(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(4096);
    return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0));
  } finally {
    fs.closeSync(fd);
  }
}

/** Regular files under `dir`, recursively; empty when `dir` doesn't exist. */
function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** Every native binary under `dir` with the platform and arch it targets. */
function findBinaries(dir) {
  const found = [];
  for (const file of listFiles(dir)) {
    const id = identifyBinary(readHeader(file));
    if (id) found.push({ file, ...id });
  }
  return found;
}

/** Native binaries under `dir` that won't run on `platform`/`arch`. */
function findForeignBinaries(dir, platform, arch) {
  return findBinaries(dir).filter(
    (b) =>
      b.platform !== platform ||
      (b.arch !== arch && b.arch !== "universal" && arch !== "universal"),
  );
}

module.exports = { identifyBinary, listFiles, findBinaries, findForeignBinaries };
