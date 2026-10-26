import { describe, expect, it } from "vitest";
import { localHelperEffort, localHelperEffortSupported, localHelperModel } from "./helper.ts";

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
    expect(localHelperModel("codex", [{ ...haiku, id: "gpt-5.6-luna" }])).toBeUndefined();
  });
  it("preserves explicit unavailable choices and requests High only when supported", () => {
    expect(localHelperModel("claude", [haiku], "withdrawn")).toBeUndefined();
    expect(localHelperEffort(haiku)).toBe("high");
    expect(localHelperEffort({ ...haiku, efforts: ["low"] })).toBeUndefined();
    expect(localHelperEffort(haiku, "low")).toBe("low");
    expect(localHelperEffortSupported(haiku, "max")).toBe(false);
  });
});
