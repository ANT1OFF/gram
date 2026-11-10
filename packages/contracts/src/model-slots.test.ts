import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import type { AgentModel } from "./models.ts";
import {
  firstChoiceOf,
  isTierRef,
  isUnknownTier,
  ModelSlot,
  RECOMMENDED,
  slotHere,
} from "./recommended.ts";
import { DEFAULT_SETTINGS, Settings } from "./settings.ts";
import {
  applyCharterWrites,
  planSettingsChanges,
  readSettingsRows,
  type SettingsChange,
  type SettingsWorld,
} from "./settings-chat.ts";
import {
  DEFAULT_CHARTER,
  OrchestratorCharter,
  rosterModelHere,
  rosterName,
  WorkerModel,
  type WorkspaceState,
} from "./workspaces.ts";

const decode = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownSync(schema as never) as (value: unknown) => S["Type"];
const roundTrip = <S extends Schema.Top>(schema: S, value: unknown) =>
  (Schema.encodeSync(schema as never) as unknown as (value: unknown) => unknown)(
    decode(schema)(value),
  );

const sol: AgentModel = {
  id: "gpt-6.1-sol",
  displayName: "GPT-6.1-Sol",
  supportsEffort: true,
  efforts: ["low", "medium", "high", "xhigh"],
};

describe("model slots", () => {
  it("decode a settings file and charter saved before slots exactly as they were", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      agents: {
        ...DEFAULT_SETTINGS.agents,
        defaultModel: { agent: "claude", model: "opus", variant: "max", speed: "fast" },
        workerModels: [{ agent: "codex", model: "gpt-6.1-sol", useFor: "reviews", default: true }],
      },
    };
    expect(roundTrip(Settings, settings)).toEqual(settings);
    const charter = {
      ...DEFAULT_CHARTER,
      orchestratorModel: { agent: "claude", model: "opus", variant: "high", speed: "standard" },
      workerModels: [{ agent: "claude", model: "haiku", variant: "xhigh" }],
    };
    expect(roundTrip(OrchestratorCharter, charter)).toEqual(charter);
  });

  it("decode slots that follow a tier, on a harness or at an effort", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      agents: { ...DEFAULT_SETTINGS.agents, defaultModel: { tier: "lead", variant: "low" } },
    };
    expect(roundTrip(Settings, settings)).toEqual(settings);
    const charter = {
      ...DEFAULT_CHARTER,
      orchestratorModel: { tier: "lead" },
      workerModels: [
        { tier: "scoped", agent: "codex", default: true },
        { tier: "cheap", useFor: "Synthetic note" },
        { agent: "claude", model: "opus" },
      ],
    };
    expect(roundTrip(OrchestratorCharter, charter)).toEqual(charter);
  });

  it("refuse a following slot above high, which only a pinned one may hold", () => {
    expect(() => decode(ModelSlot)({ tier: "top", variant: "xhigh" })).toThrow();
    expect(() => decode(WorkerModel)({ tier: "top", variant: "max" })).toThrow();
    expect(() => decode(ModelSlot)({ tier: "lead", agent: "gemini" })).toThrow();
    expect(decode(ModelSlot)({ agent: "claude", model: "opus", variant: "max" })).toEqual({
      agent: "claude",
      model: "opus",
      variant: "max",
    });
  });

  it("are a synthetic world's first choice", () => {
    expect(firstChoiceOf({ tier: "scoped" })).toEqual({
      agent: "codex",
      model: "gpt-6.1-sol",
      variant: "medium",
    });
    expect(firstChoiceOf({ tier: "lead", agent: "codex" })).toMatchObject({ variant: "high" });
  });
});

describe("rosterModelHere", () => {
  it("leaves a pinned entry as saved", () => {
    const pinned = { agent: "claude" as const, model: "opus", useFor: "mine" };
    expect(rosterModelHere(pinned, {})).toEqual({ entry: pinned });
  });

  it("resolves a tier entry, with the tier's note unless the user wrote one", () => {
    expect(rosterModelHere({ tier: "scoped", default: true }, { codex: [sol] })).toEqual({
      entry: {
        agent: "codex",
        model: "gpt-6.1-sol",
        variant: "medium",
        speed: "standard",
        useFor: RECOMMENDED.tiers.scoped.note,
        default: true,
        tier: "scoped",
      },
    });
    expect(
      rosterModelHere({ tier: "scoped", useFor: "Synthetic own" }, { codex: [sol] }).entry.useFor,
    ).toBe("Synthetic own");
  });

  it("says why a tier nothing here fills can't run, naming its first choice", () => {
    const here = rosterModelHere({ tier: "top" }, { codex: [sol] });
    expect(here.entry).toMatchObject({ agent: "codex", model: "gpt-6-astra", tier: "top" });
    expect(here.missing).toContain("fills the Top tier");
  });
});

const workspace: WorkspaceState = {
  workspace: {
    id: "ws-1" as never,
    name: "Synthetic",
    projectIds: ["p-1" as never],
    homeProjectId: "p-1" as never,
    createdAt: 1,
  },
  charter: {
    ...DEFAULT_CHARTER,
    orchestratorModel: { tier: "lead" },
    workerModels: [
      { tier: "scoped", default: true },
      { agent: "claude", model: "opus", useFor: "Synthetic own" },
    ],
  },
};
const world: SettingsWorld = { settings: DEFAULT_SETTINGS, workspace };
const plan = (changes: ReadonlyArray<SettingsChange>) => planSettingsChanges(world, changes);
const after = (changes: ReadonlyArray<SettingsChange>) => {
  const result = plan(changes);
  if (!result.ok) throw new Error(result.errors.join(" "));
  const charter = applyCharterWrites(workspace.charter, result.plan.writes);
  if (charter === undefined) throw new Error("expected a charter");
  return charter;
};
const errors = (changes: ReadonlyArray<SettingsChange>) => {
  const result = plan(changes);
  return result.ok ? "" : result.errors.join(" ");
};

describe("settings by chat on following slots", () => {
  it("reads them as following the recommendation", () => {
    const rows = readSettingsRows(world, "workspace");
    expect(rows.find((row) => row.key === "workspace.orchestratorModel")?.value).toEqual({
      tier: "lead",
    });
    const result = plan([
      { op: "update", key: "workspace.workerModels", match: "tier:scoped", item: { useFor: "x" } },
    ]);
    expect(result.ok && result.plan.rows.map((row) => row.after)).toContain(
      "Recommended Scoped · default — x",
    );
  });

  it("matches a following entry by its tier, and keeps it following", () => {
    expect(
      after([
        {
          op: "update",
          key: "workspace.workerModels",
          match: "tier:scoped",
          item: { variant: "high" },
        },
      ]).workerModels?.[0],
    ).toEqual({ tier: "scoped", default: true, variant: "high" });
    expect(
      after([{ op: "remove", key: "workspace.workerModels", match: "tier:scoped" }]).workerModels,
    ).toEqual([{ agent: "claude", model: "opus", useFor: "Synthetic own" }]);
  });

  it("keeps a following slot's effort at high or below", () => {
    expect(
      errors([
        {
          op: "update",
          key: "workspace.workerModels",
          match: "tier:scoped",
          item: { variant: "max" },
        },
      ]),
    ).toContain("stops at high");
    expect(errors([{ op: "set", key: "workspace.orchestratorEffort", value: "xhigh" }])).toContain(
      "stops at high",
    );
    expect(
      after([{ op: "set", key: "workspace.orchestratorEffort", value: "high" }]).orchestratorModel,
    ).toEqual({ tier: "lead", variant: "high" });
  });
});

describe("a slot on a tier only a newer Gram knows", () => {
  it("decodes, and keeps what was stored, so the workspace still reads", () => {
    const charter = {
      ...DEFAULT_CHARTER,
      orchestratorModel: { tier: "huge", agent: "codex", variant: "ultra" },
      workerModels: [{ tier: "huge", useFor: "Synthetic note", default: true }],
    };
    expect(roundTrip(OrchestratorCharter, charter)).toEqual(charter);
    const slot = decode(ModelSlot)({ tier: "huge" });
    expect(isUnknownTier(slot)).toBe(true);
    expect(isTierRef(slot)).toBe(false);
  });

  it("never resolves: it is unavailable, with why", () => {
    expect(slotHere({ tier: "huge" }, { codex: [sol] })).toEqual({
      missing: expect.stringContaining('"huge" tier, which only a newer version of Gram knows'),
    });
    const here = rosterModelHere({ tier: "huge", default: true }, { codex: [sol] });
    expect(rosterName(here.entry)).toBe("tier:huge");
    expect(here.entry).toMatchObject({ default: true, unknownTier: "huge" });
    expect(here.missing).toContain("only a newer version of Gram knows");
  });
});

describe("slotHere", () => {
  it("says why a known tier can't run here", () => {
    expect(slotHere({ tier: "top" }, { codex: [sol] })).toEqual({
      missing: expect.stringContaining("nothing here fills the Top tier: Codex (gpt-6-astra)"),
    });
    expect(slotHere({ tier: "scoped" }, { codex: [sol] }).model).toMatchObject({
      model: "gpt-6.1-sol",
    });
    expect(slotHere(undefined, {})).toEqual({});
  });
});
