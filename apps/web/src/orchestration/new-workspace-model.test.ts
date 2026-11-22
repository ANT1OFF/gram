import {
  DEFAULT_SETTINGS,
  type AgentModel,
  type ModelRef,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  autonomySource,
  emptyNewWorkspace,
  startFrom,
  subscriptionWorkspaceCharter,
} from "./new-workspace-model";

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

describe("where the sheet's autonomy comes from", () => {
  const starting = subscriptionWorkspaceCharter(DEFAULT_SETTINGS, claude, codex);
  const careful = {
    workspace: { id: "w-careful" as WorkspaceId, name: "Careful" },
    charter: { ...starting, autonomy: "supervised" },
  } as unknown as WorkspaceState;

  it("says the default for an untouched sheet, and nothing once the user picks another level", () => {
    expect(autonomySource(emptyNewWorkspace, starting, [])).toEqual({ kind: "default" });
    const picked = { ...emptyNewWorkspace, charter: { ...starting, autonomy: "publish" as const } };
    expect(autonomySource(picked, starting, [])).toBeUndefined();
    // Another field edited leaves the level as it came.
    const otherField = { ...emptyNewWorkspace, charter: { ...starting, maxConcurrentWorkers: 3 } };
    expect(autonomySource(otherField, starting, [])).toEqual({ kind: "default" });
  });

  it("names the workspace a copied charter came from", () => {
    const copied = startFrom(emptyNewWorkspace, careful);
    expect(autonomySource(copied, starting, [careful])).toEqual({
      kind: "copied",
      name: "Careful",
    });
    const changed = { ...copied, charter: { ...careful.charter, autonomy: "full" as const } };
    expect(autonomySource(changed, starting, [careful])).toBeUndefined();
  });
});
