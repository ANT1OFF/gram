import { DEFAULT_SETTINGS, type AgentModel, type ModelRef } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { subscriptionWorkspaceCharter } from "./new-workspace-model";

const claude: AgentModel[] = [
  { id: "sonnet", displayName: "Sonnet", supportsEffort: false, isDefault: true },
];
const codex: AgentModel[] = [
  { id: "codex-personal", displayName: "Codex personal", supportsEffort: false, isDefault: true },
];

describe("subscription workspace defaults", () => {
  it.each(["claude", "codex"] as const)(
    "honors the selected %s even when both CLIs answer",
    (agent) => {
      const selected: ModelRef = { agent, model: "user-chosen", variant: "high", speed: "fast" };
      const settings = {
        ...DEFAULT_SETTINGS,
        agents: { ...DEFAULT_SETTINGS.agents, defaultModel: selected },
      };
      const charter = subscriptionWorkspaceCharter(settings, claude, codex);
      expect(charter.orchestratorModel).toEqual(selected);
      expect(charter.workerModels).toBeUndefined();
      expect(charter.orchestratorModel).not.toHaveProperty("profileId");
    },
  );

  it("uses the discovered Codex default when only Codex can list local models", () => {
    expect(
      subscriptionWorkspaceCharter(DEFAULT_SETTINGS, undefined, codex).orchestratorModel,
    ).toEqual({ agent: "codex", model: "codex-personal", speed: "standard" });
    expect(
      subscriptionWorkspaceCharter(DEFAULT_SETTINGS, claude, undefined).orchestratorModel,
    ).toEqual({ agent: "claude", model: "sonnet", speed: "standard" });
  });

  it("preserves an explicitly saved roster and does not invent model access", () => {
    const workerModels = [
      { agent: "claude", model: "user-roster", speed: "fast", useFor: "docs" },
    ] as const;
    const settings = { ...DEFAULT_SETTINGS, agents: { ...DEFAULT_SETTINGS.agents, workerModels } };
    const charter = subscriptionWorkspaceCharter(settings, undefined, undefined);
    expect(charter.workerModels).toEqual(workerModels);
    expect(charter.orchestratorModel).toBeUndefined();
  });
});
