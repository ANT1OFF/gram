// The publisher's release signature: an Ed25519 signature over a release's `SHA256SUMS.txt`,
// published beside it as `SHA256SUMS.txt.sig` (base64). The private half lives only in the
// publisher's macOS keychain (`bun run release:key keygen` makes it); GitHub
// never holds it, so a release changed on GitHub alone no longer verifies.

import { createPublicKey, verify } from "node:crypto";

/** The file a release's checksum signature is published as. */
export const CHECKSUMS_SIGNATURE = "SHA256SUMS.txt.sig";

/**
 * The publisher's Ed25519 public key, as base64 of its raw 32 bytes: the key whose private half
 * `bun run release:key keygen` kept in the publisher's login keychain (20 November 2026).
 */
export const GRAM_RELEASE_PUBLIC_KEY: string | null =
  "WJQzqS72egfjClRWY2oBKqBm9XyEAtOCwZHkaeMgQx8=";

/** The SPKI DER prefix of an Ed25519 public key, before its raw 32 bytes. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Whether `key` is base64 of a raw 32-byte Ed25519 public key. */
export const validReleaseKey = (key: string): boolean =>
  /^[A-Za-z0-9+/]{43}=$/.test(key) && Buffer.from(key, "base64").length === 32;

/** The key's SPKI PEM, as `openssl pkeyutl -pubin` reads it. */
export const releaseKeyPem = (key: string): string => {
  if (!validReleaseKey(key)) throw new Error("That isn't an Ed25519 release key.");
  const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(key, "base64")]);
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
};

/**
 * Refuses, with a message for the update's outcome, unless `signature` (base64, as published) is
 * the publisher's signature of `checksums` under `key`. A missing key refuses: see the placeholder.
 */
export const requireChecksumsSignature = (
  checksums: string,
  signature: string,
  key: string | null = GRAM_RELEASE_PUBLIC_KEY,
): void => {
  if (key === null)
    throw new Error(
      "Signed release refused: this build pins no release signing key, so it can't verify the release.",
    );
  const raw = signature.trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(raw))
    throw new Error("Signed release refused: the release's checksum signature is malformed.");
  const publicKey = createPublicKey({ key: releaseKeyPem(key), format: "pem" });
  if (!verify(null, Buffer.from(checksums, "utf8"), publicKey, Buffer.from(raw, "base64")))
    throw new Error(
      "Signed release refused: the release's checksums aren't signed by Gram's publisher.",
    );
};
