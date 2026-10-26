/**
 * Keychain access for internal-CA builds: macOS partitions their access by cdhash even with a
 * stable DR. Only the Apple-signed CLI reads the encryption password; its output stays in main's
 * memory. Developer ID builds use Electron directly.
 */
import { createCipheriv, createDecipheriv, pbkdf2Sync } from "node:crypto";

import { Proc, ProcLive, type ProcShape } from "@gram/git/proc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { VaultCrypto } from "./vault.ts";

/**
 * Electron's keychain item, named after the product: "<name> Safe Storage" for the service and
 * "<name> Key" for the account.
 */
const KEYCHAIN_ITEM = { service: "Gram Safe Storage", account: "Gram Key" } as const;
const PREFIX = Buffer.from("v10");
const IV = Buffer.alloc(16, " ");

/** Whether a successful codesign inspection explicitly reports no Apple team. */
export const lacksAppleTeam = (signature: string): boolean =>
  /^TeamIdentifier=not set$/m.test(signature) &&
  !/^TeamIdentifier=(?!not set$).+$/m.test(signature);

/** Chromium's macOS sync format; keep interoperability covered when Electron's codec changes. */
export const chromiumMacCrypto = (password: Buffer): Pick<VaultCrypto, "encrypt" | "decrypt"> => {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  return {
    encrypt: (plain) => {
      const cipher = createCipheriv("aes-128-cbc", key, IV);
      return Buffer.concat([PREFIX, cipher.update(plain, "utf8"), cipher.final()]);
    },
    decrypt: (encrypted) => {
      if (!encrypted.subarray(0, 3).equals(PREFIX)) throw new Error("unsupported vault ciphertext");
      const decipher = createDecipheriv("aes-128-cbc", key, IV);
      return Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]).toString(
        "utf8",
      );
    },
  };
};

/** Injectable reads keep credentials out of process errors and make the fallback testable. */
export interface MacVaultReads {
  signature(): Promise<string | undefined>;
  password(): Promise<Buffer | undefined>;
}

/** Uses the CLI only on macOS without a team; failed reads keep Electron's existing prompt path. */
export const makeMacVaultCrypto = (
  fallback: VaultCrypto,
  platform: NodeJS.Platform,
  reads: MacVaultReads,
): VaultCrypto => {
  let selected: Promise<VaultCrypto> | undefined;
  const select = () =>
    (selected ??= (async () => {
      if (platform !== "darwin") return fallback;
      try {
        const signature = await reads.signature();
        if (signature === undefined || !lacksAppleTeam(signature)) return fallback;
        const password = await reads.password();
        if (password === undefined) return fallback;
        try {
          return { available: () => true, ...chromiumMacCrypto(password) };
        } finally {
          password.fill(0);
        }
      } catch {
        // Denial, timeout and inspection failures must retain today's safeStorage behavior.
        return fallback;
      }
    })());
  return {
    // Electron's availability check itself reads the keychain, so select before calling it.
    available: async () => (await select()).available(),
    ...(fallback.backend === undefined ? {} : { backend: () => fallback.backend?.() }),
    encrypt: async (plain) => (await select()).encrypt(plain),
    decrypt: async (encrypted) => (await select()).decrypt(encrypted),
  };
};

/** Exact, absolute executable invocations through Proc.run's bounded runCommand implementation. */
export const liveMacVaultReads = (executable: string, proc?: ProcShape): MacVaultReads => {
  const item = KEYCHAIN_ITEM;
  const run = (bin: string, args: readonly string[]) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* Proc;
        return yield* runner.run(bin, args, {
          cwd: "/",
          timeoutMs: bin === "/usr/bin/codesign" ? 5_000 : 30_000,
          maxOutputBytes: 16_384,
        });
      }).pipe(Effect.provide(proc === undefined ? ProcLive : Layer.succeed(Proc, proc))),
    );
  return {
    signature: async () => {
      const out = await run("/usr/bin/codesign", ["-d", "--verbose=4", executable]);
      return out.status === 0 && !out.truncated ? out.stderr : undefined;
    },
    password: async () => {
      const out = await run("/usr/bin/security", [
        "find-generic-password",
        "-s",
        item.service,
        "-a",
        item.account,
        "-w",
      ]);
      if (out.status !== 0 || out.truncated) return undefined;
      // The CLI adds one newline. Passwords are opaque: don't trim their content.
      const password = out.stdout.replace(/\r?\n$/, "");
      return password === "" ? undefined : Buffer.from(password, "utf8");
    },
  };
};
