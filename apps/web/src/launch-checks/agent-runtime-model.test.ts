import type { AgentRuntime } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { verdictTone } from "./agent-runtime-model";

const runtime: AgentRuntime = {
  agent: "codex",
  resolved: { source: "path", path: "/synthetic/codex", version: "0.167.0" },
  baseline: { cliVersion: "0.166.0", binding: "codex-protocol", bindingVersion: "0.166.0" },
  verdict: "supported",
  installSteps: [],
};

describe("runtime compatibility warnings", () => {
  it("uses the existing warning mark for an accepted runtime carrying a warning", () => {
    expect(
      verdictTone({
        ...runtime,
        reason: "Codex 0.167.0 differs from 0.166.0; some features may misbehave.",
      }),
    ).toBe("warning");
    expect(verdictTone(runtime)).toBe("ok");
  });
});
