import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installAppImage, locateAppImage, verifyAppImageCandidate } from "./appimage.ts";
import { linuxUpdateTarget } from "./linux-target.ts";
import { snapshotCandidate } from "./native-snapshot.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gram-appimage-test-"));
  dirs.push(dir);
  return dir;
}

/** An AppImage as far as Gram's checks know: ELF, then the type 2 magic at offset 8. */
const appImageBytes = (label: string) =>
  Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 0x02, 0, 0, 0, 0, 0]),
    Buffer.from(`Gram ${label}`),
  ]);

const digests = (bytes: Buffer) => ({
  sha512: createHash("sha512").update(bytes).digest("base64"),
  digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  size: bytes.length,
});

describe("locateAppImage", () => {
  it("finds the running AppImage and whether this user may replace it", async () => {
    const dir = await scratch();
    const file = join(dir, "gram_1.3.1_x86_64.AppImage");
    await writeFile(file, appImageBytes("1.3.1"));
    expect(await locateAppImage({ APPIMAGE: file })).toEqual({ path: file, writable: true });
    // Someone else's file can't be replaced, even in a writable folder.
    expect(await locateAppImage({ APPIMAGE: file }, -1)).toEqual({ path: file, writable: false });
    await chmod(dir, 0o500);
    expect(await locateAppImage({ APPIMAGE: file })).toEqual({ path: file, writable: false });
  });

  it("refuses anything but an absolute path to a plain .AppImage file", async () => {
    const dir = await scratch();
    const file = join(dir, "gram.AppImage");
    await writeFile(file, appImageBytes("x"));
    const link = join(dir, "link.AppImage");
    await symlink(file, link);
    await mkdir(join(dir, "folder.AppImage"));
    for (const env of [
      {},
      { APPIMAGE: "" },
      { APPIMAGE: "gram.AppImage" },
      { APPIMAGE: join(dir, "missing.AppImage") },
      { APPIMAGE: link },
      { APPIMAGE: join(dir, "folder.AppImage") },
      { APPIMAGE: `${file}\0` },
      { APPIMAGE: join(dir, "gram") },
    ])
      expect(await locateAppImage(env)).toBeUndefined();
  });
});

describe("linuxUpdateTarget", () => {
  const base = {
    platform: "linux" as const,
    arch: "x64",
    packaged: true,
    smoke: false,
    repo: "ANT1OFF/gram",
    appImage: { path: "/home/u/Gram.AppImage", writable: true },
  };
  it("gives the AppImage its updater and anything else packaged the .deb's", () => {
    expect(linuxUpdateTarget(base)).toBe("appimage");
    expect(linuxUpdateTarget({ ...base, appImage: undefined })).toBe("deb");
  });
  it("is nothing off Linux x64, unpackaged, in smoke runs or with no release repo", () => {
    for (const platform of ["darwin", "win32"] as const)
      expect(linuxUpdateTarget({ ...base, platform })).toBeUndefined();
    expect(linuxUpdateTarget({ ...base, arch: "arm64" })).toBeUndefined();
    expect(linuxUpdateTarget({ ...base, packaged: false })).toBeUndefined();
    expect(linuxUpdateTarget({ ...base, smoke: true })).toBeUndefined();
    expect(linuxUpdateTarget({ ...base, repo: null })).toBeUndefined();
  });
});

describe("verifyAppImageCandidate", () => {
  it("accepts the offered AppImage by SHA-512, GitHub's SHA-256 and size", async () => {
    const dir = await scratch();
    const bytes = appImageBytes("1.4.0");
    await writeFile(join(dir, "download.AppImage"), bytes);
    const snapshot = await snapshotCandidate(join(dir, "download.AppImage"), dir);
    try {
      await verifyAppImageCandidate({
        snapshot,
        version: "1.4.0",
        currentVersion: "1.3.1",
        channel: "stable",
        expected: digests(bytes),
      });
    } finally {
      await snapshot.close();
    }
  });

  it("refuses a downgrade, an RC on Stable, a wrong digest or size, and a non-AppImage", async () => {
    const dir = await scratch();
    const bytes = appImageBytes("1.4.0");
    await writeFile(join(dir, "download.AppImage"), bytes);
    const notAppImage = Buffer.from("#!/bin/sh\necho not an AppImage, but the right length\n");
    await writeFile(join(dir, "script"), notAppImage);
    const snapshot = await snapshotCandidate(join(dir, "download.AppImage"), dir);
    const script = await snapshotCandidate(join(dir, "script"), dir);
    const good = digests(bytes);
    const verify = (overrides: Partial<Parameters<typeof verifyAppImageCandidate>[0]>) =>
      verifyAppImageCandidate({
        snapshot,
        version: "1.4.0",
        currentVersion: "1.3.1",
        channel: "stable",
        expected: good,
        ...overrides,
      });
    try {
      await expect(verify({ currentVersion: "1.4.0" })).rejects.toThrow(/isn't an update/);
      await expect(verify({ currentVersion: "1.5.0" })).rejects.toThrow(/isn't an update/);
      await expect(verify({ version: "1.5.0-rc.1" })).rejects.toThrow(/isn't an update/);
      await expect(verify({ expected: { ...good, sha512: undefined } })).rejects.toThrow(/SHA-512/);
      await expect(
        verify({ expected: { ...good, sha512: digests(Buffer.from("other")).sha512 } }),
      ).rejects.toThrow(/SHA-512/);
      await expect(
        verify({ expected: { ...good, digest: `sha256:${"0".repeat(64)}` } }),
      ).rejects.toThrow(/SHA-256/);
      await expect(verify({ expected: { ...good, size: good.size + 1 } })).rejects.toThrow(/size/);
      await expect(verify({ snapshot: script, expected: digests(notAppImage) })).rejects.toThrow(
        /isn't an AppImage/,
      );
    } finally {
      await snapshot.close();
      await script.close();
    }
  });
});

describe("installAppImage", () => {
  it("replaces the AppImage in one rename with the snapshot's bytes, executable", async () => {
    const dir = await scratch();
    const target = join(dir, "gram_1.3.1_x86_64.AppImage");
    await writeFile(target, appImageBytes("1.3.1"), { mode: 0o755 });
    const download = join(dir, "download");
    const next = appImageBytes("1.4.0");
    await writeFile(download, next);
    const snapshot = await snapshotCandidate(download, dir);
    try {
      await installAppImage(snapshot, target);
    } finally {
      await snapshot.close();
    }
    expect(await readFile(target)).toEqual(next);
    expect((await lstat(target)).mode & 0o777).toBe(0o755);
    // No temporary file is left beside it.
    expect((await readdir(dir)).filter((name) => name.includes("gram-update"))).toEqual([]);
  });

  it("leaves the old AppImage untouched when the bytes don't verify as they stream", async () => {
    const dir = await scratch();
    const target = join(dir, "Gram.AppImage");
    const old = appImageBytes("1.3.1");
    await writeFile(target, old, { mode: 0o755 });
    const tampered = {
      deliver: async (write: (chunk: Buffer) => Promise<void>) => {
        await write(Buffer.from("first chunk"));
        throw new Error("The update's bytes changed after they were verified.");
      },
    };
    await expect(installAppImage(tampered, target)).rejects.toThrow(/changed/);
    expect(await readFile(target)).toEqual(old);
    expect(await readdir(dir)).toEqual(["Gram.AppImage"]);
  });

  it("refuses when the AppImage was swapped while the update was written", async () => {
    const dir = await scratch();
    const target = join(dir, "Gram.AppImage");
    await writeFile(target, appImageBytes("1.3.1"));
    const swapping = {
      deliver: async (write: (chunk: Buffer) => Promise<void>) => {
        await write(appImageBytes("1.4.0"));
        await rm(target);
        await writeFile(target, Buffer.from("someone else's file"));
      },
    };
    await expect(installAppImage(swapping, target)).rejects.toThrow(/replaced while/);
    expect((await readFile(target)).toString()).toBe("someone else's file");
    expect(await readdir(dir)).toEqual(["Gram.AppImage"]);
  });

  it("refuses to replace anything but a file", async () => {
    const dir = await scratch();
    await mkdir(join(dir, "Gram.AppImage"));
    await expect(
      installAppImage({ deliver: async () => {} }, join(dir, "Gram.AppImage")),
    ).rejects.toThrow(/isn't a file/);
  });
});
