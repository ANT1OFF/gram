// @vitest-environment happy-dom
import { type ModelRef, type SessionSwitch } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { switchCurrentText, switchStatusText } from "./switch-orchestrator";

const previous: ModelRef = { agent: "codex", model: "synthetic-sol", variant: "high" };
const target: ModelRef = { agent: "claude", model: "Opus5.5-exact-custom-ID", variant: "medium" };
const change: SessionSwitch = {
  id: "invented-attempt",
  previous,
  target,
  mode: "auto",
  phase: "checkpoint",
  oldExited: false,
};

describe("orchestrator current versus requested presentation", () => {
  it("shows the source until checkpointing, then the actual transition rather than an active old model", () => {
    expect(switchCurrentText({ model: previous, sessionSwitch: change })).toContain("Codex");
    expect(
      switchCurrentText({
        model: target,
        sessionSwitch: { ...change, phase: "starting", oldExited: true },
      }),
    ).toBe("Previous session stopped · starting Claude Code · Opus5.5-exact-custom-ID · medium");
    expect(
      switchCurrentText({
        model: target,
        sessionSwitch: { ...change, phase: "failed", oldExited: true },
      }),
    ).toBe("Previous session stopped · requested session not adopted");
    expect(
      switchCurrentText({ model: previous, sessionSwitch: { ...change, phase: "failed" } }),
    ).toContain("Previous exit unconfirmed");
  });

  it("retains custom IDs and the CLI's actual reported identity without substitutions", () => {
    expect(switchCurrentText({ model: target })).toContain("Opus5.5-exact-custom-ID");
    expect(switchCurrentText({ model: target }, "synthetic-reported-model")).toContain(
      "synthetic-reported-model",
    );
    expect(switchCurrentText({ model: target }, "synthetic-reported-model")).not.toContain(
      "Opus5.5-exact-custom-ID",
    );
  });

  it.each(["checkpoint", "retry", "stopping", "starting", "ready", "failed"] as const)(
    "describes %s without promising a conversation migration",
    (phase) => {
      const text = switchStatusText({ ...change, phase });
      expect(text.length).toBeGreaterThan(35);
      expect(text).not.toContain("conversation transferred");
      if (phase === "failed") expect(text).toContain("no replacement was started");
    },
  );
});
