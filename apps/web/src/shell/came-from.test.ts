import { describe, expect, it } from "vitest";

import { placeOf } from "./came-from";

describe("where a New form was opened from", () => {
  it("is the thread or the workspace page the window was on", () => {
    expect(placeOf("/t/t-deps")).toEqual({ kind: "thread", threadId: "t-deps" });
    expect(placeOf("/w/w-billing/memory")).toEqual({ kind: "workspace", workspaceId: "w-billing" });
    expect(placeOf("/w/w-billing/files")).toEqual({ kind: "workspace", workspaceId: "w-billing" });
    expect(placeOf("/settings/workspaces/w-billing")).toEqual({
      kind: "workspace",
      workspaceId: "w-billing",
    });
  });

  it("is nowhere from home or Usage, so the last destination is used", () => {
    expect(placeOf("/")).toEqual({ kind: "nowhere" });
    expect(placeOf("/usage")).toEqual({ kind: "nowhere" });
  });

  it("passes over the forms and Settings, which keep the place before them", () => {
    for (const path of ["/new", "/new-task", "/new-workspace", "/settings", "/settings/agents"])
      expect(placeOf(path)).toBeUndefined();
    // The Workspaces list is Settings; one workspace's page in it is that workspace.
    expect(placeOf("/settings/workspaces")).toBeUndefined();
  });
});
