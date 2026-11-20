#!/usr/bin/env node
// The publisher's release signing key: an Ed25519 key whose private half lives only in your macOS
// login keychain. release:rc and release:stable sign each release's SHA256SUMS.txt with it, as
// SHA256SUMS.txt.sig beside it, and a joined machine's host and installer verify that signature
// against the public half pinned in packages/git/src/release-signature.ts, so a release changed on
// GitHub alone no longer installs. GitHub never holds the private half.
//
//   bun run release:key keygen   once: makes the key, keeps it in your keychain, prints the public
//                                half to pin as GRAM_RELEASE_PUBLIC_KEY
//   bun run release:key show     prints the public half of the key in your keychain
//
// See docs/RELEASING.md#release-signing-key.
import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Where the private half is kept: a generic password in your login keychain. */
export const RELEASE_KEYCHAIN = { service: "Gram release signing", account: "release-checksums" };
/** The signature's asset name, beside SHA256SUMS.txt. */
export const CHECKSUMS_SIGNATURE = "SHA256SUMS.txt.sig";

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const SECURITY = "/usr/bin/security";

/** The raw 32-byte public half, base64, as GRAM_RELEASE_PUBLIC_KEY pins it. */
export const publicKeyOf = (privatePkcs8) => {
  const der = createPublicKey(
    createPrivateKey({ key: Buffer.from(privatePkcs8, "base64"), format: "der", type: "pkcs8" }),
  ).export({ format: "der", type: "spki" });
  if (der.length !== 44 || !der.subarray(0, 12).equals(SPKI_PREFIX))
    throw new Error("the release key isn't an Ed25519 key.");
  return der.subarray(12).toString("base64");
};

/** A new key: its private half as base64 PKCS#8 DER, and its pinnable public half. */
export const generateReleaseKey = () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privatePkcs8 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  return { privatePkcs8, publicKey: publicKeyOf(privatePkcs8) };
};

/** Whether `signature` (base64) is `publicKey`'s signature of `bytes`. */
export const checksumsSigned = (bytes, signature, publicKey) => {
  const key = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey, "base64")]),
    format: "der",
    type: "spki",
  });
  return verify(null, bytes, key, Buffer.from(signature.trim(), "base64"));
};

/**
 * Signs `assets/SHA256SUMS.txt` as `assets/SHA256SUMS.txt.sig` and answers that name, once the key
 * `readPrivate` answers is the one `pinnedKey` pins. With no key pinned it signs nothing and
 * answers undefined: nothing would verify a signature. A pinned key that isn't in the keychain, or
 * isn't the one there, stops the release.
 */
export const signReleaseChecksums = ({ assets, pinnedKey, readPrivate }) => {
  if (pinnedKey === null || pinnedKey === undefined) return undefined;
  const privatePkcs8 = readPrivate();
  if (!privatePkcs8)
    throw new Error(
      `GRAM_RELEASE_PUBLIC_KEY is pinned but your keychain has no "${RELEASE_KEYCHAIN.service}" key; sign on the Mac that made it (bun run release:key show).`,
    );
  if (publicKeyOf(privatePkcs8) !== pinnedKey)
    throw new Error(
      "the release key in your keychain isn't the one GRAM_RELEASE_PUBLIC_KEY pins; nothing was signed.",
    );
  const sums = readFileSync(join(assets, "SHA256SUMS.txt"));
  const signature = sign(
    null,
    sums,
    createPrivateKey({ key: Buffer.from(privatePkcs8, "base64"), format: "der", type: "pkcs8" }),
  ).toString("base64");
  if (!checksumsSigned(sums, signature, pinnedKey))
    throw new Error("the checksum signature doesn't verify against the pinned key.");
  writeFileSync(join(assets, CHECKSUMS_SIGNATURE), `${signature}\n`);
  return CHECKSUMS_SIGNATURE;
};

/** The key pinned in `source`'s packages/git/src/release-signature.ts (null: none yet). */
export const pinnedReleaseKey = async (source) => {
  const file = join(source, "packages/git/src/release-signature.ts");
  if (!existsSync(file)) return null;
  return (await import(pathToFileURL(file).href)).GRAM_RELEASE_PUBLIC_KEY ?? null;
};

/** The private half from your keychain, or undefined when it has none. */
export const keychainReleaseKey = (run = spawnSync) => {
  const found = run(
    SECURITY,
    ["find-generic-password", "-s", RELEASE_KEYCHAIN.service, "-a", RELEASE_KEYCHAIN.account, "-w"],
    { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
  );
  if (found.status === 44) return undefined;
  if (found.status !== 0)
    throw new Error(`security couldn't read the release key (exit ${found.status}).`);
  return found.stdout.trim();
};

/** Keeps a new key in your keychain, passed on security's stdin so it is never in an argument list. */
const storeInKeychain = (privatePkcs8) => {
  const stored = spawnSync(SECURITY, ["-i"], {
    input: `add-generic-password -s "${RELEASE_KEYCHAIN.service}" -a ${RELEASE_KEYCHAIN.account} -D "Ed25519 release signing key" -w ${privatePkcs8}\n`,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
  });
  if (stored.status !== 0)
    throw new Error(`security couldn't keep the key (exit ${stored.status}).`);
};

const main = (command) => {
  if (process.platform !== "darwin")
    throw new Error("the release key lives in a macOS keychain: run this on the publisher's Mac.");
  const have = keychainReleaseKey();
  if (command === "show") {
    if (!have) throw new Error("your keychain has no release key: run bun run release:key keygen.");
    process.stdout.write(`${publicKeyOf(have)}\n`);
    return;
  }
  if (command !== "keygen") throw new Error("Name a command: keygen or show.");
  if (have)
    throw new Error(
      `your keychain already has a release key (public ${publicKeyOf(have)}); it is never replaced here.`,
    );
  const { privatePkcs8, publicKey } = generateReleaseKey();
  storeInKeychain(privatePkcs8);
  if (keychainReleaseKey() !== privatePkcs8)
    throw new Error("the key didn't read back from your keychain.");
  process.stdout.write(
    `Kept the private half in your login keychain ("${RELEASE_KEYCHAIN.service}"). Back it up offline.\n` +
      `Pin the public half in packages/git/src/release-signature.ts:\n\n` +
      `  export const GRAM_RELEASE_PUBLIC_KEY: string | null = "${publicKey}";\n`,
  );
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv[2]);
  } catch (error) {
    process.stderr.write(`release:key: ${error.message}\n`);
    process.exit(1);
  }
}
