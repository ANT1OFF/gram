import type { Dream, DreamId, WorkspaceId } from "@gram/contracts";

/** An applied automatic memory update of `workspaceId`, as a test stores it: version 0002 made from 0001. */
export const syntheticDream = (id: DreamId, workspaceId: WorkspaceId): Dream => ({
  id,
  workspaceId,
  kind: "dream",
  mode: "auto",
  status: "completed",
  adoptedVersion: "0002",
  inputs: { memoryVersion: "0001", threadIds: [], agentSessions: [] },
  model: { agent: "claude", model: "default" },
  outputDir: "/synthetic/dream",
  createdAt: 1,
});
