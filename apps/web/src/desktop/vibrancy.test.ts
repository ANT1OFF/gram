import { describe, expect, it } from "vitest";

import { vibrancyAttribute } from "./vibrancy";

describe("vibrancyAttribute", () => {
  it("shows native vibrancy for Glass only in the shell with transparency allowed", () => {
    expect(vibrancyAttribute("glass", true, false)).toBe("native");
    expect(vibrancyAttribute("glass", false, false)).toBeUndefined();
    expect(vibrancyAttribute("glass", true, true)).toBeUndefined();
  });
});
