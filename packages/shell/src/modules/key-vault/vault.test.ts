import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NO_KEYRING_MESSAGE } from "@gram/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fileVaultStore, handleVaultRequest, type VaultCrypto, type VaultStore } from "./vault.ts";

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

/** `handleVaultRequest` on macOS's rules unless a test names another platform. */
const handle = (
  message: unknown,
  crypto: VaultCrypto,
  store: VaultStore,
  platform: NodeJS.Platform = "darwin",
) => handleVaultRequest(message, crypto, store, platform);

/** A Linux keyring's crypto: Chromium's `v11` prefix before the ciphertext. */
const linuxKeyringCrypto = (backend = "kwallet6"): VaultCrypto => {
  const inner = fakeCrypto();
  return {
    available: () => true,
    backend: () => backend,
    encrypt: async (plain) => Buffer.concat([Buffer.from("v11"), await inner.encrypt(plain)]),
    decrypt: (encrypted) => inner.decrypt(encrypted.subarray(3)),
  };
};

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

describe("handleVaultRequest", () => {
  it("refuses to store or read a key on a Linux backend that doesn't encrypt", async () => {
    for (const backend of ["basic_text", "unknown", "unavailable", undefined]) {
      const store = memoryStore();
      const write = vi.spyOn(store, "write");
      const crypto = { ...fakeCrypto(), backend: () => backend };
      const encrypt = vi.spyOn(crypto, "encrypt");
      const set = await handle(
        { type: "vault.request", id: "s", op: "set", ref: "r", value: "sk-secret" },
        crypto,
        store,
        "linux",
      );
      expect(set).toEqual({
        type: "vault.response",
        id: "s",
        ok: false,
        message: NO_KEYRING_MESSAGE,
      });
      expect(encrypt).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      const get = await handle(
        { type: "vault.request", id: "g", op: "get", ref: "r" },
        crypto,
        store,
        "linux",
      );
      expect(get).toMatchObject({ ok: false, message: NO_KEYRING_MESSAGE });
    }
  });

  it("decides the Linux rules from the platform, not from whether a backend is named", async () => {
    // A Linux crypto that names no backend is still Linux: refused.
    const unnamed = { ...fakeCrypto() };
    const refused = await handle(
      { type: "vault.request", id: "s", op: "set", ref: "r", value: "sk-secret" },
      unnamed,
      memoryStore(),
      "linux",
    );
    expect(refused).toMatchObject({ ok: false, message: NO_KEYRING_MESSAGE });
    // And macOS keeps its own rules even if something names a Linux backend.
    const named = { ...fakeCrypto(), backend: () => "basic_text" };
    const stored = await handle(
      { type: "vault.request", id: "s", op: "set", ref: "r", value: "sk-secret" },
      named,
      memoryStore(),
      "darwin",
    );
    expect(stored).toEqual({ type: "vault.response", id: "s", ok: true });
  });

  it("still removes a key without a keyring", async () => {
    const store = memoryStore();
    await store.write({ r: "c2VjcmV0" });
    const crypto = { ...fakeCrypto(), available: () => false, backend: () => "unavailable" };
    await handle(
      { type: "vault.request", id: "d", op: "delete", ref: "r" },
      crypto,
      store,
      "linux",
    );
    expect(await store.read()).toEqual({});
  });

  it("stores and reads a key with a real keyring backend, as v11 ciphertext", async () => {
    for (const backend of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]) {
      const store = memoryStore();
      const crypto = linuxKeyringCrypto(backend);
      const set = await handle(
        { type: "vault.request", id: "s", op: "set", ref: "r", value: "sk-secret" },
        crypto,
        store,
        "linux",
      );
      expect(set).toEqual({ type: "vault.response", id: "s", ok: true });
      expect(Buffer.from(store.entries["r"]!, "base64").subarray(0, 3).toString()).toBe("v11");
      const get = await handle(
        { type: "vault.request", id: "g", op: "get", ref: "r" },
        crypto,
        store,
        "linux",
      );
      expect(get).toEqual({ type: "vault.response", id: "g", ok: true, value: "sk-secret" });
    }
  });

  it("refuses ciphertext a Linux keyring encrypted with the fallback key", async () => {
    const store = memoryStore();
    const write = vi.spyOn(store, "write");
    const inner = fakeCrypto();
    const fallback: VaultCrypto = {
      ...linuxKeyringCrypto(),
      encrypt: async (plain) => Buffer.concat([Buffer.from("v10"), await inner.encrypt(plain)]),
    };
    const set = await handle(
      { type: "vault.request", id: "s", op: "set", ref: "r", value: "sk-secret" },
      fallback,
      store,
      "linux",
    );
    expect(set).toMatchObject({ ok: false, message: NO_KEYRING_MESSAGE });
    expect(write).not.toHaveBeenCalled();
  });

  it("purges v10 and unprefixed entries on Linux, unread, and keeps v11 ones", async () => {
    const store = memoryStore();
    const crypto = linuxKeyringCrypto();
    const decrypt = vi.spyOn(crypto, "decrypt");
    const v10 = Buffer.concat([Buffer.from("v10"), Buffer.from("weak")]).toString("base64");
    const bare = Buffer.from("plain").toString("base64");
    await store.write({ old: v10, other: bare });
    const get = await handle(
      { type: "vault.request", id: "g", op: "get", ref: "old" },
      crypto,
      store,
      "linux",
    );
    expect(get).toEqual({ type: "vault.response", id: "g", ok: true });
    expect(decrypt).not.toHaveBeenCalled();
    expect(await store.read()).toEqual({});
    // A set drops any left too, keeping the new v11 entry.
    await store.write({ old: v10 });
    await handle(
      { type: "vault.request", id: "s", op: "set", ref: "r", value: "sk-secret" },
      crypto,
      store,
      "linux",
    );
    expect(Object.keys(await store.read())).toEqual(["r"]);
  });

  it("purges a malformed entry instead of failing every Linux write", async () => {
    const store = memoryStore();
    store.entries = { bad: 42 } as unknown as Record<string, string>;
    const crypto = linuxKeyringCrypto();
    const set = await handle(
      { type: "vault.request", id: "s", op: "set", ref: "r", value: "sk-secret" },
      crypto,
      store,
      "linux",
    );
    expect(set).toEqual({ type: "vault.response", id: "s", ok: true });
    expect(Object.keys(await store.read())).toEqual(["r"]);
    store.entries = { r: 7 } as unknown as Record<string, string>;
    const get = await handle(
      { type: "vault.request", id: "g", op: "get", ref: "r" },
      crypto,
      store,
      "linux",
    );
    expect(get).toEqual({ type: "vault.response", id: "g", ok: true });
    expect(await store.read()).toEqual({});
  });

  it("leaves macOS's v10 ciphertext alone", async () => {
    const store = memoryStore();
    const v10 = Buffer.concat([Buffer.from("v10"), Buffer.from("mac")]).toString("base64");
    await store.write({ r: v10 });
    const crypto = { ...fakeCrypto(), decrypt: () => "sk-mac" };
    const get = await handle(
      { type: "vault.request", id: "g", op: "get", ref: "r" },
      crypto,
      store,
      "darwin",
    );
    expect(get).toEqual({ type: "vault.response", id: "g", ok: true, value: "sk-mac" });
    expect(await store.read()).toEqual({ r: v10 });
  });

  it("reports the Linux storage backend, and nothing where there is none to report", async () => {
    const store = memoryStore();
    const linux = { ...fakeCrypto(), backend: () => "basic_text" };
    expect(await handle({ type: "vault.request", id: "i1", op: "info" }, linux, store)).toEqual({
      type: "vault.response",
      id: "i1",
      ok: true,
      value: "basic_text",
    });
    expect(
      await handle({ type: "vault.request", id: "i2", op: "info" }, fakeCrypto(), store),
    ).toEqual({ type: "vault.response", id: "i2", ok: true });
  });

  it("sets, gets and deletes keys, storing only ciphertext", async () => {
    const store = memoryStore();
    const crypto = fakeCrypto();
    expect(
      await handle(
        { type: "vault.request", id: "1", op: "set", ref: "profile:a", value: SECRET },
        crypto,
        store,
      ),
    ).toEqual({ type: "vault.response", id: "1", ok: true });
    expect(JSON.stringify(store.entries)).not.toContain(SECRET);

    expect(
      await handle({ type: "vault.request", id: "2", op: "get", ref: "profile:a" }, crypto, store),
    ).toEqual({
      type: "vault.response",
      id: "2",
      ok: true,
      value: SECRET,
    });
    await handle({ type: "vault.request", id: "3", op: "delete", ref: "profile:a" }, crypto, store);
    expect(
      await handle({ type: "vault.request", id: "4", op: "get", ref: "profile:a" }, crypto, store),
    ).toEqual({
      type: "vault.response",
      id: "4",
      ok: true,
    });
  });

  it("refuses without OS encryption and ignores other messages", async () => {
    const response = await handle(
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
      expect(await handle(other, fakeCrypto(), memoryStore())).toBeUndefined();
    }
  });

  it("never lets one read-modify-write overwrite another", async () => {
    const store = memoryStore();
    const crypto = fakeCrypto();
    const set = (ref: string) =>
      handle({ type: "vault.request", id: ref, op: "set", ref, value: SECRET }, crypto, store);
    await set("profile:gone");
    await Promise.all([
      set("profile:a"),
      set("profile:b"),
      handle({ type: "vault.request", id: "d", op: "delete", ref: "profile:gone" }, crypto, store),
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
      const set = handle(
        { type: "vault.request", id: "s", op: "set", ref: "profile:a", value: SECRET },
        crypto,
        store,
      );
      if (stage !== "synchronous") await entered.promise;
      const remove = handle(
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
      handle(
        { type: "vault.request", id: "s", op: "set", ref: "profile:a", value: SECRET },
        crypto,
        store,
      ),
      handle({ type: "vault.request", id: "d", op: "delete", ref: "profile:a" }, crypto, store),
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
    const response = await handle(
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
    expect(await handle(request, crypto, store)).toMatchObject({ ok: true });
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
      const response = await handle(request, backend, entries);
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
    await handle(
      { type: "vault.request", id: "1", op: "set", ref: "profile:a", value: SECRET },
      fakeCrypto(),
      store,
    );
    expect(readFileSync(file, "utf8")).not.toContain(SECRET);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("queues mutations from every store opened on one file", async () => {
    dir = mkdtempSync(join(tmpdir(), "gram-vault-"));
    const file = join(dir, "gateway-keys.json");
    const crypto = fakeCrypto();
    await Promise.all(
      ["profile:a", "profile:b", "profile:c"].map((ref) =>
        handle(
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
