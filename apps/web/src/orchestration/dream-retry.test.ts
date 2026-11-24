import type { Dream, DreamId, ThreadId, WorkspaceId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { dreamAgentErrorText, dreamRetryInput } from "./memory-model";

const failed: Dream = {
  id: "dream-0001" as DreamId,
  workspaceId: "ws-1" as WorkspaceId,
  kind: "dream",
  mode: "review",
  status: "failed",
  failure: "agent_error",
  inputs: { memoryVersion: "0002", threadIds: ["t-1" as ThreadId], agentSessions: [] },
  model: { agent: "claude", model: "opus" },
  instructions: "Focus on deploys.",
  outputDir: "/d",
  createdAt: 0,
};

describe("a failed memory update", () => {
  it("tries again with the same kind, mode, model, steering and inputs", () => {
    expect(dreamRetryInput(failed)).toEqual({
      kind: "dream",
      mode: "review",
      model: { agent: "claude", model: "opus" },
      instructions: "Focus on deploys.",
      threadIds: ["t-1"],
    });
  });

  it("gives its agent's error only when the agent stopping is why it failed", () => {
    const error = { text: "The model was overloaded. " };
    expect(dreamAgentErrorText(failed, error)).toBe("The model was overloaded.");
    expect(dreamAgentErrorText({ ...failed, failure: "no_output" }, error)).toBeUndefined();
    expect(dreamAgentErrorText(failed, undefined)).toBeUndefined();
  });
});
