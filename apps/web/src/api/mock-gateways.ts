import {
  gatewayAgentModel,
  gatewayModelUsable,
  type AgentKind,
  type AgentModel,
  type GatewayModel,
  type GatewayProfile,
  type HelperStatus,
  type ModelList,
  type ProfileId,
  type SeedProfilesResult,
  type SetKeyResult,
  type VaultInfo,
} from "@gram/contracts";

import { mockLaunchChecks } from "./mock-launch-checks";

/** A thrown contract error as the rpc api rejects: `_tag` plus the error's fields. */
const tagged = (tag: string, fields: Record<string, unknown> & { message: string }) =>
  Object.assign(new Error(fields.message), { _tag: tag, ...fields });

const SEEDED: GatewayProfile[] = [
  {
    id: "litellm" as ProfileId,
    name: "Personal Gateway",
    baseURL: "https://llm.example.test/v1",
    keyRef: "",
    models: [
      { id: "gpt-5.5", name: "GPT-5.5", variants: ["low", "medium", "high"] },
      { id: "claude-sonnet", name: "Claude Sonnet (gateway)" },
    ],
    default: true,
  },
];

/** What `profiles.seed` finds in the OpenCode and Codex configs in the mock. */
const IMPORTABLE: GatewayProfile = {
  id: "litellm" as ProfileId,
  name: "LiteLLM",
  baseURL: "https://personal.example.invalid/v1",
  keyRef: "",
  models: [],
};

/** What `GET {baseURL}/models` answers in the mock. */
const DISCOVERED: GatewayModel[] = [
  { id: "gpt-5.5", name: "GPT-5.5", variants: ["low", "medium", "high"] },
  {
    id: "gpt-5.6-sol",
    name: "gpt-5.6-sol",
    info: { mode: "chat", tools: true, reasoning: true, xhighEffort: true, maxEffort: true },
  },
  { id: "claude-sonnet", name: "Claude Sonnet (gateway)" },
];

/** A morning's helper use in the mock: titles and plans on Haiku 5.5, one Luna fallback. */
const HELPER_STATUS: HelperStatus = {
  providers: [
    {
      provider: "claude",
      state: "ready",
      detail: "Synthetic preview: CLI discovery; actual access is decided by the provider.",
      models: [
        {
          id: "haiku",
          resolvedId: "claude-haiku-5-5",
          displayName: "Haiku 5.5",
          supportsEffort: true,
          efforts: ["low", "medium", "high"],
        },
      ],
    },
    {
      provider: "codex",
      state: "ready",
      mode: "guided",
      detail:
        "Synthetic preview: guided subscription generation; residual native tools and CLI host instructions/skills may participate.",
      models: [
        {
          id: "gpt-6-luna",
          displayName: "GPT-6 Luna",
          supportsEffort: true,
          efforts: ["low", "medium", "high"],
        },
      ],
    },
  ],
  day: "2026-10-01",
  calls: 42,
  inputTokens: 151_200,
  outputTokens: 24_600,
  costUsd: 0.0301,
  failures: 1,
  lines: [
    {
      kind: "plan",
      model: "claude-haiku-5.5-eu",
      calls: 30,
      inputTokens: 120_000,
      outputTokens: 21_000,
      costUsd: 0.02475,
      failures: 0,
    },
    {
      kind: "title",
      model: "claude-haiku-5.5-eu",
      calls: 11,
      inputTokens: 30_000,
      outputTokens: 3_300,
      costUsd: 0.005115,
      failures: 1,
    },
    {
      kind: "title",
      model: "gpt-6-luna",
      calls: 1,
      inputTokens: 1_200,
      outputTokens: 300,
      costUsd: 0.00027,
      failures: 0,
    },
  ],
  dailyBudgetUsd: 2,
  suggestions: {
    since: "2026-09-25",
    shown: 34,
    taken: 9,
    accepted: 7,
    wordAccepted: 2,
    editedAfter: 1,
    dismissed: 5,
  },
};

const VAULT: VaultInfo = { kind: "keychain", persisted: true, label: "the macOS Keychain" };

/** A gateway model as the composer's model picker lists it. */
export const toAgentModel = (
  model: GatewayModel,
  agent: AgentKind,
  isDefault: boolean,
): AgentModel => ({
  ...gatewayAgentModel(model, agent),
  ...(isDefault ? { isDefault: true } : {}),
});

/**
 * In-memory `profiles.*` for MockApi, with the server's semantics: `keyRef` is server-owned and
 * `""` means no key is stored; a default profile clears the flag on the others. `onChange` runs
 * wherever the server publishes `profiles.changed`.
 */
export function createMockGateways(
  options: { agents?: readonly AgentKind[]; onChange?: () => void } = {},
) {
  const agents = new Set<AgentKind>(options.agents ?? ["claude"]);
  const changed = options.onChange ?? (() => {});
  const profiles = new Map<string, GatewayProfile>(SEEDED.map((p) => [p.id, p]));

  const find = (profileId: ProfileId) => {
    const profile = profiles.get(profileId);
    if (!profile) {
      throw tagged("NotFound", {
        entity: "profile",
        id: profileId,
        message: `No gateway ${profileId}`,
      });
    }
    return profile;
  };

  return {
    listProfiles: async (): Promise<readonly GatewayProfile[]> => [...profiles.values()],
    upsertProfile: async (profile: GatewayProfile): Promise<GatewayProfile> => {
      if (profile.default) {
        for (const other of profiles.values()) {
          if (other.id === profile.id || !other.default) continue;
          const { default: wasDefault, ...rest } = other;
          void wasDefault;
          profiles.set(other.id, rest);
        }
      }
      const saved = { ...profile, keyRef: profiles.get(profile.id)?.keyRef ?? "" };
      profiles.set(saved.id, saved);
      changed();
      return saved;
    },
    /** A saved key discovers models and makes the profile the default when none is. */
    setProfileKey: async (profileId: ProfileId, key: string): Promise<SetKeyResult> => {
      const profile = find(profileId);
      if (key === "") {
        profiles.set(profileId, { ...profile, keyRef: "" });
        changed();
        return {};
      }
      const madeDefault = ![...profiles.values()].some((p) => p.default);
      profiles.set(profileId, {
        ...profile,
        keyRef: `profile:${profileId}`,
        models: DISCOVERED,
        ...(madeDefault ? { default: true } : {}),
      });
      changed();
      return { discovered: DISCOVERED.length, ...(madeDefault ? { madeDefault } : {}) };
    },
    vaultInfo: async (): Promise<VaultInfo> => VAULT,
    seedProfiles: async (): Promise<SeedProfilesResult> => {
      if (profiles.size > 0) return { added: 0 };
      profiles.set(IMPORTABLE.id, IMPORTABLE);
      changed();
      return { added: 1 };
    },
    removeProfile: async (profileId: ProfileId) => {
      find(profileId);
      profiles.delete(profileId);
      changed();
    },
    discoverProfileModels: async (profileId: ProfileId): Promise<readonly GatewayModel[]> => {
      const profile = find(profileId);
      if (profile.keyRef === "") {
        throw tagged("GatewayError", { profileId, message: `No API key set for ${profile.name}` });
      }
      profiles.set(profileId, { ...profile, models: DISCOVERED });
      changed();
      return DISCOVERED;
    },
    importProfileKey: async (profileId: ProfileId) => {
      const profile = find(profileId);
      profiles.set(profileId, { ...profile, keyRef: `profile:${profileId}` });
      changed();
      return { imported: true };
    },
    helperStatus: async (): Promise<HelperStatus> => HELPER_STATUS,
    /** How many times a composer said the user is typing, for specs. */
    presence: { typing: 0 },
    /** Local model discovery uses the agent's own account; only explicit profiles use gateway models. */
    listAgentModels: async (agent: AgentKind, profileId?: ProfileId): Promise<ModelList> => {
      if (!agents.has(agent)) {
        throw tagged("AgentUnavailable", { agent, message: `no ${agent} adapter in this build` });
      }
      if (
        agent === "codex" &&
        profileId === undefined &&
        mockLaunchChecks().codexSignIn === "notSignedIn"
      ) {
        throw tagged("AgentUnavailable", {
          agent,
          reason: "not-logged-in",
          message:
            "Codex isn't signed in. Run `codex login` with your ChatGPT account, then retry model discovery.",
        });
      }
      if (profileId === undefined)
        return {
          models: [
            {
              id: "gpt-5.5",
              displayName: "GPT-5.5",
              supportsEffort: true,
              efforts: ["low", "medium", "high"],
              isDefault: true,
            },
          ],
        };
      const profile = profiles.get(profileId);
      const usable = profile?.models.filter(gatewayModelUsable) ?? [];
      return { models: usable.map((m, i) => toAgentModel(m, agent, i === 0)) };
    },
  };
}
