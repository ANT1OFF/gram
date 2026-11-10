import { describe, expect, it } from "vitest";
import { localHelperEffort, localHelperEffortSupported, localHelperModel } from "./helper.ts";

const codex = (id: string) => ({ id, displayName: id, supportsEffort: false });

describe("subscription helper selection", () => {
  const haiku = {
    id: "haiku",
    resolvedId: "claude-haiku-5-5",
    displayName: "Haiku 5.5",
    supportsEffort: true,
    efforts: ["low", "high"] as const,
  };
  it("uses only the requested discovered identities for automatic defaults", () => {
    const old = { ...haiku, resolvedId: "claude-haiku-4-5", displayName: "Haiku 4.5" };
    expect(localHelperModel("claude", [old])).toBeUndefined();
    expect(localHelperModel("claude", [old, haiku])).toBe(haiku);
    expect(localHelperModel("claude", [old], "haiku")).toBe(old);
    // The Cheap tier on Codex: Luna, and the older Luna on a CLI without it; never another tier.
    expect(localHelperModel("codex", [codex("gpt-6-sol")])).toBeUndefined();
    expect(localHelperModel("codex", [codex("gpt-5.6-luna")])?.id).toBe("gpt-5.6-luna");
    expect(localHelperModel("codex", [codex("gpt-5.6-luna"), codex("gpt-6-luna")])?.id).toBe(
      "gpt-6-luna",
    );
  });
  it("preserves explicit unavailable choices, and runs titles at medium and the rest at low", () => {
    expect(localHelperModel("claude", [haiku], "withdrawn")).toBeUndefined();
    const listed = { ...haiku, efforts: ["low", "medium", "high"] as const };
    expect(localHelperEffort(listed, undefined, "title")).toBe("medium");
    expect(localHelperEffort(listed, undefined, "recap")).toBe("low");
    // Never high on its own: a model without medium runs a title at low.
    expect(localHelperEffort(haiku, undefined, "title")).toBe("low");
    // Only when it lists nothing lower does it ask for high.
    expect(localHelperEffort({ ...haiku, efforts: ["high"] }, undefined, "title")).toBe("high");
    expect(
      localHelperEffort({ ...haiku, supportsEffort: false }, undefined, "title"),
    ).toBeUndefined();
    expect(localHelperEffort(haiku, "low")).toBe("low");
    expect(localHelperEffortSupported(haiku, "max")).toBe(false);
  });
});
