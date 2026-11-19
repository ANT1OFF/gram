import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSsl3 } from "./openssl-testing.ts";
import {
  GRAM_RELEASE_PUBLIC_KEY,
  releaseKeyPem,
  requireChecksumsSignature,
  validReleaseKey,
} from "./release-signature.ts";

/** A throwaway publisher key, made for the test, and its signature of `text`. */
const publisher = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64");
  return {
    key: raw,
    sign: (text: string) => sign(null, Buffer.from(text), privateKey).toString("base64"),
  };
};
const SUMS = `${"a".repeat(64)}  gram_1.17.0_x86_64.AppImage\n`;

describe("the release's checksum signature", () => {
  it("takes the pinned publisher's signature of the exact list", () => {
    const { key, sign: signed } = publisher();
    expect(validReleaseKey(key)).toBe(true);
    expect(() => requireChecksumsSignature(SUMS, `${signed(SUMS)}\n`, key)).not.toThrow();
  });

  it("refuses another key's signature, a changed list and a malformed signature", () => {
    const { key, sign: signed } = publisher();
    const other = publisher();
    expect(() => requireChecksumsSignature(SUMS, other.sign(SUMS), key)).toThrow(
      "aren't signed by Gram's publisher",
    );
    expect(() => requireChecksumsSignature(`${SUMS}x`, signed(SUMS), key)).toThrow(
      "aren't signed by Gram's publisher",
    );
    // A trailing newline is part of what was signed.
    expect(() => requireChecksumsSignature(SUMS.trimEnd(), signed(SUMS), key)).toThrow(
      "aren't signed by Gram's publisher",
    );
    expect(() => requireChecksumsSignature(SUMS, "", key)).toThrow("malformed");
    expect(() => requireChecksumsSignature(SUMS, "not base64!", key)).toThrow("malformed");
  });

  it("fails closed with no pinned key, which the placeholder is", () => {
    const { sign: signed } = publisher();
    expect(() => requireChecksumsSignature(SUMS, signed(SUMS), null)).toThrow(
      "pins no release signing key",
    );
    if (GRAM_RELEASE_PUBLIC_KEY === null)
      expect(() => requireChecksumsSignature(SUMS, signed(SUMS))).toThrow("pins no release");
    else expect(validReleaseKey(GRAM_RELEASE_PUBLIC_KEY)).toBe(true);
  });

  it("gives OpenSSL, as the installer runs it, a key it verifies with", () => {
    const { key, sign: signed } = publisher();
    const dir = mkdtempSync(join(tmpdir(), "gram-release-key-"));
    try {
      writeFileSync(join(dir, "key.pem"), releaseKeyPem(key));
      writeFileSync(join(dir, "sums"), SUMS);
      writeFileSync(join(dir, "sig"), Buffer.from(signed(SUMS), "base64"));
      const verified = spawnSync(
        openSsl3(),
        [
          "pkeyutl",
          "-verify",
          "-pubin",
          "-inkey",
          "key.pem",
          "-rawin",
          "-in",
          "sums",
          "-sigfile",
          "sig",
        ],
        { cwd: dir, encoding: "utf8" },
      );
      expect(verified.status, verified.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
