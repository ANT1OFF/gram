import type { WorkspaceId, WorkspaceState } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { viewedSection } from "@/orchestration/overview-sidebar";

import { viewSolo, viewWorkspace } from "./view-workspace";

const space = (id: string) => ({ workspace: { id: id as WorkspaceId } }) as WorkspaceState;
const gram = space("ws-gram");
const billing = space("ws-billing");

describe("where a jump lands", () => {
  it("a solo thread is in no workspace, though the Board keeps the one last shown", () => {
    const solo = { workspaceId: undefined };
    expect(viewSolo(solo)).toBe(true);
    expect(viewWorkspace(solo, [gram, billing], "ws-billing")).toBe(billing);
    expect(viewSolo({ workspaceId: "ws-gram" as WorkspaceId })).toBe(false);
    // Not loaded yet: nothing is said about it.
    expect(viewSolo(undefined)).toBe(false);
  });

  it("opens Solo threads for a solo thread and the workspace's line for its worker", () => {
    expect(viewedSection({ workspaceId: undefined })).toBe("solo");
    expect(
      viewedSection({
        workspaceId: "ws-billing" as WorkspaceId,
        spawnedBy: { feature: "refunds" } as never,
      }),
    ).toBe("ws-billing");
    // An orchestrator's line is its workspace's own, which a switch never unfolds.
    expect(viewedSection({ workspaceId: "ws-gram" as WorkspaceId })).toBeUndefined();
    expect(viewedSection(undefined)).toBeUndefined();
  });
});
