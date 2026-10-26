import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { identifyBinary, findForeignBinaries } = require("./native-binary.cjs");

function machO(cpu) {
  const buf = Buffer.alloc(32);
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(cpu, 4);
  return buf;
}

function pe(machine) {
  const buf = Buffer.alloc(512);
  buf.write("MZ", 0, "latin1");
  buf.writeUInt32LE(0x80, 0x3c);
  buf.writeUInt32LE(0x00004550, 0x80);
  buf.writeUInt16LE(machine, 0x84);
  return buf;
}

function elf(machine) {
  const buf = Buffer.alloc(64);
  buf.writeUInt32LE(0x464c457f, 0);
  buf.writeUInt16LE(machine, 18);
  return buf;
}

// Filesystem work under full parallel test load can pass vitest's 5 s default.
const FS_TIMEOUT = { timeout: 30_000 };

describe("identifyBinary", FS_TIMEOUT, () => {
  it("reads Mach-O, PE and ELF headers", () => {
    expect(identifyBinary(machO(0x0100000c))).toEqual({ platform: "darwin", arch: "arm64" });
    expect(identifyBinary(machO(0x01000007))).toEqual({ platform: "darwin", arch: "x64" });
    expect(identifyBinary(pe(0x8664))).toEqual({ platform: "win32", arch: "x64" });
    expect(identifyBinary(pe(0xaa64))).toEqual({ platform: "win32", arch: "arm64" });
    expect(identifyBinary(elf(0x3e))).toEqual({ platform: "linux", arch: "x64" });
  });

  it("treats a fat Mach-O as universal but not a Java class file", () => {
    const fat = Buffer.alloc(32);
    fat.writeUInt32BE(0xcafebabe, 0);
    fat.writeUInt32BE(2, 4);
    expect(identifyBinary(fat)).toEqual({ platform: "darwin", arch: "universal" });
    fat.writeUInt32BE(52, 4);
    expect(identifyBinary(fat)).toBeNull();
  });

  it("ignores text and a DOS stub without a PE header", () => {
    expect(identifyBinary(Buffer.from("#!/bin/sh\necho not a binary\n"))).toBeNull();
    const stub = pe(0x8664);
    stub.writeUInt32LE(0, 0x80);
    expect(identifyBinary(stub)).toBeNull();
  });

  it("identifies the running Node binary as this host", () => {
    const header = Buffer.alloc(4096);
    const fd = fs.openSync(process.execPath, "r");
    fs.readSync(fd, header, 0, header.length, 0);
    fs.closeSync(fd);
    const id = identifyBinary(header);
    expect(id?.platform).toBe(process.platform);
    expect([process.arch, "universal"]).toContain(id?.arch);
  });
});

describe("findForeignBinaries", FS_TIMEOUT, () => {
  let dir;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reports only binaries for another target", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gram-natives-"));
    const write = (rel, buf) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), buf);
    };
    write("node-pty/prebuilds/darwin-arm64/pty.node", machO(0x0100000c));
    write("node-pty/prebuilds/darwin-x64/pty.node", machO(0x01000007));
    write("node-pty/prebuilds/win32-x64/conpty.dll", pe(0x8664));
    write("node-pty/lib/index.js", Buffer.from("module.exports = {};\n"));

    const foreign = findForeignBinaries(dir, "darwin", "arm64").map((b) =>
      path.relative(dir, b.file).split(path.sep).join("/"),
    );
    expect(foreign.toSorted()).toEqual([
      "node-pty/prebuilds/darwin-x64/pty.node",
      "node-pty/prebuilds/win32-x64/conpty.dll",
    ]);
  });

  it("is empty when the directory is absent", () => {
    dir = path.join(os.tmpdir(), "gram-natives-absent");
    expect(findForeignBinaries(dir, "win32", "x64")).toEqual([]);
  });
});
