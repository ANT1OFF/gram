import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Encryption as Electron's `safeStorage` offers it: the macOS Keychain, Windows DPAPI for the user's
 * account, or a Linux keyring, which falls back to the unencrypted `basic_text` backend without one.
 */
export interface VaultCrypto {
  available(): boolean | Promise<boolean>;
  /** The storage backend `safeStorage` picked on Linux; absent on other platforms. */
  backend?(): string | undefined;
  encrypt(plainText: string): Buffer | Promise<Buffer>;
  decrypt(encrypted: Buffer): string | Promise<string>;
}

/** Where encrypted keys are kept, by ref, as base64 ciphertext. */
export interface VaultStore {
  read(): Promise<Record<string, string>>;
  write(entries: Record<string, string>): Promise<void>;
}

type VaultRequest =
  | {
      readonly type: "vault.request";
      readonly id: string;
      readonly op: "set";
      readonly ref: string;
      readonly value: string;
    }
  | {
      readonly type: "vault.request";
      readonly id: string;
      readonly op: "get" | "delete";
      readonly ref: string;
    }
  | {
      readonly type: "vault.request";
      readonly id: string;
      readonly op: "info";
    };

export type VaultResponse =
  | {
      readonly type: "vault.response";
      readonly id: string;
      readonly ok: true;
      readonly value?: string;
    }
  | {
      readonly type: "vault.response";
      readonly id: string;
      readonly ok: false;
      readonly message: string;
    };

const isVaultRequest = (message: unknown): message is VaultRequest => {
  const m = message as Partial<Record<string, unknown>> | null;
  return (
    typeof m === "object" &&
    m !== null &&
    m["type"] === "vault.request" &&
    typeof m["id"] === "string" &&
    (m["op"] === "info" ||
      (typeof m["ref"] === "string" &&
        (m["op"] === "get" ||
          m["op"] === "delete" ||
          (m["op"] === "set" && typeof m["value"] === "string"))))
  );
};

/** Error codes Windows gives a rename over a file another process (antivirus, backup) holds open. */
const LOCKED = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_ATTEMPTS = 5;

const renameOver = async (from: string, to: string): Promise<void> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (attempt === RENAME_ATTEMPTS || !LOCKED.has((error as { code?: string }).code ?? "")) {
        throw error;
      }
      await sleep(25 * attempt);
    }
  }
};

const fileStores = new Map<string, VaultStore>();

/**
 * A JSON file of ciphertext; plaintext keys never touch the disk. On POSIX the file is mode 0600;
 * Windows ignores POSIX modes, so there the user profile's ACL is what protects it. A write goes to
 * a temp file beside it that is renamed over it, so a crash leaves the old file or the new one,
 * never a torn one. Every call for one path returns the same store, so `handleVaultRequest` queues
 * its mutations together even across a server restart that makes a new one.
 */
export const fileVaultStore = (file: string): VaultStore => {
  const path = resolve(file);
  let store = fileStores.get(path);
  if (store === undefined) {
    store = openFileVaultStore(path);
    fileStores.set(path, store);
  }
  return store;
};

const openFileVaultStore = (file: string): VaultStore => ({
  read: async () => {
    try {
      return JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return {};
      throw error;
    }
  },
  write: async (entries) => {
    await mkdir(dirname(file), { recursive: true });
    const temp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
    try {
      // `wx` creates the file fresh, so it is 0600 from before its first byte.
      const handle = await open(temp, "wx", 0o600);
      try {
        await writeFile(handle, `${JSON.stringify(entries)}\n`);
        // Without the flush, a power cut after the rename can leave the new name on an empty file.
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameOver(temp, file);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  },
});

const mutations = new WeakMap<VaultStore, Promise<unknown>>();

/** Runs `mutate` once every earlier mutation of `store` has settled, so no two interleave. */
const serialised = <A>(store: VaultStore, mutate: () => Promise<A>): Promise<A> => {
  const run = (mutations.get(store) ?? Promise.resolve()).then(mutate);
  mutations.set(
    store,
    run.catch(() => undefined),
  );
  return run;
};

/**
 * Answers the server's key requests (sent over the utilityProcess port), or `undefined` for any
 * other message. Sets and deletes on one `store` run in request order, including asynchronous
 * backend selection and encryption; gets don't wait for them. Error messages never include a key.
 */
export async function handleVaultRequest(
  message: unknown,
  crypto: VaultCrypto,
  store: VaultStore,
): Promise<VaultResponse | undefined> {
  if (!isVaultRequest(message)) return undefined;
  const { id } = message;
  const fail = (text: string): VaultResponse => ({
    type: "vault.response",
    id,
    ok: false,
    message: text,
  });
  if (message.op === "info") {
    let backend: string | undefined;
    try {
      backend = crypto.backend?.();
    } catch {
      return fail("couldn't read the key store's backend");
    }
    return {
      type: "vault.response",
      id,
      ok: true,
      ...(backend === undefined ? {} : { value: backend }),
    };
  }
  const run = async (): Promise<VaultResponse> => {
    try {
      if (!(await crypto.available()))
        return fail("OS encryption isn't available, so keys can't be stored");
    } catch {
      // Backend selection can fail before a read; report its stage without the OS exception.
      return fail("couldn't access OS encryption for the key store");
    }
    switch (message.op) {
      case "set": {
        const encrypted = (await crypto.encrypt(message.value)).toString("base64");
        await store.write({ ...(await store.read()), [message.ref]: encrypted });
        return { type: "vault.response", id, ok: true };
      }
      case "get": {
        let encrypted: string | undefined;
        try {
          encrypted = (await store.read())[message.ref];
        } catch {
          // JSON/parser and filesystem errors may carry file contents: expose only the stage.
          return fail("couldn't read the key store");
        }
        if (encrypted === undefined) return { type: "vault.response", id, ok: true };
        try {
          return {
            type: "vault.response",
            id,
            ok: true,
            value: await crypto.decrypt(Buffer.from(encrypted, "base64")),
          };
        } catch {
          // OS errors are opaque and may contain credentials; the stage is enough to diagnose.
          return fail("couldn't decrypt the key in the key store");
        }
      }
      case "delete": {
        const { [message.ref]: _removed, ...rest } = await store.read();
        await store.write(rest);
        return { type: "vault.response", id, ok: true };
      }
    }
  };
  try {
    // Reserve the mutation's position before selection or encryption can yield to a later delete.
    return await (message.op === "get" ? run() : serialised(store, run));
  } catch {
    return fail("couldn't read or write the key store");
  }
}
