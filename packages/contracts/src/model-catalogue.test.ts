import { describe, expect, it } from "vitest";
import {
  canonicalModelId,
  closestName,
  listedRow,
  resolveModel,
  supersededModels,
} from "./model-catalogue.ts";
import type { AgentModel } from "./models.ts";

// Synthetic rows shaped like Claude Code's `supportedModels()`: aliases with and without the id
// they run, a pinned row, the CLI's floating default and a long-context variant.
const row = (id: string, displayName: string, resolvedId?: string): AgentModel => ({
  id,
  displayName,
  supportsEffort: true,
  efforts: ["low", "medium", "high"],
  ...(resolvedId === undefined ? {} : { resolvedId }),
});
const CLAUDE: ReadonlyArray<AgentModel> = [
  row("default", "Default (recommended)", "claude-opus-5-5"),
  row("opus", "Opus 5.5", "claude-opus-5-5"),
  row("opus[1m]", "Opus 5.5 (1M context)", "claude-opus-5-5[1m]"),
  // An alias row that reports no resolved id: its name says what it runs.
  row("fable", "Fable 5.2"),
  row("claude-fable-5-1", "Fable 5.1"),
  row("haiku", "Haiku 5.5", "claude-haiku-5-5"),
];

describe("resolveModel", () => {
  it("takes a CLI alias, a catalogue id, ignoring case", () => {
    expect(resolveModel(CLAUDE, "fable")).toMatchObject({ ok: true, via: "id" });
    expect(listedRow(CLAUDE, "Fable")?.id).toBe("fable");
    expect(listedRow(CLAUDE, "claude-fable-5-1")?.id).toBe("claude-fable-5-1");
  });

  it("takes the pinned id an alias runs, by its resolved id or by its name", () => {
    expect(resolveModel(CLAUDE, "claude-haiku-5-5")).toMatchObject({
      ok: true,
      via: "runs",
      row: { id: "haiku" },
    });
    expect(resolveModel(CLAUDE, "claude-fable-5-2")).toMatchObject({
      ok: true,
      via: "runs",
      row: { id: "fable" },
    });
    // A dated snapshot is its plain model; the window is a row of its own.
    expect(listedRow(CLAUDE, "claude-haiku-5-5-20261001")?.id).toBe("haiku");
    expect(listedRow(CLAUDE, "claude-opus-5-5[1m]")?.id).toBe("opus[1m]");
  });

  it("prefers the named alias to the CLI's floating default for the same model", () => {
    expect(listedRow(CLAUDE, "claude-opus-5-5")?.id).toBe("opus");
  });

  it("takes a display name, ignoring case and spaces", () => {
    for (const name of ["Fable 5.2", "fable 5.2", "FABLE5.2", "  Fable   5.2 "]) {
      expect(resolveModel(CLAUDE, name)).toMatchObject({
        ok: true,
        via: "displayName",
        row: { id: "fable" },
      });
    }
  });

  it("doesn't take a pinned id once the alias moves on", () => {
    const moved = CLAUDE.map((each) =>
      each.id === "fable" ? { ...each, displayName: "Fable 5.3" } : each,
    );
    expect(resolveModel(moved, "claude-fable-5-2")).toEqual({ ok: false, why: "unknown" });
    const movedResolved = CLAUDE.map((each) =>
      each.id === "haiku" ? { ...each, resolvedId: "claude-haiku-5-6" } : each,
    );
    expect(resolveModel(movedResolved, "claude-haiku-5-5")).toEqual({
      ok: false,
      why: "unknown",
    });
  });

  it("is ambiguous when one name is two different models", () => {
    const twins = [...CLAUDE, row("my-fable", "Fable 5.2", "claude-fable-5-2-custom")];
    expect(resolveModel(twins, "Fable 5.2")).toEqual({ ok: false, why: "ambiguous" });
  });

  it("knows nothing of an unknown name or an absent catalogue", () => {
    expect(resolveModel(CLAUDE, "fabel")).toEqual({ ok: false, why: "unknown" });
    expect(resolveModel(CLAUDE, "")).toEqual({ ok: false, why: "unknown" });
    expect(resolveModel(undefined, "fable")).toEqual({ ok: false, why: "unknown" });
  });
});

describe("canonicalModelId", () => {
  it("stores an alias or a display name as the catalogue's id", () => {
    expect(canonicalModelId(CLAUDE, "Fable 5.2")).toBe("fable");
    expect(canonicalModelId(CLAUDE, "FABLE")).toBe("fable");
  });

  it("keeps a pinned id pinned, so it doesn't move with the alias", () => {
    expect(canonicalModelId(CLAUDE, "Claude-Fable-5-2")).toBe("claude-fable-5-2");
  });

  it("names nothing it can't resolve", () => {
    expect(canonicalModelId(CLAUDE, "nope")).toBeUndefined();
  });
});

describe("closestName", () => {
  const candidates = [
    { value: "claude:opus", words: ["claude:opus", "opus", "Opus 5.5"] },
    { value: "claude:claude-fable-5-2", words: ["claude-fable-5-2", "Fable 5.2"] },
  ];

  it("suggests the entry a near miss meant", () => {
    expect(closestName(candidates, "fabel 5.2")).toBe("claude:claude-fable-5-2");
    expect(closestName(candidates, "fable")).toBe("claude:claude-fable-5-2");
    expect(closestName(candidates, "opuss")).toBe("claude:opus");
  });

  it("suggests nothing for a name far from every entry", () => {
    expect(closestName(candidates, "gpt-6.1-sol")).toBeUndefined();
  });
});

const plain = (id: string, displayName: string, extra: Partial<AgentModel> = {}): AgentModel => ({
  id,
  displayName,
  supportsEffort: false,
  ...extra,
});

describe("supersededModels", () => {
  it("keeps the newest of each family, by the version in its name", () => {
    const claude = [
      plain("default", "Default (recommended)", { resolvedId: "claude-opus-5-5" }),
      plain("opus", "Opus 5.5", { resolvedId: "claude-opus-5-5" }),
      plain("claude-opus-5", "Opus 5"),
      plain("claude-opus-4-6", "Opus 4.6"),
      plain("opus[1m]", "Opus 5.5 (1M context)"),
      plain("claude-opus-5[1m]", "Opus 5 (1M context)"),
      plain("fable", "Fable 5.2"),
      plain("claude-fable-5-1", "Fable 5.1"),
      plain("haiku", "Haiku 5.5"),
    ];
    expect([...supersededModels(claude)].toSorted()).toEqual([
      "claude-fable-5-1",
      "claude-opus-4-6",
      "claude-opus-5",
      "claude-opus-5[1m]",
    ]);
  });

  it("reads Codex's names the same way, each line its own family", () => {
    const codex = [
      plain("gpt-6.1-sol", "GPT-6.1-Sol", { isDefault: true }),
      plain("gpt-6-sol", "GPT-6-Sol"),
      plain("gpt-6-luna", "GPT-6 Luna"),
      plain("gpt-5.5", "GPT-5.5"),
      plain("gpt-5.10", "GPT-5.10"),
    ];
    expect([...supersededModels(codex)].toSorted()).toEqual(["gpt-5.5", "gpt-6-sol"]);
  });

  it("names a family from the id an alias runs when its name has no version", () => {
    const rows = [
      plain("opus", "Opus", { resolvedId: "claude-opus-5-5" }),
      plain("claude-opus-4-6", "Claude Opus 4.6"),
    ];
    expect([...supersededModels(rows)]).toEqual(["claude-opus-4-6"]);
  });

  it("never supersedes the CLI's default, a model the user added, or one with no version", () => {
    const rows = [
      plain("gpt-6.1-sol", "GPT-6.1-Sol"),
      plain("gpt-6-sol", "GPT-6-Sol", { isDefault: true }),
      plain("gpt-5-sol", "GPT-5-Sol", { description: "Added in Settings" }),
      plain("mystery", "Mystery"),
    ];
    expect(supersededModels(rows).size).toBe(0);
  });
});
