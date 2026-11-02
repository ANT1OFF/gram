import * as Schema from "effect/Schema";

/**
 * The `safeStorage` backends on Linux that encrypt with a real keyring: the Secret Service (GNOME
 * Keyring, KeePassXC and others) and KWallet. `basic_text`, its fallback without one, encrypts with
 * a key hard-coded in Chromium, which is plaintext to anyone who can read the file.
 */
export const KEYRING_BACKENDS: ReadonlySet<string> = new Set([
  "gnome_libsecret",
  "kwallet",
  "kwallet5",
  "kwallet6",
]);

/**
 * Whether Linux's `safeStorage` `backend` is a real keyring. Absent, `unknown` (before `ready`, or
 * a backend Electron added since) and `unavailable` are not: a key is never stored where it isn't
 * known to be encrypted. Only Linux asks; callers decide that from the platform, not from this.
 */
export const keyringBackendOk = (backend: string | undefined): boolean =>
  backend !== undefined && KEYRING_BACKENDS.has(backend);

/** Why a key can't be saved on Linux without a keyring, for the vault's error and for Settings. */
export const NO_KEYRING_MESSAGE =
  "No system keyring is available, so Gram won't store API keys. Install or unlock GNOME Keyring " +
  "or KWallet (on other desktops, start Gram with --password-store=gnome-libsecret), then restart " +
  "Gram.";

/** Where gateway keys are kept, so Settings can say it plainly. */
export const VaultInfo = Schema.Struct({
  /**
   * What protects keys under Electron `safeStorage`: the macOS Keychain, Windows DPAPI for the
   * user's account, or a Linux keyring. `no-keyring` when Linux has none, where keys aren't stored
   * at all (never in `basic_text`, which doesn't encrypt); `memory` in browser dev, where nothing
   * is saved.
   */
  kind: Schema.Literals(["keychain", "dpapi", "libsecret", "no-keyring", "memory"]),
  /** False when keys are lost once the server stops (browser dev without the desktop app). */
  persisted: Schema.Boolean,
  /** The store in words, e.g. "the macOS Keychain". */
  label: Schema.String,
});
export type VaultInfo = typeof VaultInfo.Type;

/** What saving a key set off: model discovery, and the profile becoming the default. */
export const SetKeyResult = Schema.Struct({
  /** Models found once the key was saved. */
  discovered: Schema.optionalKey(Schema.Int),
  /** Why discovery failed; the key is saved regardless. */
  discoveryError: Schema.optionalKey(Schema.String),
  /** No profile was the default, so this one became it. */
  madeDefault: Schema.optionalKey(Schema.Boolean),
});
export type SetKeyResult = typeof SetKeyResult.Type;

export const SeedProfilesResult = Schema.Struct({
  /** Profiles added from the OpenCode and Codex configs; 0 when some already existed. */
  added: Schema.Int,
});
export type SeedProfilesResult = typeof SeedProfilesResult.Type;
