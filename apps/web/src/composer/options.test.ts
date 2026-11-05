import { describe, expect, it } from "vitest";

import { EFFORT_OPTIONS, MODE_OPTIONS, compactModelName } from "./options";

describe("compact values", () => {
  it("names a model in a word or so", () => {
    expect(compactModelName("Claude Opus")).toBe("Opus");
    expect(compactModelName("Claude Sonnet")).toBe("Sonnet");
    expect(compactModelName("Opus 5.5")).toBe("Opus 5.5");
    expect(compactModelName("GPT-6 Luna")).toBe("GPT-6");
    expect(compactModelName("Claude Opus (1M context)")).toBe("Opus");
    expect(compactModelName("Claude")).toBe("Claude");
  });

  it("keeps every effort and mode to six letters or fewer", () => {
    for (const option of [...EFFORT_OPTIONS, ...MODE_OPTIONS]) {
      const compact = option.compact ?? option.short ?? option.label;
      expect(compact.length, option.value).toBeLessThanOrEqual(6);
    }
  });
});
