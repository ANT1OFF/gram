import type { AgentModel, AvailableModels } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { followOfPinned, slotAfterPick } from "./model-slots";

const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
const row = (id: string, resolvedId?: string): AgentModel =>
  ({
    id,
    displayName: id,
    supportsEffort: true,
    efforts,
    ...(resolvedId === undefined ? {} : { resolvedId }),
  }) as AgentModel;

// Synthetic lists in each CLI's shape: Claude's aliases with what they run, Codex's ids.
const both: AvailableModels = {
  claude: [row("opus", "claude-opus-5-5"), row("sonnet", "claude-sonnet-5-5")],
  codex: [row("gpt-6.1-sol")],
};

describe("slotAfterPick", () => {
  const here = { agent: "claude", model: "opus", variant: "medium", speed: "standard" } as const;

  it("keeps a following slot following when only its effort changes, never past high", () => {
    expect(slotAfterPick({ tier: "lead" }, here, { ...here, variant: "high" })).toEqual({
      tier: "lead",
      variant: "high",
    });
    // The model's default effort is the tier's own.
    const { variant: _medium, ...unset } = here;
    expect(slotAfterPick({ tier: "lead", variant: "low" }, here, unset)).toEqual({ tier: "lead" });
    // Nothing changed: the slot as it was.
    const slot = { tier: "lead", variant: "low" } as const;
    expect(slotAfterPick(slot, here, here)).toBe(slot);
    // Past high it can't follow, so it pins what was picked.
    expect(slotAfterPick({ tier: "lead" }, here, { ...here, variant: "max" })).toEqual({
      ...here,
      variant: "max",
    });
  });

  it("pins any other pick", () => {
    const sonnet = { ...here, model: "sonnet" };
    expect(slotAfterPick({ tier: "lead" }, here, sonnet)).toEqual(sonnet);
    const fast = { ...here, speed: "fast" } as const;
    expect(slotAfterPick({ tier: "lead" }, here, fast)).toEqual(fast);
    // Nothing resolved here yet: whatever was picked is the user's.
    expect(slotAfterPick({ tier: "lead" }, undefined, here)).toEqual(here);
  });
});

describe("followOfPinned", () => {
  it("follows the tier that runs the same model here, at its effort first", () => {
    // Codex's Lead is Sol at high: it matches, kept on Codex since Lead runs on Claude here.
    expect(
      followOfPinned(
        { agent: "codex", model: "gpt-6.1-sol", variant: "high", useFor: "reviews", default: true },
        both,
      ),
    ).toEqual({ tier: "lead", agent: "codex", useFor: "reviews", default: true });
    // Sol at medium is Scoped, which runs on Codex here anyway.
    expect(
      followOfPinned({ agent: "codex", model: "gpt-6.1-sol", variant: "medium" }, both),
    ).toEqual({ tier: "scoped" });
    // Opus at xhigh: Lead runs Opus, and its effort drops to the tier's.
    expect(
      followOfPinned({ agent: "claude", model: "claude-opus-5-5", variant: "xhigh" }, both),
    ).toEqual({ tier: "lead" });
  });

  it("has nothing to follow when no tier runs that model here, or it runs through a gateway", () => {
    expect(followOfPinned({ agent: "claude", model: "haiku" }, both)).toBeUndefined();
    expect(
      followOfPinned({ agent: "claude", model: "opus", profileId: "synthetic" as never }, both),
    ).toBeUndefined();
    expect(followOfPinned({ agent: "codex", model: "gpt-6.1-sol" }, {})).toBeUndefined();
  });
});
