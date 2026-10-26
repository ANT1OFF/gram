import { describe, expect, it } from "vitest";

import {
  featureAvailable,
  featureRefusal,
  RUNTIME_FEATURES,
  type RuntimeFeatureId,
} from "./runtime-features.ts";

const ids = Object.keys(RUNTIME_FEATURES) as RuntimeFeatureId[];

describe("runtime features", () => {
  it("offers every feature on the server, which cannot observe the shell", () => {
    for (const id of ids) {
      expect(featureAvailable(id, {}), id).toBe(true);
      expect(featureAvailable(id, { shell: undefined }), id).toBe(true);
    }
  });

  it("hides a feature wherever the shell lacks a member it needs, a browser included", () => {
    expect(featureAvailable("dictation", { shell: null })).toBe(false);
    expect(featureAvailable("dictation", { shell: {} })).toBe(false);
    expect(featureAvailable("dictation", { shell: { speech: {} as never } })).toBe(true);
    expect(featureAvailable("openInEditor", { shell: null })).toBe(true);
    expect(featureAvailable("agentBrowsingPublic", { shell: { preview: {} as never } })).toBe(
      false,
    );
    expect(
      featureAvailable("agentBrowsingPublic", {
        shell: { preview: {} as never, agentBrowse: {} as never },
      }),
    ).toBe(true);
  });

  it("says what isn't available", () => {
    expect(featureRefusal("dictation")).toBe("Dictation isn't available here.");
  });

  it("names every feature and provides a reason for each unavailable one", () => {
    for (const id of ids) {
      const feature = RUNTIME_FEATURES[id];
      expect(feature.what.trim(), id).not.toBe("");
      if (feature.unavailable !== undefined) expect(feature.unavailable.trim(), id).not.toBe("");
    }
  });
});
