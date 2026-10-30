import { describe, expect, it } from "vitest";

import { pendingSuggestions, validateCustomModels, type CustomModelDraft } from "./custom-models";

const draft = (patch: Partial<CustomModelDraft>): CustomModelDraft => ({
  key: "k",
  agent: "claude",
  id: "",
  name: "",
  effort: true,
  ...patch,
});

describe("validateCustomModels", () => {
  it("trims, and saves only what differs from the defaults", () => {
    expect(
      validateCustomModels([
        draft({ id: "  opus[1m] ", name: " Opus, 1M context " }),
        draft({ agent: "codex", id: "gpt-preview", effort: false }),
      ]),
    ).toEqual({
      rows: [undefined, undefined],
      models: [
        { agent: "claude", id: "opus[1m]", name: "Opus, 1M context" },
        { agent: "codex", id: "gpt-preview", effort: false },
      ],
    });
  });

  it("names the problem per row and saves nothing while one remains", () => {
    const result = validateCustomModels([
      draft({ id: "x" }),
      draft({ id: " " }),
      draft({ id: "claude opus" }),
      draft({ id: "x" }),
      draft({ agent: "codex", id: "x" }),
    ]);
    expect(result.models).toBeUndefined();
    expect(result.rows).toEqual([
      undefined,
      "Enter the model's id, as the agent expects it.",
      "A model id can't contain spaces.",
      "This model is already in the list.",
      undefined,
    ]);
  });

  it("accepts an empty list", () => {
    expect(validateCustomModels([])).toEqual({ rows: [], models: [] });
  });
});

const from = (agent: "claude" | "codex", id: string) => ({
  agent,
  id,
  source: "Claude Code settings",
});

describe("pendingSuggestions", () => {
  it("offers what is neither a row already nor a model the agent lists, once", () => {
    expect(
      pendingSuggestions(
        [
          from("claude", "opus[1m]"),
          from("claude", "claude-preview-eap"),
          from("claude", "claude-preview-eap"),
          from("claude", "already-a-row"),
          from("codex", "opus[1m]"),
        ],
        [draft({ id: " already-a-row " })],
        { claude: ["default", "opus[1m]"], codex: [] },
      ).map((s) => `${s.agent}:${s.id}`),
    ).toEqual(["claude:claude-preview-eap", "codex:opus[1m]"]);
  });

  it("waits for an agent that hasn't answered, and offers everything for one that couldn't", () => {
    const suggestions = [from("claude", "opus[1m]"), from("claude", "claude-preview-eap")];
    expect(pendingSuggestions(suggestions, [], {})).toEqual([]);
    expect(pendingSuggestions(suggestions, [], { claude: "unavailable" }).map((s) => s.id)).toEqual(
      ["opus[1m]", "claude-preview-eap"],
    );
  });
});
