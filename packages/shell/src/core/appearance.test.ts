import { describe, expect, it } from "vitest";

import { parseStoredAppearance } from "./rules.ts";

describe("parseStoredAppearance", () => {
  it("reads the theme the renderer last synced", () => {
    expect(
      parseStoredAppearance(
        JSON.stringify({ background: "#eff1f5", foreground: "#4c4f69", mode: "light" }),
      ),
    ).toEqual({ background: "#eff1f5", foreground: "#4c4f69", mode: "light" });
  });

  it("starts from the defaults when nothing usable was saved", () => {
    expect(parseStoredAppearance(undefined)).toBeNull();
    expect(parseStoredAppearance("{not json")).toBeNull();
    expect(
      parseStoredAppearance(
        JSON.stringify({ background: "white", foreground: "#4c4f69", mode: "light" }),
      ),
    ).toBeNull();
    expect(parseStoredAppearance(JSON.stringify(["#eff1f5"]))).toBeNull();
  });
});
