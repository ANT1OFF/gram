import {
  AgentUnavailable,
  ReasoningVariant,
  customModelsOf,
  gatewayAgentModel,
  withCustomModels,
  type AgentKind,
  type SpeedMode,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { ThreadStore } from "../persistence/thread-store.ts";
import type { AgentHosts } from "./agent-hosts.ts";

/** A model a thread can run on, with the reasoning efforts it takes; none when it has no setting. */
export interface ModelEfforts {
  readonly id: string;
  readonly resolvedId?: string;
  readonly speeds: ReadonlyArray<SpeedMode>;
  readonly efforts: ReadonlyArray<ReasoningVariant>;
}

/**
 * The models `models.list` gives the picker for `agent` (through `profileId` when set), so what the
 * server accepts or keeps for a thread is what the user could have picked.
 */
export const selectableModels = (
  store: Pick<ThreadStore["Service"], "listProfiles" | "getSettings">,
  hosts: AgentHosts["Service"],
  agent: AgentKind,
  profileId: string | undefined,
): Effect.Effect<ReadonlyArray<ModelEfforts>, AgentUnavailable> =>
  Effect.gen(function* () {
    const listed = yield* listedModels(store, hosts, agent, profileId);
    const settings = yield* store.getSettings;
    // A model added in Settings carries no effort list, which the picker reads as every effort.
    return withCustomModels(listed, customModelsOf(settings, agent)).map((m) => ({
      id: m.id,
      ...(m.resolvedId === undefined ? {} : { resolvedId: m.resolvedId }),
      speeds: m.speeds ?? [],
      efforts: m.supportsEffort ? (m.efforts ?? ReasoningVariant.literals) : [],
    }));
  });

const listedModels = (
  store: Pick<ThreadStore["Service"], "listProfiles">,
  hosts: AgentHosts["Service"],
  agent: AgentKind,
  profileId: string | undefined,
) =>
  Effect.gen(function* () {
    if (profileId === undefined) return yield* (yield* hosts.get(agent)).listModels();
    const profile = (yield* store.listProfiles).find((p) => p.id === profileId);
    if (profile === undefined) {
      return yield* new AgentUnavailable({
        agent,
        message: `unknown gateway profile ${profileId}`,
      });
    }
    // Every discovered model, not only what the pickers offer: the picker keeps Codex's own
    // configured model and a thread's current one whatever the gateway says of them, so the server
    // mustn't refuse what the user could pick.
    return profile.models.map((model) => gatewayAgentModel(model, agent));
  });
