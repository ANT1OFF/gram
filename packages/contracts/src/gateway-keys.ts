import * as Schema from "effect/Schema";

/** Where gateway keys are kept, so Settings can say it plainly. */
export const VaultInfo = Schema.Struct({
  /**
   * What protects keys under Electron `safeStorage`: the macOS Keychain, Windows DPAPI for the
   * user's account, or a Linux keyring. `unencrypted` when Linux has no keyring and `safeStorage`
   * falls back to `basic_text`; `memory` in browser dev, where nothing is saved.
   */
  kind: Schema.Literals(["keychain", "dpapi", "libsecret", "unencrypted", "memory"]),
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
