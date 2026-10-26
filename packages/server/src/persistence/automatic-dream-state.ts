import { randomUUID } from "node:crypto";
import type { Thread, WorkspaceState } from "@gram/contracts";
import * as Schema from "effect/Schema";

/** Server-owned scheduling state; no transcript or adoption authority. */
export const AutomaticDreamState = Schema.Struct({
  threshold: Schema.Int,
  epoch: Schema.String,
  baselineAt: Schema.Number,
  seen: Schema.Array(Schema.String),
  completed: Schema.Int,
  /** A run already active when a fresh configuration epoch was enabled/edited. */
  observedDreamId: Schema.optionalKey(Schema.String),
  lastDreamId: Schema.optionalKey(Schema.String),
  lastSuccessDreamId: Schema.optionalKey(Schema.String),
  lastFailureDreamId: Schema.optionalKey(Schema.String),
  lastAttemptId: Schema.optionalKey(Schema.String),
  lastAttemptAt: Schema.optionalKey(Schema.Number),
  lastFailure: Schema.optionalKey(Schema.String),
});
export type AutomaticDreamState = typeof AutomaticDreamState.Type;

export const eligibleCompletion = (thread: Thread, state: WorkspaceState): boolean =>
  thread.role === undefined &&
  state.workspace.projectIds.includes(thread.projectId) &&
  (thread.spawnedBy === undefined || thread.workspaceId === state.workspace.id) &&
  thread.completedAt !== undefined &&
  (thread.completedReason === "agent" ||
    thread.completedReason === "user" ||
    thread.completedReason === "prMerged");

export const completionBaseline = (
  threshold: number,
  threads: readonly Thread[],
  workspace: WorkspaceState,
  at: number,
  previous?: AutomaticDreamState,
): AutomaticDreamState => ({
  threshold,
  epoch: previous?.threshold === threshold ? previous.epoch : randomUUID(),
  baselineAt: at,
  seen: [
    ...new Set([
      ...(previous?.seen ?? []),
      ...threads.filter((t) => eligibleCompletion(t, workspace)).map((t) => t.id),
    ]),
  ],
  completed: 0,
});
