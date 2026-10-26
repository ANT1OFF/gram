import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { KeybindingOverrides, KeybindingsState } from "../depth.ts";
import { AgentKind, GatewayModel, GatewayProfile, Label } from "../domain.ts";
import { AgentUnavailable, GatewayError, InvalidState, NotFound } from "../errors.ts";
import { SeedProfilesResult, SetKeyResult, VaultInfo } from "../gateway-keys.ts";
import { HelperPresenceFields, HelperStatus } from "../helper.ts";
import { LabelId, PaletteId, ProfileId, ThreadId } from "../ids.ts";
import { ModelList, ModelSuggestions } from "../models.ts";
import { Palette, Settings, SettingsPatch } from "../settings.ts";
import { errors } from "./shared.ts";

/** Settings and the user's own entities: palettes, labels, keybindings, gateway profiles and their models, and the helper. */
export const SettingsRpcs = RpcGroup.make(
  Rpc.make("models.list", {
    payload: { agent: AgentKind, profileId: Schema.optionalKey(ProfileId) },
    success: ModelList,
    error: errors(AgentUnavailable),
  }),
  /** Model ids the user's own agent config mentions; empty when there is nothing to read. */
  Rpc.make("models.suggestions", { success: ModelSuggestions, error: errors() }),
  /** The overrides in `keybindings.json` in the data dir; changes arrive as `keybindings.changed`. */
  Rpc.make("keybindings.get", { success: KeybindingsState, error: errors() }),
  /** Replaces every override and rewrites the file. */
  Rpc.make("keybindings.set", {
    payload: { bindings: KeybindingOverrides },
    success: KeybindingsState,
    error: errors(InvalidState),
  }),
  Rpc.make("settings.get", { success: Settings, error: errors() }),
  Rpc.make("settings.set", {
    payload: { patch: SettingsPatch },
    success: Settings,
    error: errors(InvalidState),
  }),
  /** Today's helper-model usage against the budget, and why helpers are paused, if they are. */
  Rpc.make("helper.status", { success: HelperStatus, error: errors() }),
  /** Whether the user is typing in a composer; background helper jobs wait while they are. */
  Rpc.make("helper.presence", { payload: HelperPresenceFields, error: errors() }),
  /**
   * One window's threads with a composer draft, all of them, on every change and every 30 s while
   * there are any; empty when it has none or closes. Idle compaction never runs on a thread with
   * one, or while a window that had one has gone quiet. Thread ids only, never the text.
   */
  Rpc.make("composer.drafts", {
    payload: { windowId: Schema.String, threadIds: Schema.Array(ThreadId) },
    error: errors(),
  }),
  Rpc.make("profiles.list", { success: Schema.Array(GatewayProfile), error: errors() }),
  /** Rejects a name or base URL with a control character (a line break, say). */
  Rpc.make("profiles.upsert", {
    payload: { profile: GatewayProfile },
    success: GatewayProfile,
    error: errors(GatewayError),
  }),
  /**
   * Stores the key (an empty one clears it). A saved key then discovers models, makes the profile
   * the default when none is, and applies to new sessions; idle ones reopen with it.
   */
  Rpc.make("profiles.setKey", {
    payload: { profileId: ProfileId, key: Schema.RedactedFromValue(Schema.String) },
    success: SetKeyResult,
    error: errors(NotFound, GatewayError),
  }),
  /** Where keys are stored, for Settings' status line. */
  Rpc.make("profiles.vaultInfo", { success: VaultInfo, error: errors() }),
  /** Adds profiles from the OpenCode and Codex configs, only while none exist. */
  Rpc.make("profiles.seed", { success: SeedProfilesResult, error: errors() }),
  Rpc.make("profiles.remove", { payload: { profileId: ProfileId }, error: errors(NotFound) }),
  Rpc.make("profiles.discoverModels", {
    payload: { profileId: ProfileId },
    success: Schema.Array(GatewayModel),
    error: errors(NotFound, GatewayError),
  }),
  /**
   * Imports the key another tool already stores for the provider on the profile's base URL (OpenCode:
   * `~/.local/share/opencode/auth.json`). The server reads that file only when this RPC runs, after
   * the user consents in the UI. The key never reaches the client.
   */
  Rpc.make("profiles.importKey", {
    payload: { profileId: ProfileId, source: Schema.Literals(["opencode"]) },
    success: Schema.Struct({ imported: Schema.Boolean }),
    error: errors(NotFound, GatewayError),
  }),
  Rpc.make("palettes.list", { success: Schema.Array(Palette), error: errors() }),
  Rpc.make("palettes.upsert", { payload: { palette: Palette }, success: Palette, error: errors() }),
  Rpc.make("palettes.remove", {
    payload: { paletteId: PaletteId },
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("labels.list", { success: Schema.Array(Label), error: errors() }),
  Rpc.make("labels.upsert", { payload: { label: Label }, success: Label, error: errors() }),
  Rpc.make("labels.remove", { payload: { labelId: LabelId }, error: errors(NotFound) }),
);
