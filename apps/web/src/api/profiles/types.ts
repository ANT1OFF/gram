import type {
  AgentKind,
  GatewayModel,
  GatewayProfile,
  HelperStatus,
  ModelList,
  ModelSuggestions,
  ProfileId,
  SeedProfilesResult,
  SetKeyResult,
  ThreadId,
  VaultInfo,
} from "@gram/contracts";

/** Gateway profiles and their keys, the models each agent offers, and the helper's budget and pause. */
export interface ProfilesApi {
  listProfiles(): Promise<readonly GatewayProfile[]>;
  /** Creates or updates a profile. `keyRef` is server-owned: `""` until a key is stored. */
  upsertProfile(profile: GatewayProfile): Promise<GatewayProfile>;
  /**
   * Stores the profile's API key on the server; `""` clears it. Nothing ever reads a key back. A
   * saved key discovers models and makes the profile the default when none is.
   */
  setProfileKey(profileId: ProfileId, key: string): Promise<SetKeyResult>;
  /** Where the server keeps keys, for Settings' status line. */
  vaultInfo(): Promise<VaultInfo>;
  /** Adds profiles from the OpenCode and Codex configs, only while none exist. */
  seedProfiles(): Promise<SeedProfilesResult>;
  /** Removes the profile and its stored key. */
  removeProfile(profileId: ProfileId): Promise<void>;
  /** `GET {baseURL}/models` with the stored key; the server saves the models on the profile too. */
  discoverProfileModels(profileId: ProfileId): Promise<readonly GatewayModel[]>;
  /** The server reads the key from OpenCode's `auth.json`; call only after the user consents. */
  importProfileKey(profileId: ProfileId): Promise<{ readonly imported: boolean }>;
  /** Today's helper-model usage against the budget, and why helpers are paused, if they are. */
  helperStatus(): Promise<HelperStatus>;
  /** The user is typing in a composer, so background helper jobs wait. */
  helperPresence(typing: boolean): Promise<void>;
  /** This window's threads with a composer draft, all of them: idle compaction waits on these. */
  composerDrafts(windowId: string, threadIds: readonly ThreadId[]): Promise<void>;
  listModels(agent: AgentKind, profileId?: ProfileId): Promise<ModelList>;
  /** Model ids the user's own agent config mentions, to offer as custom models. */
  modelSuggestions(): Promise<ModelSuggestions>;
}
