import {
  DEFAULT_CHARTER,
  DEFAULT_SETTINGS,
  RECOMMENDED,
  RECOMMENDED_ROSTER,
  type AgentModel,
  type Settings,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  recommendedSummary,
  tierRows,
  turnOffKeepWrites,
  turnOnRows,
  turnOnWrites,
} from "./recommended-setup-model";

const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
const row = (id: string, resolvedId?: string, displayName = id): AgentModel => ({
  id,
  displayName,
  supportsEffort: true,
  efforts,
  ...(resolvedId === undefined ? {} : { resolvedId }),
});
// Both installed, shaped like each CLI's lists.
const available = {
  claude: [
    { ...row("default", "claude-opus-5-5", "Default"), isDefault: true },
    row("opus", "claude-opus-5-5", "Opus"),
    row("sonnet", "claude-sonnet-5-5", "Sonnet"),
    row("haiku", "claude-haiku-5-5", "Haiku"),
    row("fable", "claude-fable-5-1", "Fable"),
  ],
  codex: [row("gpt-6.1-sol", undefined, "GPT-6.1-Sol"), row("gpt-6-luna", undefined, "GPT-6 Luna")],
};

const workspace = (id: string, charter: Partial<WorkspaceState["charter"]>): WorkspaceState => ({
  workspace: {
    id: id as WorkspaceId,
    name: id,
    projectIds: ["p" as never],
    homeProjectId: "p" as never,
    createdAt: 1,
  },
  charter: { ...DEFAULT_CHARTER, ...charter },
});

describe("this machine's recommendation", () => {
  it("names each tier's model and effort, and sums it up in a line", () => {
    expect(tierRows(available).map((each) => [each.name, each.runsOn])).toEqual([
      ["Cheap", "Haiku 5.5 · Medium"],
      ["Scoped", "GPT-6.1-Sol · Medium"],
      ["Lead", "Opus 5.5 · Medium"],
      ["Top", "Fable 5.1 · Medium"],
    ]);
    expect(recommendedSummary(available)).toBe(
      "Opus 5.5 leads, GPT-6.1-Sol does scoped work, Haiku 5.5 helps.",
    );
    // Codex alone: Lead and Scoped are both Sol, said once.
    expect(recommendedSummary({ codex: available.codex })).toBe(
      "GPT-6.1-Sol leads, GPT-6 Luna helps.",
    );
    expect(recommendedSummary({})).toBeUndefined();
  });
});

describe("turning it on", () => {
  const settings: Settings = DEFAULT_SETTINGS;
  const workspaces = [
    workspace("Shop", {
      orchestratorModel: { agent: "claude", model: "opus", variant: "high", speed: "standard" },
      workerModels: [
        { agent: "codex", model: "gpt-6.1-sol", variant: "high", useFor: "reviews" },
        { agent: "codex", model: "gpt-6.1-sol", variant: "medium", default: true },
      ],
    }),
    workspace("Docs", {
      orchestratorModel: { agent: "claude", model: "sonnet", variant: "low" },
    }),
  ];

  it("pre-ticks Gram's own past defaults and leaves the user's picks unticked", () => {
    const rows = turnOnRows(settings, workspaces, available);
    expect(rows.map((each) => [each.key, each.ticked, each.canFollow])).toEqual([
      ["default", true, true],
      ["orchestrator:Shop", true, true],
      // Sol at high runs as Lead on Codex, Sol at medium as Scoped: both can follow.
      ["entry:Shop:0", false, true],
      ["entry:Shop:1", false, true],
      ["orchestrator:Docs", false, true],
      ["roster:Docs", true, true],
      ["helpers", true, true],
    ]);
    expect(rows[0]!.change).toBe("Not set → Recommended Lead · Opus 5.5 · Low");
    expect(rows[2]!.change).toBe(
      "Codex gpt-6.1-sol · High → Recommended Lead · GPT-6.1-Sol · High",
    );
    // A pinned entry no tier runs here stays the user's, with no box to tick.
    const own = workspace("Own", {
      workerModels: [{ agent: "claude", model: "sonnet", variant: "max" }],
    });
    expect(turnOnRows(settings, [own], available)[2]).toMatchObject({
      change: "Claude Code sonnet · Max: yours, kept",
      canFollow: false,
    });
  });

  it("writes only what was ticked, and records the mode and the version seen", () => {
    const ticked = new Set([
      "default",
      "orchestrator:Shop",
      "entry:Shop:1",
      "roster:Docs",
      "helpers",
    ]);
    const writes = turnOnWrites(settings, workspaces, available, ticked);
    expect(writes.patch).toEqual({
      agents: { recommendedSetup: { enabled: true, seen: RECOMMENDED.version } },
    });
    expect(writes.charters).toEqual([
      {
        id: "Shop",
        charter: {
          ...workspaces[0]!.charter,
          orchestratorModel: { tier: "lead" },
          workerModels: [
            workspaces[0]!.charter.workerModels![0],
            { tier: "scoped", agent: "codex", default: true },
          ],
        },
      },
      { id: "Docs", charter: { ...workspaces[1]!.charter, workerModels: RECOMMENDED_ROSTER } },
    ]);
  });

  it("keeps an unset default as the CLI's own when it is unticked", () => {
    const writes = turnOnWrites(settings, [], available, new Set());
    expect(writes.patch.agents?.defaultModel).toEqual({
      agent: "claude",
      model: "default",
      speed: "standard",
    });
  });

  it("clears the user's helper choices only when ticked", () => {
    const own: Settings = { ...settings, helpers: { ...settings.helpers, claudeEffort: "high" } };
    expect(turnOnRows(own, [], available).at(-1)).toMatchObject({ ticked: false });
    expect(turnOnWrites(own, [], available, new Set(["helpers"])).patch.helpers).toEqual({
      claudeModel: null,
      codexModel: null,
      claudeEffort: null,
      codexEffort: null,
    });
    expect(turnOnWrites(own, [], available, new Set()).patch.helpers).toBeUndefined();
  });
});

describe("turning it off, keeping the current models", () => {
  it("pins every following slot to what it runs on here, an unset default too", () => {
    const on: Settings = {
      ...DEFAULT_SETTINGS,
      agents: { ...DEFAULT_SETTINGS.agents, recommendedSetup: { enabled: true, seen: "2026.11" } },
    };
    const following = workspace("Shop", {
      orchestratorModel: { tier: "lead" },
      workerModels: [
        { tier: "scoped", default: true },
        { tier: "top", useFor: "Synthetic note" },
        { agent: "claude", model: "sonnet" },
      ],
    });
    const writes = turnOffKeepWrites(on, [following], available);
    expect(writes.patch).toEqual({
      agents: {
        recommendedSetup: { enabled: false, seen: "2026.11" },
        defaultModel: { agent: "claude", model: "opus", variant: "low", speed: "standard" },
      },
    });
    expect(writes.charters[0]!.charter).toMatchObject({
      orchestratorModel: { agent: "claude", model: "opus", variant: "medium" },
      workerModels: [
        { agent: "codex", model: "gpt-6.1-sol", variant: "medium", default: true },
        { agent: "claude", model: "fable", variant: "medium", useFor: "Synthetic note" },
        { agent: "claude", model: "sonnet" },
      ],
    });
    // The tier's own note doesn't become the user's.
    expect(writes.charters[0]!.charter.workerModels![0]).not.toHaveProperty("useFor");
  });
});
