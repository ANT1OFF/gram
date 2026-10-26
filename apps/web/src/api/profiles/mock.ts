import { customModelsOf, withCustomModels, type AgentKind, type AgentModel } from "@gram/contracts";

import { createMockGateways, unavailableGrokMock } from "../mock-gateways";
import type { MockWorld } from "../mock-world";
import type { ProfilesApi } from "./types";

/** What the mock's Claude Code lists, as its SDK does, until a spec seeds the account's own. */
const CLAUDE_MODELS: readonly AgentModel[] = [
  {
    id: "opus",
    displayName: "Claude Opus",
    description: "Most capable",
    supportsEffort: true,
    efforts: ["low", "medium", "high", "xhigh"],
    isDefault: true,
  },
  {
    id: "sonnet",
    displayName: "Claude Sonnet",
    supportsEffort: true,
    efforts: ["low", "medium", "high"],
  },
  { id: "haiku", displayName: "Claude Haiku", description: "Fastest", supportsEffort: false },
];

/**
 * Gateway profiles over `createMockGateways`, announcing each change as the server does, and the
 * models each agent lists. The core builds it, for its `agents` option and the typing count behind
 * `helperTypingReports`; `api` is what joins the `Api`.
 */
export function createProfilesMock(world: MockWorld, agents: readonly AgentKind[] | undefined) {
  const gateways = createMockGateways({
    ...(agents ? { agents } : {}),
    onChange: () => world.emit({ type: "profiles.changed" }),
  });
  const claude = { models: CLAUDE_MODELS };
  /** Each window's threads with a draft, as last reported. */
  const drafts = new Map<string, readonly string[]>();
  const api: ProfilesApi = {
    listProfiles: () => gateways.listProfiles(),
    upsertProfile: (profile) => gateways.upsertProfile(profile),
    setProfileKey: (profileId, key) => gateways.setProfileKey(profileId, key),
    vaultInfo: () => gateways.vaultInfo(),
    seedProfiles: () => gateways.seedProfiles(),
    removeProfile: (profileId) => gateways.removeProfile(profileId),
    discoverProfileModels: (profileId) => gateways.discoverProfileModels(profileId),
    importProfileKey: (profileId) => gateways.importProfileKey(profileId),
    helperStatus: () => gateways.helperStatus(),
    helperPresence: async (typing) => {
      if (typing) gateways.presence.typing++;
    },
    composerDrafts: async (windowId, threadIds) => {
      drafts.set(windowId, [...threadIds]);
    },
    listModels: async (agent, profileId) => {
      // Refuse before adapter defaults, profile lookup or custom-model merging.
      if (agent === "grok") throw unavailableGrokMock();
      if (agents !== undefined && !agents.includes(agent))
        throw Object.assign(new Error(`This mock has no ${agent} adapter.`), {
          _tag: "AgentUnavailable",
          agent,
        });
      // Like the server, the user's own models follow whichever list the agent has.
      const custom = customModelsOf(await world.settings(), agent);
      if (agent !== "claude" || profileId !== undefined) {
        const listed = await gateways.listAgentModels(agent, profileId);
        return { models: withCustomModels(listed.models, custom) };
      }
      return { models: withCustomModels(claude.models, custom) };
    },
    modelSuggestions: async () => {
      const running = world.threads().flatMap(({ thread }) => {
        const { agent, model, profileId } = thread.model;
        return agent === "claude" && profileId === undefined ? [model] : [];
      });
      // One the mock's Claude already lists, which the UI must leave out, and one it doesn't.
      return {
        suggestions: [
          { agent: "claude" as const, id: "opus", source: "Claude Code settings" },
          { agent: "claude" as const, id: "claude-preview-eap", source: "Claude Code settings" },
          ...[...new Set(running)].map((id) => ({
            agent: "claude" as const,
            id,
            source: "a thread's model",
          })),
        ],
      };
    },
  };
  return {
    api,
    /** How many times a composer has told the server the user is typing. */
    helperPresence: gateways.presence,
    /** Each window's threads with a draft, as `composerDrafts` last reported them. */
    composerDrafts: drafts,
    /** What the user's own Claude account lists, which `models.list` hands out from now on. */
    claude,
  };
}
