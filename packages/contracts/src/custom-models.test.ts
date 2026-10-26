import { describe, expect, it } from "vitest";
import {
  UNLISTED_GATEWAY_EFFORTS,
  gatewayAgentModel,
  gatewayAgentModels,
  gatewayEfforts,
  withCustomModels,
} from "./custom-models.ts";
import { gatewayModelUsable, type GatewayModel } from "./domain.ts";
import type { AgentModel } from "./models.ts";

const listed: ReadonlyArray<AgentModel> = [
  { id: "default", displayName: "Default", supportsEffort: true, isDefault: true },
  { id: "haiku", displayName: "Haiku", supportsEffort: false },
];

describe("withCustomModels", () => {
  it("appends the user's models after the agent's, named by id when unnamed", () => {
    expect(
      withCustomModels(listed, [
        { agent: "claude", id: "claude-preview", name: "  " },
        { agent: "claude", id: "opus[1m]", name: "Opus, 1M context", effort: false },
      ]),
    ).toEqual([
      ...listed,
      {
        id: "claude-preview",
        displayName: "claude-preview",
        description: "Added in Settings",
        supportsEffort: true,
      },
      {
        id: "opus[1m]",
        displayName: "Opus, 1M context",
        description: "Added in Settings",
        supportsEffort: false,
      },
    ]);
  });

  it("keeps the agent's entry over a custom model with the same id, and drops repeats", () => {
    const merged = withCustomModels(listed, [
      { agent: "claude", id: "haiku", name: "Mine" },
      { agent: "claude", id: "x" },
      { agent: "claude", id: "x" },
    ]);
    expect(merged.map((m) => m.displayName)).toEqual(["Default", "Haiku", "x"]);
  });

  it("returns the agent's list untouched when nothing is added", () => {
    expect(withCustomModels(listed, [])).toBe(listed);
  });
});

describe("gatewayEfforts", () => {
  // As EXAMPLE's gateway describes them in its `…/v1/models` catalog.
  const sol61: GatewayModel = {
    id: "gpt-6.1-sol",
    name: "gpt-6.1-sol",
    info: { reasoning: true, xhighEffort: true, maxEffort: true, noneEffort: false },
  };
  const sol6: GatewayModel = {
    id: "gpt-6-sol",
    name: "gpt-6-sol",
    info: { reasoning: true, xhighEffort: true, maxEffort: true },
  };
  const opus46: GatewayModel = {
    id: "a-claude-opus-4.6",
    name: "a-claude-opus-4.6",
    info: { reasoning: true, xhighEffort: false, maxEffort: true },
  };

  it("never offers none where the gateway declares it unsupported", () => {
    expect(gatewayEfforts(sol61, "responses")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(gatewayEfforts(sol61, "chat")).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("offers max only off chat completions, and none only on them", () => {
    expect(gatewayEfforts(sol6, "responses")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(gatewayEfforts(sol6, "chat")).toEqual(["none", "low", "medium", "high", "xhigh"]);
    expect(gatewayEfforts(opus46, "messages")).toEqual(["low", "medium", "high", "max"]);
  });

  it("is empty for a model without reasoning, and undefined when nothing says", () => {
    expect(
      gatewayEfforts({ id: "gpt-4.1", name: "gpt-4.1", info: { reasoning: false } }, "chat"),
    ).toEqual([]);
    expect(gatewayEfforts({ id: "x", name: "x", info: { mode: "chat" } }, "chat")).toBeUndefined();
    expect(gatewayEfforts({ id: "x", name: "x" }, "responses")).toBeUndefined();
  });

  it("falls back to the OpenCode config's variants, still without max on chat", () => {
    const model: GatewayModel = { id: "m", name: "m", variants: ["low", "high", "max"] };
    expect(gatewayEfforts(model, "chat")).toEqual(["low", "high"]);
    expect(gatewayEfforts(model, "responses")).toEqual(["low", "high", "max"]);
  });
});

describe("gatewayAgentModel", () => {
  it("offers what the gateway lists, and the safe efforts, marked unlisted, when it lists none", () => {
    expect(
      gatewayAgentModel({ id: "gpt-5.5", name: "GPT-5.5", variants: ["low", "high"] }, "codex"),
    ).toEqual({
      id: "gpt-5.5",
      displayName: "GPT-5.5",
      supportsEffort: true,
      efforts: ["low", "high"],
    });
    for (const variants of [undefined, []]) {
      expect(
        gatewayAgentModel(
          {
            id: "gpt-6.1-sol",
            name: "gpt-6.1-sol",
            ...(variants === undefined ? {} : { variants }),
          },
          "codex",
        ),
      ).toEqual({
        id: "gpt-6.1-sol",
        displayName: "gpt-6.1-sol",
        supportsEffort: true,
        efforts: UNLISTED_GATEWAY_EFFORTS,
        effortsUnlisted: true,
      });
    }
    expect(UNLISTED_GATEWAY_EFFORTS).not.toContain("none");
    expect(UNLISTED_GATEWAY_EFFORTS).not.toContain("max");
  });

  it("offers no effort for a model that lists only none", () => {
    expect(gatewayAgentModel({ id: "mini", name: "Mini", variants: ["none"] }, "codex")).toEqual({
      id: "mini",
      displayName: "Mini",
      supportsEffort: false,
    });
  });
});

const described = (id: string, info: GatewayModel["info"]): GatewayModel => ({
  id,
  name: id,
  ...(info === undefined ? {} : { info }),
});

describe("gatewayModelUsable", () => {
  it("keeps the chat models with tools the gateway's catalog describes", () => {
    for (const model of [
      described("gpt-6.1-sol", { mode: "chat", tools: true, deprecated: false, restricted: false }),
      // Most native Claude routes declare no mode.
      described("a-claude-opus-5.5", { tools: true, deprecated: false, restricted: false }),
    ]) {
      expect(gatewayModelUsable(model)).toBe(true);
    }
  });

  it("drops non-chat, tool-less, deprecated and restricted models", () => {
    for (const model of [
      described("qwen3-embedding-8b", { mode: "embedding", restricted: true }),
      described("mistral-ocr-latest", { mode: "ocr" }),
      described("gemini-tts-flash-3.1", { mode: "audio_speech" }),
      described("gpt-image-2", { mode: "image_generation" }),
      described("cohere-rerank-3.5", { mode: "rerank" }),
      described("jev-1.13", { mode: "evaluation", restricted: true }),
      described("fusion", { mode: "chat", tools: false }),
      described("glm-5.3", { mode: "chat", tools: true, restricted: true }),
      described("gpt-4.1", { tools: true, deprecated: true }),
    ]) {
      expect(gatewayModelUsable(model), model.id).toBe(false);
    }
  });

  it("goes by the id when the gateway has no catalog", () => {
    expect(gatewayModelUsable(described("gpt-6.1-sol", undefined))).toBe(true);
    for (const id of ["text-embedding-3-large", "whisper", "gpt-image-2", "fusion-cheap"]) {
      expect(gatewayModelUsable(described(id, undefined)), id).toBe(false);
    }
  });

  it("lists only the usable ones for an agent", () => {
    expect(
      gatewayAgentModels(
        [described("whisper", undefined), described("gpt-6-sol", undefined)],
        "codex",
      ).map((model) => model.id),
    ).toEqual(["gpt-6-sol"]);
  });
});
