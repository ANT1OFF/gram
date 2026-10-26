import { randomUUID } from "node:crypto";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

/** A failure to store or read a key. Messages never contain the key. */
export class VaultError extends Data.TaggedError("VaultError")<{ readonly message: string }> {}

/** Gateway keys by ref. A key only ever leaves the vault towards its gateway. */
export interface KeyVault {
  readonly kind: "safeStorage" | "memory";
  /** The storage backend `safeStorage` picked on Linux (e.g. `gnome_libsecret`, `basic_text`). */
  readonly backend: Effect.Effect<string | undefined, VaultError>;
  set(ref: string, key: Redacted.Redacted<string>): Effect.Effect<void, VaultError>;
  get(ref: string): Effect.Effect<Option.Option<Redacted.Redacted<string>>, VaultError>;
  remove(ref: string): Effect.Effect<void, VaultError>;
}

/** The ref a profile's key is stored under. */
export const profileKeyRef = (profileId: string) => `profile:${profileId}`;

// ---------------------------------------------------------------------------------------------
// Electron bridge: the server asks desktop main, which owns `safeStorage`.

export type VaultRequest =
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

type VaultResponse =
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

const isVaultResponse = (message: unknown): message is VaultResponse =>
  typeof message === "object" &&
  message !== null &&
  (message as { type?: unknown }).type === "vault.response" &&
  typeof (message as { id?: unknown }).id === "string";

/** Electron's `process.parentPort` as the server sees it. */
export interface VaultPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { readonly data: unknown }) => void): unknown;
}

// Main may wait up to 30 seconds for the one-time macOS keychain permission, after a PATH probe.
const BRIDGE_TIMEOUT_MS = 60_000;

export const makeBridgeVault = (
  port: VaultPort,
  timeoutMs: number = BRIDGE_TIMEOUT_MS,
): KeyVault => {
  const pending = new Map<string, (response: VaultResponse) => void>();
  port.on("message", ({ data }) => {
    if (!isVaultResponse(data)) return;
    pending.get(data.id)?.(data);
    pending.delete(data.id);
  });

  const call = (
    request:
      | { op: "set"; ref: string; value: string }
      | { op: "get" | "delete"; ref: string }
      | { op: "info" },
  ) =>
    Effect.tryPromise({
      try: () =>
        new Promise<VaultResponse>((resolve, reject) => {
          const id = randomUUID();
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error("the desktop app didn't answer the key request"));
          }, timeoutMs);
          pending.set(id, (response) => {
            clearTimeout(timer);
            resolve(response);
          });
          port.postMessage({ type: "vault.request", id, ...request });
        }),
      catch: (error) =>
        new VaultError({ message: error instanceof Error ? error.message : "key request failed" }),
    }).pipe(
      Effect.flatMap((response) =>
        response.ok
          ? Effect.succeed(response.value)
          : Effect.fail(new VaultError({ message: response.message })),
      ),
    );

  return {
    kind: "safeStorage",
    backend: call({ op: "info" }),
    set: (ref, key) => call({ op: "set", ref, value: Redacted.value(key) }).pipe(Effect.asVoid),
    get: (ref) =>
      call({ op: "get", ref }).pipe(
        Effect.map((value) =>
          value === undefined ? Option.none() : Option.some(Redacted.make(value)),
        ),
      ),
    remove: (ref) => call({ op: "delete", ref }).pipe(Effect.asVoid),
  };
};

// ---------------------------------------------------------------------------------------------
// Browser dev mode: no Electron, so no safeStorage. Keys live only while the server runs.

export const makeMemoryVault = (initial: Record<string, string> = {}): KeyVault => {
  const keys = new Map(Object.entries(initial));
  return {
    kind: "memory",
    backend: Effect.succeed(undefined),
    set: (ref, key) => Effect.sync(() => void keys.set(ref, Redacted.value(key))),
    get: (ref) =>
      Effect.sync(() => Option.fromNullishOr(keys.get(ref)).pipe(Option.map(Redacted.make))),
    remove: (ref) => Effect.sync(() => void keys.delete(ref)),
  };
};
