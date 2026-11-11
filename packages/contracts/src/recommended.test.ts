import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { HelperKind } from "./helper.ts";
import type { AgentModel } from "./models.ts";
import {
  clampEffort,
  RECOMMENDED,
  RECOMMENDED_HISTORY,
  recommendedChanges,
  RecommendationTable,
  resolveTier,
  setupOf,
  tableDiff,
  TIERS,
  type Tier,
} from "./recommended.ts";
import data from "./recommended/table.json" with { type: "json" };

const efforts = ["low", "medium", "high", "xhigh", "max"] as const;

/** Shaped like Claude Code 2.1.319's `supportedModels()`: aliases with the ids they run. */
const claude: ReadonlyArray<AgentModel> = [
  {
    id: "default",
    displayName: "Default (recommended)",
    supportsEffort: true,
    efforts,
    isDefault: true,
    resolvedId: "claude-opus-5-5[1m]",
  },
  { id: "opus", displayName: "Opus", supportsEffort: true, efforts, resolvedId: "claude-opus-5-5" },
  {
    id: "sonnet",
    displayName: "Sonnet",
    supportsEffort: true,
    efforts,
    resolvedId: "claude-sonnet-5-5",
  },
  { id: "haiku", displayName: "Haiku 5.5", supportsEffort: true, efforts },
  {
    id: "fable",
    displayName: "Fable",
    supportsEffort: true,
    efforts,
    resolvedId: "claude-fable-5-1",
  },
];

const codexRow = (id: string): AgentModel => ({
  id,
  displayName: id,
  supportsEffort: true,
  efforts: ["low", "medium", "high", "xhigh", "max"],
});
/** Codex 0.166.0's listed models (`debug-models-bundled-0.166.json`). */
const codex = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna"].map(
  codexRow,
);

const resolve = (tier: Tier, available: Parameters<typeof resolveTier>[2]) =>
  resolveTier(RECOMMENDED, { tier }, available)?.ref;

describe("the recommendation table", () => {
  it("never recommends an effort above high", () => {
    expect(JSON.stringify(data)).not.toMatch(/"(xhigh|max|ultra)"/);
    const withXhigh = structuredClone(data) as { tiers: { top: { effort: string } } };
    withXhigh.tiers.top.effort = "xhigh";
    expect(() => Schema.decodeUnknownSync(RecommendationTable)(withXhigh)).toThrow();
  });

  it("fills every tier with Claude only, Codex only and both", () => {
    for (const available of [{ claude }, { codex }, { claude, codex }]) {
      for (const tier of TIERS) expect(resolve(tier, available), tier).toBeDefined();
    }
  });

  it("names Claude models by the full id of a family Claude Code aliases", () => {
    const families: Record<Tier, string> = {
      cheap: "haiku",
      scoped: "sonnet",
      lead: "opus",
      top: "fable",
    };
    for (const tier of TIERS) {
      for (const id of RECOMMENDED.tiers[tier].claude.models) {
        expect(id).toMatch(new RegExp(`^claude-${families[tier]}-\\d+-\\d+$`));
      }
    }
  });

  it("sets each helper kind's effort: title at medium, the rest at low", () => {
    const helpers = RECOMMENDED.tiers.cheap.helpers ?? {};
    expect(Object.keys(helpers).toSorted()).toEqual([...HelperKind.literals].toSorted());
    for (const kind of HelperKind.literals) {
      expect(helpers[kind], kind).toBe(kind === "title" ? "medium" : "low");
    }
  });

  it("keeps Gram's own development workflow out of its notes", () => {
    const denied = /merge_when_ready|bun run|AGENTS\.md|worktree|\bGram\b|orchestrat/i;
    for (const tier of TIERS) expect(RECOMMENDED.tiers[tier].note).not.toMatch(denied);
  });
});

describe("resolveTier", () => {
  it("resolves the Claude-only table", () => {
    expect(resolve("cheap", { claude })).toEqual({
      agent: "claude",
      model: "haiku",
      variant: "medium",
      speed: "standard",
    });
    expect(resolve("scoped", { claude })?.model).toBe("sonnet");
    // The named alias, not "default", whose model the CLI may move.
    expect(resolve("lead", { claude })?.model).toBe("opus");
    expect(resolve("top", { claude })?.model).toBe("fable");
  });

  it("resolves the Codex-only table, Lead on Sol at high", () => {
    expect(resolve("cheap", { codex })).toMatchObject({ model: "gpt-6-luna", variant: "medium" });
    expect(resolve("scoped", { codex })).toMatchObject({ model: "gpt-6.1-sol", variant: "medium" });
    expect(resolve("lead", { codex })).toMatchObject({ model: "gpt-6.1-sol", variant: "high" });
    expect(resolve("top", { codex })).toMatchObject({ model: "gpt-6-astra", variant: "medium" });
  });

  it("puts Scoped on Codex when both are installed, the rest on Claude", () => {
    const both = { claude, codex };
    expect(resolve("cheap", both)).toMatchObject({ agent: "claude", model: "haiku" });
    expect(resolve("scoped", both)).toMatchObject({ agent: "codex", model: "gpt-6.1-sol" });
    expect(resolve("lead", both)).toMatchObject({ agent: "claude", model: "opus" });
    expect(resolve("top", both)).toMatchObject({ agent: "claude", model: "fable" });
  });

  it("keeps a slot on its own harness and at its own effort", () => {
    const both = { claude, codex };
    expect(resolveTier(RECOMMENDED, { tier: "scoped", agent: "claude" }, both)?.ref).toEqual({
      agent: "claude",
      model: "sonnet",
      variant: "medium",
      speed: "standard",
    });
    expect(
      resolveTier(RECOMMENDED, { tier: "lead", agent: "codex", variant: "low" }, both)?.ref,
    ).toMatchObject({ agent: "codex", model: "gpt-6.1-sol", variant: "low" });
    expect(resolveTier(RECOMMENDED, { tier: "lead", agent: "codex" }, { claude })).toBeUndefined();
  });

  it("falls back within the tier on an older CLI", () => {
    const older = ["gpt-6-sol", "gpt-6-luna", "gpt-5.6-luna"].map(codexRow);
    expect(resolve("scoped", { codex: older })?.model).toBe("gpt-6-sol");
    expect(resolve("cheap", { codex: [codexRow("gpt-5.6-luna")] })?.model).toBe("gpt-5.6-luna");
    expect(resolve("top", { codex: older })).toBeUndefined();
  });

  it("takes the newest Fable the CLI knows", () => {
    const newer = claude.map((row) =>
      row.id === "fable" ? { ...row, resolvedId: "claude-fable-5-2" } : row,
    );
    expect(resolveTier(RECOMMENDED, { tier: "top" }, { claude: newer })?.listed.resolvedId).toBe(
      "claude-fable-5-2",
    );
    const both = [...claude, { ...codexRow("claude-fable-5-2"), displayName: "Fable 5.2" }];
    expect(resolve("top", { claude: both })?.model).toBe("claude-fable-5-2");
  });

  it("resolves against the machine it runs on: no Fable there, no Top", () => {
    const old = claude.filter((row) => row.id !== "fable");
    expect(resolve("top", { claude: old })).toBeUndefined();
    expect(resolve("top", { claude: old, codex })).toMatchObject({ model: "gpt-6-astra" });
  });

  it("matches dated snapshots and an alias's label, not another version", () => {
    const dated = [{ ...codexRow("claude-haiku-5-5-20261001"), displayName: "Haiku" }];
    expect(resolve("cheap", { claude: dated })?.model).toBe("claude-haiku-5-5-20261001");
    const older = [{ id: "haiku", displayName: "Haiku 4.5", supportsEffort: false }];
    expect(resolve("cheap", { claude: older })).toBeUndefined();
  });

  it("finds nothing on a machine with no harness", () => {
    expect(setupOf({ claude: [], codex: undefined })).toBe("none");
    expect(resolve("lead", {})).toBeUndefined();
  });
});

const listed = (values: AgentModel["efforts"]): AgentModel => ({
  id: "m",
  displayName: "m",
  supportsEffort: true,
  ...(values === undefined ? {} : { efforts: values }),
});

describe("clampEffort", () => {
  it("never goes above high", () => {
    expect(clampEffort(listed(efforts), "max")).toBe("high");
    expect(clampEffort(listed(efforts), "xhigh")).toBe("high");
    expect(clampEffort(listed(["xhigh", "max"]), "high")).toBeUndefined();
  });

  it("steps to a level the model lists", () => {
    expect(clampEffort(listed(["low", "high"]), "medium")).toBe("low");
    expect(clampEffort(listed(["low", "medium"]), "none")).toBe("low");
    expect(clampEffort(listed(undefined), "medium")).toBeUndefined();
    expect(clampEffort({ ...listed(efforts), supportsEffort: false }, "medium")).toBeUndefined();
  });
});

describe("tableDiff", () => {
  it("names what moved, one line each", () => {
    const next = structuredClone(RECOMMENDED) as {
      -readonly [K in keyof RecommendationTable]: RecommendationTable[K];
    };
    next.tiers = {
      ...next.tiers,
      scoped: { ...next.tiers.scoped, codex: { models: ["gpt-6.2-sol", "gpt-6.1-sol"] } },
      top: { ...next.tiers.top, effort: "high" },
    };
    next.both = { ...next.both, scoped: "claude" };
    expect(tableDiff(RECOMMENDED, next)).toEqual([
      "Scoped on Codex: gpt-6.1-sol · medium → gpt-6.2-sol · medium",
      "Scoped with both installed: Codex → Claude",
      "Top on Claude: claude-fable-5-2 · medium → claude-fable-5-2 · high",
      "Top on Codex: gpt-6-astra · medium → gpt-6-astra · high",
    ]);
    expect(tableDiff(RECOMMENDED, RECOMMENDED)).toEqual([]);
  });
});

describe("RECOMMENDED_HISTORY", () => {
  it("ends with the table this Gram ships, so a changed table bumps its version and is kept", () => {
    expect(RECOMMENDED_HISTORY.at(-1)).toEqual(RECOMMENDED);
    const versions = RECOMMENDED_HISTORY.map((table) => table.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).toEqual(versions.toSorted());
  });
});

describe("recommendedChanges", () => {
  const next = {
    ...RECOMMENDED,
    version: "2027.01",
    tiers: {
      ...RECOMMENDED.tiers,
      scoped: {
        ...RECOMMENDED.tiers.scoped,
        codex: { models: ["gpt-6.2-sol", "gpt-6.1-sol"] as const },
      },
    },
  } as RecommendationTable;
  const history = [RECOMMENDED, next];

  it("lists what changed since the table the user saw", () => {
    expect(recommendedChanges(RECOMMENDED.version, next, history)).toEqual([
      "Scoped on Codex: gpt-6.1-sol · medium → gpt-6.2-sol · medium",
    ]);
  });

  it("says nothing for the current table, an unset one, or one this Gram doesn't have", () => {
    expect(recommendedChanges("2027.01", next, history)).toEqual([]);
    expect(recommendedChanges(undefined, next, history)).toEqual([]);
    expect(recommendedChanges("2099.01", next, history)).toEqual([]);
    // Today's table is the only one shipped, so nobody is told of a change yet.
    expect(recommendedChanges(RECOMMENDED.version)).toEqual([]);
  });
});
