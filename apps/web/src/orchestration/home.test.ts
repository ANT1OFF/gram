import type { ThreadId, ThreadSummary, WorkspaceId, WorkspaceState } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { homeThread, launchThread } from "./home";

const state = (id: string, orchestratorThreadId?: string) =>
  ({
    workspace: {
      id,
      name: id,
      ...(orchestratorThreadId === undefined ? {} : { orchestratorThreadId }),
    },
  }) as unknown as WorkspaceState;

const active = (entries: Record<string, number>) =>
  Object.fromEntries(
    Object.entries(entries).map(([id, lastActivityAt]) => [
      id,
      { thread: { id, lastActivityAt } } as unknown as ThreadSummary,
    ]),
  );

describe("homeThread", () => {
  const workspaces = [state("w-a", "t-a"), state("w-b", "t-b"), state("w-cold")];

  it("opens the orchestrator of the workspace used last", () => {
    expect(homeThread(workspaces, active({ "t-a": 9, "t-b": 1 }), "w-b" as WorkspaceId)).toBe(
      "t-b" as ThreadId,
    );
  });

  it("falls back to the most recently active orchestrator", () => {
    expect(homeThread(workspaces, active({ "t-a": 1, "t-b": 9 }), undefined)).toBe("t-b");
    // A remembered workspace that was removed, or has no orchestrator open, doesn't count.
    expect(homeThread(workspaces, active({ "t-a": 9, "t-b": 1 }), "w-cold" as WorkspaceId)).toBe(
      "t-a",
    );
    expect(homeThread(workspaces, {}, "w-gone" as WorkspaceId)).toBe("t-a");
  });

  it("has nowhere to go without an open orchestrator", () => {
    expect(homeThread([], {}, undefined)).toBeUndefined();
    expect(homeThread([state("w-cold")], {}, "w-cold" as WorkspaceId)).toBeUndefined();
  });
});

describe("launchThread", () => {
  const workspaces = [state("w-a", "t-a")];
  const summaries = active({ "t-a": 1, "t-x": 9 });

  it("opens the last thread only when asked to and it is still listed", () => {
    expect(launchThread("thread", workspaces, summaries, undefined, "t-x" as ThreadId)).toBe("t-x");
    expect(launchThread("thread", workspaces, summaries, undefined, "t-gone" as ThreadId)).toBe(
      "t-a",
    );
    expect(launchThread("thread", workspaces, summaries, undefined, undefined)).toBe("t-a");
    expect(launchThread("orchestrator", workspaces, summaries, undefined, "t-x" as ThreadId)).toBe(
      "t-a",
    );
  });

  it("opens the last thread without any workspace", () => {
    expect(launchThread("thread", [], summaries, undefined, "t-x" as ThreadId)).toBe("t-x");
  });
});
