import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkSums } from "./stable.mjs";

// Checksum verification must not need a system executable, at any path.
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => {
    throw new Error("checksum verification spawned a process");
  }),
}));

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytes = Buffer.alloc(256 * 1024, 0xa5);
const line = (name, hash = digest(bytes)) => `${hash}  ${name}\n`;
let root;
let dir;
const sums = (text) => writeFileSync(join(dir, "SHA256SUMS.txt"), text);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gram-checksums-"));
  dir = join(root, "assets");
  mkdirSync(dir);
  writeFileSync(join(dir, "app.zip"), bytes);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("SHA256SUMS.txt verification", () => {
  it("streams every listed file, including files beyond the required coverage", async () => {
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "extra.deb"), "extra");
    sums(line("nested/extra.deb", digest("extra")) + line("app.zip").trimEnd());
    await expect(checkSums(dir, ["app.zip"])).resolves.toEqual(["app.zip", "nested/extra.deb"]);
  });

  it.each(["", "\n"])("rejects an empty list: %j", async (text) => {
    sums(text);
    await expect(checkSums(dir, [])).rejects.toThrow(/SHA256SUMS\.txt.*empty/);
  });

  it.each([
    "invalid  bad.zip\n",
    `${"g".repeat(64)}  bad.zip\n`,
    `${digest(bytes)} bad.zip\n`,
    `${digest(bytes)} *bad.zip extra\n`,
    "\n",
  ])("rejects every malformed line, even after a valid entry: %j", async (bad) => {
    sums(line("app.zip") + bad);
    await expect(checkSums(dir, [])).rejects.toThrow(/SHA256SUMS\.txt.*malformed line 2/);
    if (bad.includes("bad.zip")) await expect(checkSums(dir, [])).rejects.toThrow("bad.zip");
  });

  it("rejects a missing listed file beyond the required coverage", async () => {
    sums(line("app.zip") + line("missing.deb"));
    await expect(checkSums(dir, ["app.zip"])).rejects.toThrow(/missing\.deb.*isn't there/);
  });

  it("rejects a mismatched listed file beyond the required coverage", async () => {
    writeFileSync(join(dir, "extra.deb"), "wrong");
    sums(line("app.zip") + line("extra.deb"));
    await expect(checkSums(dir, ["app.zip"])).rejects.toThrow(
      /extra\.deb doesn't match SHA256SUMS\.txt/,
    );
  });

  it("rejects omitted required coverage", async () => {
    sums(line("app.zip"));
    await expect(checkSums(dir, ["missing.deb"])).rejects.toThrow(
      /SHA256SUMS\.txt doesn't list missing\.deb/,
    );
  });

  it("rejects duplicate names instead of silently overwriting an earlier digest", async () => {
    sums(line("app.zip", "0".repeat(64)) + line("app.zip"));
    await expect(checkSums(dir, [])).rejects.toThrow(/SHA256SUMS\.txt.*duplicate.*app\.zip/);
  });

  it.each([
    "../outside.zip",
    "nested/../app.zip",
    "nested/../../outside.zip",
    "..\\outside.zip",
    "/outside.zip",
    "C:\\outside.zip",
    "\\\\server\\share\\outside.zip",
  ])("rejects unsafe paths: %s", async (name) => {
    sums(line(name));
    await expect(checkSums(dir, [])).rejects.toThrow("unsafe path");
    await expect(checkSums(dir, [])).rejects.toThrow(name);
  });

  it("rejects an absolute path even when its file exists", async () => {
    const file = join(dir, "app.zip");
    sums(line(file));
    await expect(checkSums(dir, [])).rejects.toThrow("unsafe path");
  });

  it("rejects a symlink that escapes the asset directory", async () => {
    writeFileSync(join(root, "outside.zip"), bytes);
    symlinkSync(join(root, "outside.zip"), join(dir, "linked.zip"));
    sums(line("linked.zip"));
    await expect(checkSums(dir, [])).rejects.toThrow(/linked\.zip.*outside/);
  });

  it("rejects a listed directory with a clear file error", async () => {
    mkdirSync(join(dir, "folder"));
    sums(line("folder"));
    await expect(checkSums(dir, [])).rejects.toThrow(/folder.*regular file/);
  });
});
