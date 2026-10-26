import { describe, expect, it } from "vitest";
import {
  featurePreflight,
  imageInputSupport,
  type HarnessAvailability,
  type HarnessSupport,
} from "./agent-support.ts";

const available: HarnessAvailability = { state: "available" };
const support: HarnessSupport = {
  session: { state: "supported", evidence: "Synthetic session adapter" },
  dreamFiles: {
    state: "unsupported",
    reason: "Complete native-tool restriction is unavailable.",
    evidence: "Synthetic protocol lacks an empty native-tool allowlist",
  },
};

describe("selected harness preflight", () => {
  it("uses explicit input modalities and keeps absent metadata unknown", () => {
    expect(
      imageInputSupport(
        [{ id: "invented", displayName: "Invented", supportsEffort: false }],
        "invented",
      ).state,
    ).toBe("unknown");
    expect(
      imageInputSupport(
        [
          {
            id: "alias",
            resolvedId: "invented",
            displayName: "Invented",
            supportsEffort: false,
            inputModalities: ["text", "image"],
          },
        ],
        "invented[1m]",
      ).state,
    ).toBe("supported");
    expect(
      imageInputSupport(
        [
          {
            id: "invented",
            displayName: "Invented",
            supportsEffort: false,
            inputModalities: ["text"],
          },
        ],
        "invented",
      ).state,
    ).toBe("unsupported");
  });
  it("keeps a Dream-only restriction out of ordinary tasks", () => {
    expect(
      featurePreflight({ feature: "session", support, availability: available }),
    ).toMatchObject({
      state: "ready",
      blocked: false,
    });
    expect(
      featurePreflight({ feature: "dreamFiles", support, availability: available }),
    ).toMatchObject({ state: "unsupported", blocked: true, action: "chooseAgent" });
  });

  it("does not infer tools from an available CLI, and requires evidence for Dream", () => {
    const input = { feature: "browser" as const, support, availability: available };
    expect(featurePreflight(input)).toMatchObject({ state: "unknown", blocked: false });
    expect(featurePreflight({ ...input, requireVerified: true })).toMatchObject({
      state: "unknown",
      blocked: true,
    });
    expect(
      featurePreflight({ feature: "imageInput", support: undefined, availability: available }),
    ).toMatchObject({ state: "unknown" });
  });

  it.each([
    ["missing", "setup"],
    ["signedOut", "setup"],
    ["temporarilyUnavailable", "retry"],
  ] as const)("blocks %s without losing the independent support observation", (state, action) => {
    expect(
      featurePreflight({
        feature: "session",
        support,
        availability: { state, reason: "Selected account observation" },
      }),
    ).toMatchObject({
      state,
      action,
      blocked: true,
      support: support.session,
      reason: "Selected account observation",
    });
  });

  it("does not label an unread account as signed out", () => {
    expect(
      featurePreflight({
        feature: "session",
        support,
        availability: { state: "unknown", reason: "Account status could not be read." },
      }),
    ).toMatchObject({ state: "unknown", blocked: false });
  });

  it("preserves sign-out even when a feature restriction is the primary reason", () => {
    expect(
      featurePreflight({
        feature: "dreamFiles",
        support,
        availability: { state: "signedOut", reason: "Sign in to the selected CLI." },
      }),
    ).toMatchObject({
      state: "unsupported",
      availability: { state: "signedOut" },
      support: support.dreamFiles,
    });
  });
});
