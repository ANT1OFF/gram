import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProcShape } from "@gram/git/proc";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fileVaultStore, handleVaultRequest, type VaultCrypto, type VaultStore } from "./vault.ts";
import { chromiumMacCrypto, lacksAppleTeam, liveMacVaultReads, makeMacVaultCrypto } from "./mac.ts";

const SECRET = "sk-desktop-secret";

/** Faults the next vault write or rename, as a full disk or a Windows file lock would. */
const disk: { tornWrites: number; lockedRenames: number } = { tornWrites: 0, lockedRenames: 0 };

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  const writeFile: (typeof FsPromises)["writeFile"] = async (file, data, options) => {
    if (disk.tornWrites === 0 || typeof data !== "string")
      return real.writeFile(file, data, options);
    disk.tornWrites -= 1;
    await real.writeFile(file, data.slice(0, data.length / 2), options);
    throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  };
  const rename: (typeof FsPromises)["rename"] = async (from, to) => {
    if (disk.lockedRenames === 0) return real.rename(from, to);
    disk.lockedRenames -= 1;
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  };
  return { ...real, writeFile, rename };
});

/** A reversible stand-in for safeStorage whose ciphertext doesn't contain the plaintext. */
const fakeCrypto = (available = true): VaultCrypto => ({
  available: () => available,
  encrypt: (plain) => Buffer.from([...Buffer.from(plain)].map((b) => b ^ 0x5a)),
  decrypt: (encrypted) => Buffer.from([...encrypted].map((b) => b ^ 0x5a)).toString(),
});

const memoryStore = (): VaultStore & { entries: Record<string, string> } => {
  const store = {
    entries: {} as Record<string, string>,
    read: async () => ({ ...store.entries }),
    write: async (entries: Record<string, string>) => {
      store.entries = entries;
    },
  };
  return store;
};

describe("macOS keychain compatibility", () => {
  it("reads the retained Chromium v10 fixture and writes the same bytes", async () => {
    const crypto = chromiumMacCrypto(Buffer.from("test-safe-storage-password"));
    const fixture = Buffer.from("djEwknwsGGapbeAoTJtWEq29jBsFBMJABmcBg1ByEwHn0uw=", "base64");
    expect(await crypto.decrypt(fixture)).toBe("gateway fixture ✓");
    expect(await crypto.encrypt("gateway fixture ✓")).toEqual(fixture);
    await expect(async () => crypto.decrypt(Buffer.from("unknown ciphertext"))).rejects.toThrow(
      "unsupported vault ciphertext",
    );
  });
  it("requires an explicit absent team and preserves the Developer ID path", async () => {
    expect(lacksAppleTeam("TeamIdentifier=not set\n")).toBe(true);
    for (const signature of [
      "",
      "TeamIdentifier=EXAMPLETEAM01\n",
      "TeamIdentifier=not set\nTeamIdentifier=EXAMPLETEAM01\n",
    ]) {
      expect(lacksAppleTeam(signature)).toBe(false);
    }
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const fallback = fakeCrypto();
      const signature = vi.fn(async () => "TeamIdentifier=EXAMPLETEAM01\n");
      const password = vi.fn(async () => Buffer.from("test"));
      const crypto = makeMacVaultCrypto(fallback, platform, { signature, password });
      expect(await crypto.encrypt(SECRET)).toEqual(fallback.encrypt(SECRET));
      expect(password).not.toHaveBeenCalled();
      expect(signature).toHaveBeenCalledTimes(platform === "darwin" ? 1 : 0);
    }
  });

  it("loads one password across concurrent requests and zeroes its temporary buffer", async () => {
    const secret = Buffer.from("test-safe-storage-password");
    const password = vi.fn(async () => secret);
    const available = vi.fn(() => {
      throw new Error("Electron would prompt");
    });
    const crypto = makeMacVaultCrypto({ ...fakeCrypto(), available }, "darwin", {
      signature: async () => "TeamIdentifier=not set\n",
      password,
    });
    const ciphertexts = await Promise.all([crypto.encrypt(SECRET), crypto.encrypt("another")]);
    expect(password).toHaveBeenCalledTimes(1);
    expect(await crypto.available()).toBe(true);
    expect(available).not.toHaveBeenCalled();
    expect(secret.every((b) => b === 0)).toBe(true);
    expect(await crypto.decrypt(ciphertexts[0]!)).toBe(SECRET);
    expect(await crypto.decrypt(ciphertexts[1]!)).toBe("another");
    expect(JSON.stringify(ciphertexts)).not.toContain(SECRET);
  });

  it("uses safeStorage after denial, timeout, missing item or failed inspection", async () => {
    for (const failure of [undefined, new Error(`denied ${SECRET}`)]) {
      for (const failInspection of [false, true]) {
        const read = async () => {
          if (failure instanceof Error) throw failure;
          return failure;
        };
        const fallback = fakeCrypto();
        const crypto = makeMacVaultCrypto(fallback, "darwin", {
          signature: failInspection ? read : async () => "TeamIdentifier=not set\n",
          password: read,
        });
        const encrypted = await crypto.encrypt(SECRET);
        expect(encrypted).toEqual(fallback.encrypt(SECRET));
        expect(await crypto.decrypt(encrypted)).toBe(SECRET);
      }
    }
  });

  it("uses only the absolute CLI and exact owned service/account, rejecting partial output", async () => {
    const calls: { bin: string; args: readonly string[] }[] = [];
    let truncated = false;
    let status = 0;
    const proc: ProcShape = {
      run: (bin, args, options) => {
        calls.push({ bin, args });
        expect(options.timeoutMs).toBe(bin === "/usr/bin/codesign" ? 5_000 : 30_000);
        return Effect.succeed({
          status,
          truncated,
          stdout: " opaque test password \n",
          stderr: "TeamIdentifier=not set\n",
        });
      },
    };
    const reads = liveMacVaultReads("/Applications/Gram.app/Contents/MacOS/Gram", proc);
    expect(await reads.signature()).toBe("TeamIdentifier=not set\n");
    expect((await reads.password())?.toString()).toBe(" opaque test password ");
    expect(calls).toEqual([
      {
        bin: "/usr/bin/codesign",
        args: ["-d", "--verbose=4", "/Applications/Gram.app/Contents/MacOS/Gram"],
      },
      {
        bin: "/usr/bin/security",
        args: ["find-generic-password", "-s", "Gram Safe Storage", "-a", "Gram Key", "-w"],
      },
    ]);
    truncated = true;
    expect(await reads.password()).toBeUndefined();
    truncated = false;
    status = 1;
    expect(await reads.password()).toBeUndefined();
    expect(await reads.signature()).toBeUndefined();
  });
});

describe("handleVaultRequest", () => {
  it("reports the Linux storage backend, and nothing where there is none to report", async () => {
    const store = memoryStore();
    const linux = { ...fakeCrypto(), backend: () => "basic_text" };
    expect(
      await handleVaultRequest({ type: "vault.request", id: "i1", op: "info" }, linux, store),
    ).toEqual({ type: "vault.response", id: "i1", ok: true, value: "basic_text" });
    expect(
      await handleVaultRequest(
        { type: "vault.request", id: "i2", op: "info" },
        fakeCrypto(),
        store,
      ),
    ).toEqual({ type: "vault.response", id: "i2", ok: true });
  });

  it("sets, gets and deletes keys, storing only ciphertext", async () => {
    const store = memoryStore();
    const crypto = fakeCrypto();
    expect(
      await handleVaultRequest(
        { type: "vault.request", id: "1", op: "set", ref: "profile:a", value: SECRET },
        crypto,
        store,
      ),
    ).toEqual({ type: "vault.response", id: "1", ok: true });
    expect(JSON.stringify(store.entries)).not.toContain(SECRET);

    expect(
      await handleVaultRequest(
        { type: "vault.request", id: "2", op: "get", ref: "profile:a" },
        crypto,
        store,
      ),
    ).toEqual({
      type: "vault.response",
      id: "2",
      ok: true,
      value: SECRET,
    });
    await handleVaultRequest(
      { type: "vault.request", id: "3", op: "delete", ref: "profile:a" },
      crypto,
      store,
    );
    expect(
      await handleVaultRequest(
        { type: "vault.request", id: "4", op: "get", ref: "profile:a" },
        crypto,
        store,
      ),
    ).toEqual({
      type: "vault.response",
      id: "4",
      ok: true,
    });
  });

  it("refuses without OS encryption and ignores other messages", async () => {
    const response = await handleVaultRequest(
      { type: "vault.request", id: "1", op: "set", ref: "profile:a", value: SECRET },
      fakeCrypto(false),
      memoryStore(),
    );
    expect(response).toMatchObject({ ok: false });
    expect(JSON.stringify(response)).not.toContain(SECRET);
    for (const other of [
      { type: "boot", url: "http://127.0.0.1:1/?boot=x" },
      null,
      { type: "vault.request", id: "x", op: "set", ref: "r" },
    ]) {
      expect(await handleVaultRequest(other, fakeCrypto(), memoryStore())).toBeUndefined();
    }
  });

  it("never lets one read-modify-write overwrite another", async () => {
    const store = memoryStore();
    const crypto = fakeCrypto();
    const set = (ref: string) =>
      handleVaultRequest(
        { type: "vault.request", id: ref, op: "set", ref, value: SECRET },
        crypto,
        store,
      );
    await set("profile:gone");
    await Promise.all([
      set("profile:a"),
      set("profile:b"),
      handleVaultRequest(
        { type: "vault.request", id: "d", op: "delete", ref: "profile:gone" },
        crypto,
        store,
      ),
      set("profile:c"),
    ]);
    expect(Object.keys(store.entries).toSorted()).toEqual(["profile:a", "profile:b", "profile:c"]);
  });

  it.each(["synchronous", "availability", "encryption"] as const)(
    "keeps a pending set before its delete with %s crypto",
    async (stage) => {
      const store = memoryStore();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const base = fakeCrypto();
      const crypto: VaultCrypto = {
        ...base,
        ...(stage === "availability"
          ? {
              available: async () => {
                entered.resolve();
                await release.promise;
                return true;
              },
            }
          : {}),
        ...(stage === "encryption"
          ? {
              encrypt: async (plain: string) => {
                entered.resolve();
                await release.promise;
                return base.encrypt(plain);
              },
            }
          : {}),
      };
      const set = handleVaultRequest(
        { type: "vault.request", id: "s", op: "set", ref: "profile:a", value: SECRET },
        crypto,
        store,
      );
      if (stage !== "synchronous") await entered.promise;
      const remove = handleVaultRequest(
        { type: "vault.request", id: "d", op: "delete", ref: "profile:a" },
        crypto,
        store,
      );
      release.resolve();
      expect(await Promise.all([set, remove])).toEqual([
        { type: "vault.response", id: "s", ok: true },
        { type: "vault.response", id: "d", ok: true },
      ]);
      expect(store.entries).toEqual({});
    },
  );

  it("does not strand a delete behind failed encryption", async () => {
    const store = memoryStore();
    store.entries["profile:a"] = "old ciphertext";
    const crypto: VaultCrypto = {
      ...fakeCrypto(),
      encrypt: async () => {
        throw new Error(`encryption failed ${SECRET}`);
      },
    };
    const responses = await Promise.all([
      handleVaultRequest(
        { type: "vault.request", id: "s", op: "set", ref: "profile:a", value: SECRET },
        crypto,
        store,
      ),
      handleVaultRequest(
        { type: "vault.request", id: "d", op: "delete", ref: "profile:a" },
        crypto,
        store,
      ),
    ]);
    expect(responses).toEqual([
      {
        type: "vault.response",
        id: "s",
        ok: false,
        message: "couldn't read or write the key store",
      },
      { type: "vault.response", id: "d", ok: true },
    ]);
    expect(store.entries).toEqual({});
  });

  it("reports store failures without the key", async () => {
    const broken: VaultStore = {
      read: async () => Promise.reject(new Error(`disk full ${SECRET}`)),
      write: async () => undefined,
    };
    const response = await handleVaultRequest(
      { type: "vault.request", id: "1", op: "set", ref: "profile:a", value: SECRET },
      fakeCrypto(),
      broken,
    );
    expect(response).toEqual({
      type: "vault.response",
      id: "1",
      ok: false,
      message: "couldn't read or write the key store",
    });
  });

  it("distinguishes absence, read, decrypt and OS encryption failures without exception text", async () => {
    const store = memoryStore();
    const request = { type: "vault.request", id: "read", op: "get", ref: "gateway" };
    const crypto = fakeCrypto();
    expect(await handleVaultRequest(request, crypto, store)).toMatchObject({ ok: true });
    const broken = async () => {
      throw new Error(`failed with ${SECRET} during ${request.id}`);
    };
    for (const [backend, entries, message] of [
      [crypto, { ...store, read: broken }, "couldn't read the key store"],
      [
        { ...crypto, decrypt: broken },
        { ...store, read: async () => ({ gateway: "cipher" }) },
        "couldn't decrypt the key in the key store",
      ],
      [
        { ...crypto, available: () => false },
        store,
        "OS encryption isn't available, so keys can't be stored",
      ],
      [{ ...crypto, available: broken }, store, "couldn't access OS encryption for the key store"],
    ] as const) {
      const response = await handleVaultRequest(request, backend, entries);
      expect(response).toMatchObject({ ok: false, message });
      expect(JSON.stringify(response)).not.toContain(SECRET);
    }
  });
});

describe("fileVaultStore", () => {
  let dir: string;
  afterEach(() => {
    disk.tornWrites = 0;
    disk.lockedRenames = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a private ciphertext file", async () => {
    dir = mkdtempSync(join(tmpdir(), "gram-vault-"));
    const file = join(dir, "nested", "gateway-keys.json");
    const store = fileVaultStore(file);
    expect(await store.read()).toEqual({});
    await handleVaultRequest(
      { type: "vault.request", id: "1", op: "set", ref: "profile:a", value: SECRET },
      fakeCrypto(),
      store,
    );
    expect(readFileSync(file, "utf8")).not.toContain(SECRET);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps the CLI password sentinel out of every vault file and response", async () => {
    dir = mkdtempSync(join(tmpdir(), "gram-vault-"));
    const sentinel = "QmFzZTY0S2V5Y2hhaW5TZW50aW5lbA==";
    const crypto = makeMacVaultCrypto(fakeCrypto(), "darwin", {
      signature: async () => "TeamIdentifier=not set\n",
      password: async () => Buffer.from(sentinel),
    });
    const store = fileVaultStore(join(dir, "gateway-keys.json"));
    const set = await handleVaultRequest(
      { type: "vault.request", id: "s", op: "set", ref: "a", value: SECRET },
      crypto,
      store,
    );
    const get = await handleVaultRequest(
      { type: "vault.request", id: "g", op: "get", ref: "a" },
      crypto,
      store,
    );
    expect(get).toMatchObject({ ok: true, value: SECRET });
    expect(JSON.stringify([set, get])).not.toContain(sentinel);
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text).not.toContain(sentinel);
      expect(text).not.toContain(SECRET);
    }
  });

  it("queues mutations from every store opened on one file", async () => {
    dir = mkdtempSync(join(tmpdir(), "gram-vault-"));
    const file = join(dir, "gateway-keys.json");
    const crypto = fakeCrypto();
    await Promise.all(
      ["profile:a", "profile:b", "profile:c"].map((ref) =>
        handleVaultRequest(
          { type: "vault.request", id: ref, op: "set", ref, value: SECRET },
          crypto,
          fileVaultStore(file),
        ),
      ),
    );
    expect(Object.keys(await fileVaultStore(file).read()).toSorted()).toEqual([
      "profile:a",
      "profile:b",
      "profile:c",
    ]);
  });

  it("leaves the previous file whole when a write fails partway, and no temp file behind", async () => {
    dir = mkdtempSync(join(tmpdir(), "gram-vault-"));
    const file = join(dir, "gateway-keys.json");
    const store = fileVaultStore(file);
    await store.write({ "profile:a": "Y2lwaGVy" });
    const before = readFileSync(file, "utf8");
    disk.tornWrites = 1;
    await expect(store.write({ "profile:a": "Y2lwaGVy", "profile:b": "bW9yZQ==" })).rejects.toThrow(
      "no space left on device",
    );
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["gateway-keys.json"]);
    expect(await store.read()).toEqual({ "profile:a": "Y2lwaGVy" });
  });

  it("retries a rename another process has the file locked against", async () => {
    dir = mkdtempSync(join(tmpdir(), "gram-vault-"));
    const file = join(dir, "gateway-keys.json");
    writeFileSync(file, "{}\n");
    const store = fileVaultStore(file);
    disk.lockedRenames = 2;
    await store.write({ "profile:a": "Y2lwaGVy" });
    expect(await store.read()).toEqual({ "profile:a": "Y2lwaGVy" });
    expect(readdirSync(dir)).toEqual(["gateway-keys.json"]);
  });
});
