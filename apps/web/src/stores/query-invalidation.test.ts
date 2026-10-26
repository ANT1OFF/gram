import type { ThreadId, WorkspaceId } from "@gram/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { invalidateForEvent } from "./query-invalidation";

describe("invalidateForEvent", () => {
  it("makes profiles, models and available agents stale when profiles change", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    invalidateForEvent(client, { type: "profiles.changed" });
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ["profiles"],
      ["models"],
      ["agents-available"],
    ]);
  });

  it("refetches workspaces, their projects and the ledger when orchestration changes", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    invalidateForEvent(client, { type: "workspaces.changed" });
    invalidateForEvent(client, {
      type: "orchestration.changed",
      workspaceId: "w1" as WorkspaceId,
    });
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ["workspaces"],
      ["projects"],
      ["automaticDreamStatus"],
      ["workspaces"],
      ["automaticDreamStatus", "w1"],
      ["memory", "w1"],
      ["finishedWorkers", "w1"],
      ["orchestratorLedger"],
    ]);
  });

  it("leaves the changed workspace's ledger to its live stream, and refetches every other", () => {
    const client = new QueryClient();
    const fetched: Array<string> = [];
    for (const id of ["w1", "w2"]) {
      client.setQueryData(["orchestratorLedger", id], { workspaceId: id });
    }
    const observe = (id: string) =>
      client.getQueryCache().find({ queryKey: ["orchestratorLedger", id] })!;
    const event = { type: "orchestration.changed", workspaceId: "w1" as WorkspaceId } as const;

    invalidateForEvent(client, event, (id) => id === "w1");
    for (const id of ["w1", "w2"]) if (observe(id).state.isInvalidated) fetched.push(id);
    expect(fetched).toEqual(["w2"]);

    // With its stream down, the changed workspace's ledger is refetched as well.
    invalidateForEvent(client, event, () => false);
    expect(observe("w1").state.isInvalidated).toBe(true);
  });

  it("refetches one workspace's dreams and memory when its dreams change", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    invalidateForEvent(client, { type: "dreams.changed", workspaceId: "w1" as WorkspaceId });
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ["dreams", "w1"],
      ["automaticDreamStatus", "w1"],
      ["memory", "w1"],
    ]);
  });

  it("refetches only that workspace's memory when its orchestrator writes to it", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    invalidateForEvent(client, { type: "memory.changed", workspaceId: "w1" as WorkspaceId });
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([["memory", "w1"]]);
  });

  it("leaves query caches alone for other events", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    invalidateForEvent(client, { type: "thread.removed", threadId: "t1" as ThreadId });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
