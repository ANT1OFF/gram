import type { Checkout, GramUIMessage } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { agentHasOutput, startingSteps } from "./starting-progress-model";

const brief = {
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "Fix it" }],
} as GramUIMessage;
const opened = { id: "a1", role: "assistant", parts: [{ type: "step-start" }] } as GramUIMessage;
const replied = {
  id: "a1",
  role: "assistant",
  parts: [{ type: "step-start" }, { type: "text", text: "On it" }],
} as GramUIMessage;
const worktree: Checkout = {
  kind: "worktree",
  path: "/synthetic/repo/.worktrees/fix-it",
  branch: "fix/it",
};

const steps = (input: Partial<Parameters<typeof startingSteps>[0]>) =>
  startingSteps({
    status: "starting",
    checkout: worktree,
    agent: "Claude Code",
    activity: undefined,
    messages: [brief],
    ...input,
  });

describe("startingSteps", () => {
  it("has the branch and worktree done and the CLI launching while the session starts", () => {
    expect(steps({})?.map((step) => [step.key, step.label, step.state])).toEqual([
      ["branch", "Branch", "done"],
      ["worktree", "Worktree", "done"],
      ["launch", "Starting Claude Code", "active"],
      ["first", "First tool", "pending"],
    ]);
    expect(steps({})?.[0]?.detail).toBe("fix/it");
  });

  it("waits on the first tool once the CLI runs, naming the activity when there is one", () => {
    expect(steps({ status: "running" })?.slice(2)).toEqual([
      { key: "launch", label: "Claude Code started", state: "done" },
      { key: "first", label: "Waiting for its first tool or reply", state: "active" },
    ]);
    expect(steps({ status: "running", activity: "Reading files" })?.at(-1)?.label).toBe(
      "Reading files",
    );
    // A turn opened with no output yet is still waiting.
    expect(steps({ status: "running", messages: [brief, opened] })).toBeDefined();
  });

  it("leaves out the branch and worktree for a thread in the main checkout", () => {
    const main: Checkout = { kind: "main", path: "/synthetic/repo" };
    expect(steps({ checkout: main })?.map((step) => step.key)).toEqual(["launch", "first"]);
  });

  it("is gone once the agent has output, or when no first turn is under way", () => {
    expect(steps({ status: "running", messages: [brief, replied] })).toBeUndefined();
    expect(steps({ status: "idle" })).toBeUndefined();
    expect(steps({ status: "error" })).toBeUndefined();
    expect(steps({ messages: [] })).toBeUndefined();
  });
});

describe("agentHasOutput", () => {
  it("counts an assistant part beyond a step's start", () => {
    expect(agentHasOutput([brief, opened])).toBe(false);
    expect(agentHasOutput([brief, replied])).toBe(true);
  });
});
