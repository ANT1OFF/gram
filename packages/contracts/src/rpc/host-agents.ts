// What a host reports of the agent CLIs on its machine: their models, and Codex's, OpenCode's and
// Grok Build's own status.

import * as Schema from "effect/Schema";
import { ReasoningVariant } from "../domain.ts";

const HostModelText = Schema.String.check(Schema.isMaxLength(128));

/**
 * A model the machine's Claude Code lists, as much as resolving a recommended tier on it needs:
 * its id, the id an alias runs, its name and the efforts it takes. Nothing about the account.
 */
export const HostModel = Schema.Struct({
  id: HostModelText,
  displayName: HostModelText,
  resolvedId: Schema.optionalKey(HostModelText),
  supportsEffort: Schema.Boolean,
  efforts: Schema.optionalKey(Schema.Array(ReasoningVariant).check(Schema.isMaxLength(8))),
  /**
   * The model the agent picks when none is named, and the speeds and inputs it takes, as its
   * picker shows them. Absent from a host before 1.27; a control plane built before them ignores
   * them.
   */
  isDefault: Schema.optionalKey(Schema.Boolean),
  speeds: Schema.optionalKey(
    Schema.Array(Schema.Literals(["standard", "fast"])).check(Schema.isMaxLength(2)),
  ),
  inputModalities: Schema.optionalKey(
    Schema.Array(Schema.Literals(["text", "image"])).check(Schema.isMaxLength(2)),
  ),
});
export type HostModel = typeof HostModel.Type;

/**
 * The machine's Codex as its host finds it: whether `codex` is there, how it is signed in (the
 * classification alone), what it lists, and whether it can hold Gram's outward gate (its native
 * home is prepared) and run Codex's own Auto reviewer.
 */
export const HostCodexStatus = Schema.Struct({
  found: Schema.Boolean,
  version: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  /** `signedIn` is a ChatGPT login; `apiKey` an API key or a provider of the machine's own. */
  signIn: Schema.Literals(["signedIn", "notSignedIn", "apiKey", "unknown"]),
  /** Absent when Codex couldn't list. */
  models: Schema.optionalKey(Schema.Array(HostModel).check(Schema.isMaxLength(64))),
  gateReady: Schema.Boolean,
  autoReview: Schema.Boolean,
});
export type HostCodexStatus = typeof HostCodexStatus.Type;

/**
 * The machine's OpenCode as its host finds it: whether `opencode` is there, its version, and what
 * it lists (`provider/model` ids, from the providers its own config names). Nothing of a key.
 */
export const HostOpenCodeStatus = Schema.Struct({
  found: Schema.Boolean,
  version: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  /** Absent when OpenCode couldn't list. */
  models: Schema.optionalKey(Schema.Array(HostModel).check(Schema.isMaxLength(64))),
});
export type HostOpenCodeStatus = typeof HostOpenCodeStatus.Type;

/**
 * The machine's Grok Build as its host finds it: whether `grok` is there, its version, and the
 * models it lists. Nothing of a login.
 */
export const HostGrokStatus = Schema.Struct({
  found: Schema.Boolean,
  version: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  /** Absent when Grok Build couldn't list. */
  models: Schema.optionalKey(Schema.Array(HostModel).check(Schema.isMaxLength(64))),
});
export type HostGrokStatus = typeof HostGrokStatus.Type;
