import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { requireChecksumsSignature } from "../../packages/git/src/release-signature.ts";
import {
  CHECKSUMS_SIGNATURE,
  generateReleaseKey,
  keychainReleaseKey,
  signReleaseChecksums,
} from "./release-key.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const assets = () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-release-key-"));
  dirs.push(dir);
  writeFileSync(join(dir, "SHA256SUMS.txt"), `${"a".repeat(64)}  gram_1.17.0_x86_64.AppImage\n`);
  return dir;
};

describe("the release signing key", () => {
  it("signs the exact checksum list so the host's check takes it", () => {
    const { privatePkcs8, publicKey } = generateReleaseKey();
    const dir = assets();
    expect(
      signReleaseChecksums({ assets: dir, pinnedKey: publicKey, readPrivate: () => privatePkcs8 }),
    ).toBe(CHECKSUMS_SIGNATURE);
    const sums = readFileSync(join(dir, "SHA256SUMS.txt"), "utf8");
    const signature = readFileSync(join(dir, CHECKSUMS_SIGNATURE), "utf8");
    expect(() => requireChecksumsSignature(sums, signature, publicKey)).not.toThrow();
    expect(() => requireChecksumsSignature(`${sums}x`, signature, publicKey)).toThrow();
  });

  it("signs nothing while the source pins no key", () => {
    const dir = assets();
    expect(
      signReleaseChecksums({
        assets: dir,
        pinnedKey: null,
        readPrivate: () => {
          throw new Error("the keychain isn't asked");
        },
      }),
    ).toBeUndefined();
    expect(existsSync(join(dir, CHECKSUMS_SIGNATURE))).toBe(false);
  });

  it("stops a release whose keychain key is missing or isn't the pinned one", () => {
    const pinned = generateReleaseKey();
    const other = generateReleaseKey();
    const dir = assets();
    expect(() =>
      signReleaseChecksums({ assets: dir, pinnedKey: pinned.publicKey, readPrivate: () => "" }),
    ).toThrow("has no");
    expect(() =>
      signReleaseChecksums({
        assets: dir,
        pinnedKey: pinned.publicKey,
        readPrivate: () => other.privatePkcs8,
      }),
    ).toThrow("isn't the one GRAM_RELEASE_PUBLIC_KEY pins");
    expect(existsSync(join(dir, CHECKSUMS_SIGNATURE))).toBe(false);
  });

  it("reads the key from the keychain by name, and tells a missing one apart", () => {
    const asked = [];
    const found = keychainReleaseKey((file, args) => {
      asked.push([file, ...args]);
      return { status: 0, stdout: "c2VjcmV0\n" };
    });
    expect(found).toBe("c2VjcmV0");
    expect(asked[0]).toEqual([
      "/usr/bin/security",
      "find-generic-password",
      "-s",
      "Gram release signing",
      "-a",
      "release-checksums",
      "-w",
    ]);
    expect(keychainReleaseKey(() => ({ status: 44, stdout: "" }))).toBeUndefined();
    expect(() => keychainReleaseKey(() => ({ status: 51, stdout: "" }))).toThrow("exit 51");
  });
});
