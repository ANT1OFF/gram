import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { KeybindingOverrides, KeybindingsState } from "../depth.ts";
import { AgentKind, GatewayModel, GatewayProfile, Label } from "../domain.ts";
import { AgentUnavailable, GatewayError, InvalidState, NotFound } from "../errors.ts";
import {
  OpenRouterSignInResult,
  SeedProfilesResult,
  SetKeyResult,
  VaultInfo,
} from "../gateway-keys.ts";
import { HelperPresenceFields, HelperStatus } from "../helper.ts";
import { LabelId, PaletteId, ProfileId, ThreadId } from "../ids.ts";
import { ModelList, ModelSuggestions } from "../models.ts";
import { Palette, Settings, SettingsPatch } from "../settings.ts";
import { errors } from "./shared.ts";

/** Settings and the user's own entities: palettes, labels, keybindings, gateway profiles and their models, and the helper. */
/** `people.names`'s answer. */
export const PeopleNames = Schema.Struct({
  /** The caller, by the subject fronted sign-in names them with; absent without one. */
  you: Schema.optionalKey(Schema.String),
  people: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});
export type PeopleNames = typeof PeopleNames.Type;

export const SettingsRpcs = RpcGroup.make(
  Rpc.make("models.list", {
    payload: { agent: AgentKind, profileId: Schema.optionalKey(ProfileId) },
    success: ModelList,
    error: errors(AgentUnavailable),
  }),
  Rpc.make("models.suggestions", { success: ModelSuggestions, error: errors() }),
  Rpc.make("keybindings.get", { success: KeybindingsState, error: errors() }),
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
  Rpc.make("helper.status", { success: HelperStatus, error: errors() }),
  Rpc.make("helper.presence", { payload: HelperPresenceFields, error: errors() }),
  Rpc.make("composer.drafts", {
    payload: { windowId: Schema.String, threadIds: Schema.Array(ThreadId) },
    error: errors(),
  }),
  Rpc.make("profiles.list", { success: Schema.Array(GatewayProfile), error: errors() }),
  Rpc.make("profiles.upsert", {
    payload: { profile: GatewayProfile },
    success: GatewayProfile,
    error: errors(GatewayError),
  }),
  Rpc.make("profiles.setKey", {
    payload: { profileId: ProfileId, key: Schema.RedactedFromValue(Schema.String) },
    success: SetKeyResult,
    error: errors(NotFound, GatewayError),
  }),
  Rpc.make("profiles.vaultInfo", { success: VaultInfo, error: errors() }),
  Rpc.make("profiles.seed", { success: SeedProfilesResult, error: errors() }),
  Rpc.make("profiles.remove", { payload: { profileId: ProfileId }, error: errors(NotFound) }),
  Rpc.make("profiles.discoverModels", {
    payload: { profileId: ProfileId },
    success: Schema.Array(GatewayModel),
    error: errors(NotFound, GatewayError),
  }),
  Rpc.make("profiles.importKey", {
    payload: { profileId: ProfileId, source: Schema.Literals(["opencode"]) },
    success: Schema.Struct({ imported: Schema.Boolean }),
    error: errors(NotFound, GatewayError),
  }),
  Rpc.make("profiles.openRouterSignIn", {
    success: Schema.Struct({ attemptId: Schema.String, url: Schema.String }),
    error: errors(GatewayError),
  }),
  Rpc.make("profiles.openRouterFinish", {
    payload: { attemptId: Schema.String },
    success: OpenRouterSignInResult,
    error: errors(NotFound, GatewayError),
  }),
  Rpc.make("palettes.list", { success: Schema.Array(Palette), error: errors() }),
  Rpc.make("palettes.upsert", { payload: { palette: Palette }, success: Palette, error: errors() }),
  Rpc.make("palettes.remove", {
    payload: { paletteId: PaletteId },
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("people.names", {
    payload: {
      ids: Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(
        Schema.isMaxLength(200),
      ),
    },
    success: PeopleNames,
    error: errors(),
  }),
  Rpc.make("labels.list", { success: Schema.Array(Label), error: errors() }),
  Rpc.make("labels.upsert", { payload: { label: Label }, success: Label, error: errors() }),
  Rpc.make("labels.remove", { payload: { labelId: LabelId }, error: errors(NotFound) }),
);
