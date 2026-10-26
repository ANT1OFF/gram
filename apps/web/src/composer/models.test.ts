// @vitest-environment happy-dom
import { ProfileId, type AgentModel } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { useModelFavourites } from "./model-favourites";
import {
  accountModelWarning,
  defaultModelId,
  effortAfterSwitch,
  effortOptions,
  effortsUnlisted,
  gatewayModelWarning,
  matchesModel,
  modelGroups,
  modelOptions,
  NOT_LISTED_BY_ACCOUNT,
  NOT_LISTED_BY_CODEX,
  NOT_LISTED_BY_GATEWAY,
  unlistedWarning,
} from "./models";

const models: AgentModel[] = [
  { id: "sonnet", displayName: "Sonnet", supportsEffort: true, efforts: ["low", "high"] },
  { id: "opus", displayName: "Opus", supportsEffort: true, isDefault: true },
  { id: "haiku", displayName: "Haiku", supportsEffort: false },
];

describe("modelOptions", () => {
  it("uses the server's models and keeps an unknown current model selectable", () => {
    expect(modelOptions(models, "claude-unlisted").map((o) => o.value)).toEqual([
      "sonnet",
      "opus",
      "haiku",
      "claude-unlisted",
    ]);
  });

  it("falls back to the built-in list while models.list is unavailable", () => {
    expect(modelOptions(undefined, "opus").map((o) => o.value)).toEqual([
      "opus",
      "sonnet",
      "haiku",
    ]);
  });
});

describe("gateway model warnings", () => {
  const gateway: AgentModel[] = [
    { id: "gpt-6.1-sol", displayName: "gpt-6.1-sol", supportsEffort: false },
    {
      id: "a-claude-opus-5.5",
      displayName: "a-claude-opus-5.5",
      description: "Opus",
      supportsEffort: false,
      warning: "Codex doesn't know this model; it runs on generic settings",
    },
  ];

  it("describes an agent's unknown model by its warning, and an unlisted current model", () => {
    const options = modelOptions(gateway, "gpt-4.1", [], NOT_LISTED_BY_GATEWAY);
    expect(options.map((o) => [o.value, o.description])).toEqual([
      ["gpt-6.1-sol", undefined],
      ["a-claude-opus-5.5", "Codex doesn't know this model; it runs on generic settings"],
      ["gpt-4.1", NOT_LISTED_BY_GATEWAY],
    ]);
  });

  it("tints the picker for the thread's own model only once the models are in", () => {
    expect(gatewayModelWarning(gateway, "gpt-6.1-sol")).toBeUndefined();
    expect(gatewayModelWarning(gateway, "a-claude-opus-5.5")).toContain("doesn't know");
    expect(gatewayModelWarning(gateway, "gpt-4.1")).toBe(NOT_LISTED_BY_GATEWAY);
    expect(gatewayModelWarning(undefined, "gpt-4.1")).toBeUndefined();
  });
});

describe("Claude account model warnings", () => {
  const account: AgentModel[] = [
    { id: "default", displayName: "Default", supportsEffort: false, resolvedId: "claude-opus-5-5" },
    { id: "opus", displayName: "Opus", supportsEffort: false, resolvedId: "claude-opus-5-5" },
    {
      id: "claude-fable-5-1[1m]",
      displayName: "Fable",
      supportsEffort: false,
      resolvedId: "claude-fable-5-1",
    },
  ];

  it("counts a model an alias row runs, or its long-context variant, as offered", () => {
    for (const id of ["opus", "claude-opus-5-5", "opus[1m]", "claude-fable-5-1", "default"]) {
      expect(accountModelWarning(account, id)).toBeUndefined();
    }
    expect(accountModelWarning(account, "claude-mythos-5-1")).toBe(NOT_LISTED_BY_ACCOUNT);
    expect(accountModelWarning(undefined, "claude-mythos-5-1")).toBeUndefined();
  });

  it("keeps a thread's model the account dropped selectable, and says so", () => {
    const options = modelOptions(account, "claude-mythos-5-1", undefined, NOT_LISTED_BY_ACCOUNT);
    expect(options.at(-1)).toEqual({
      value: "claude-mythos-5-1",
      label: "claude-mythos-5-1",
      description: NOT_LISTED_BY_ACCOUNT,
    });
    expect(
      modelOptions(account, "claude-opus-5-5", undefined, NOT_LISTED_BY_ACCOUNT).at(-1),
    ).toEqual({ value: "claude-opus-5-5", label: "claude-opus-5-5" });
  });

  it("never offers Mythos from the built-in fallback, and keeps gateway wording apart", () => {
    expect(modelOptions(undefined, undefined).map((o) => o.value)).toEqual([
      "opus",
      "sonnet",
      "haiku",
    ]);
    expect(unlistedWarning("claude", undefined)).toBe(NOT_LISTED_BY_ACCOUNT);
    expect(unlistedWarning("claude", ProfileId.make("litellm"))).toBe(NOT_LISTED_BY_GATEWAY);
    expect(unlistedWarning("codex", undefined)).toBe(NOT_LISTED_BY_CODEX);
    // A gateway's rows name no resolved id, so only the exact id is offered.
    expect(
      gatewayModelWarning([{ id: "x", displayName: "X", supportsEffort: false }], "x[1m]"),
    ).toBe(NOT_LISTED_BY_GATEWAY);
  });
});

describe("effortOptions", () => {
  it("gates on supportsEffort and the listed efforts", () => {
    expect(effortOptions(models, "sonnet").map((o) => o.value)).toEqual(["low", "high"]);
    expect(effortOptions(models, "opus")).toHaveLength(6);
    expect(effortOptions(models, "haiku")).toEqual([]);
  });

  it("offers every effort while the server hasn't listed models", () => {
    expect(effortOptions(undefined, "opus").map((o) => o.label)).toEqual([
      "No thinking",
      "Low effort",
      "Medium effort",
      "High effort",
      "Extra high effort",
      "Max effort",
    ]);
  });

  it("labels as not listed the efforts offered for a model its gateway lists none for", () => {
    const sol: AgentModel = {
      id: "gpt-6.1-sol",
      displayName: "gpt-6.1-sol",
      supportsEffort: true,
      efforts: ["low", "medium", "high", "xhigh"],
      effortsUnlisted: true,
    };
    const offered = effortOptions([...models, sol], "gpt-6.1-sol");
    expect(offered.map((o) => o.value)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(offered[2]?.label).toBe("High effort (not listed)");
    expect(effortsUnlisted([...models, sol], "gpt-6.1-sol")).toBe(true);
    expect(effortsUnlisted([...models, sol], "sonnet")).toBe(false);
  });
});

describe("effortAfterSwitch", () => {
  it("keeps the effort only when the new model offers it", () => {
    expect(effortAfterSwitch(models, "opus", "max")).toBe("max");
    // Sonnet lists low and high, so Max would be an effort it may reject.
    expect(effortAfterSwitch(models, "sonnet", "max")).toBeUndefined();
    expect(effortAfterSwitch(models, "sonnet", "high")).toBe("high");
    expect(effortAfterSwitch(models, "haiku", "high")).toBeUndefined();
    expect(effortAfterSwitch(models, "opus", undefined)).toBeUndefined();
  });
});

describe("defaultModelId", () => {
  it("prefers the model marked default", () => {
    expect(defaultModelId(models)).toBe("opus");
    expect(defaultModelId(undefined)).toBeUndefined();
  });
});

describe("modelGroups", () => {
  const options = modelOptions(models, undefined);

  it("is one section without favourites", () => {
    expect(modelGroups(options, () => false)).toEqual([{ label: "Models", items: options }]);
  });

  it("puts favourites first, each section in the list's order", () => {
    const groups = modelGroups(options, (value) => value === "haiku" || value === "sonnet");
    expect(groups.map((g) => [g.label, g.items.map((o) => o.value)])).toEqual([
      ["Favourites", ["sonnet", "haiku"]],
      ["Other models", ["opus"]],
    ]);
  });

  it("has no empty second section when every model is a favourite", () => {
    expect(modelGroups(options, () => true).map((g) => g.label)).toEqual(["Favourites"]);
  });
});

describe("matchesModel", () => {
  const option = { value: "claude-sonnet-5-5[1m]", label: "Sonnet 5.5", description: "1M context" };

  it("finds every word in the name, id or description, ignoring case", () => {
    expect(matchesModel(option, "sonnet 1m")).toBe(true);
    expect(matchesModel(option, "CLAUDE context")).toBe(true);
    expect(matchesModel(option, "sonnet opus")).toBe(false);
  });

  it("matches everything for an empty query", () => {
    expect(matchesModel(option, "")).toBe(true);
  });
});

describe("model favourites", () => {
  it("stars and unstars a model per agent", () => {
    const { toggle } = useModelFavourites.getState();
    toggle("claude", "opus");
    toggle("codex", "opus");
    expect(useModelFavourites.getState().keys).toEqual(["claude:opus", "codex:opus"]);
    toggle("claude", "opus");
    expect(useModelFavourites.getState().keys).toEqual(["codex:opus"]);
  });
});
