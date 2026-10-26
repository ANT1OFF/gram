import * as Schema from "effect/Schema";

// `Schema.brand` rejects a union or widened key (one brand per id); the helper keeps that check.
const id = <const B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.NonEmptyString.pipe(Schema.brand<B>(brand));

export const ProjectId = id("ProjectId");
export type ProjectId = typeof ProjectId.Type;

export const ThreadId = id("ThreadId");
export type ThreadId = typeof ThreadId.Type;

/** AI SDK `UIMessage.id`. */
export const MessageId = id("MessageId");
export type MessageId = typeof MessageId.Type;

export const TurnId = id("TurnId");
export type TurnId = typeof TurnId.Type;

/** A pending approval / question / plan request (the SDK's `canUseTool` `requestId`). */
export const RequestId = id("RequestId");
export type RequestId = typeof RequestId.Type;

export const LabelId = id("LabelId");
export type LabelId = typeof LabelId.Type;

export const PaletteId = id("PaletteId");
export type PaletteId = typeof PaletteId.Type;

/** A gateway profile. */
export const ProfileId = id("ProfileId");
export type ProfileId = typeof ProfileId.Type;

/** An input waiting in a thread's queue. */
export const QueueItemId = id("QueueItemId");
export type QueueItemId = typeof QueueItemId.Type;

/** A `task-chip` offered by the `spawn_task` app tool. */
export const TaskId = id("TaskId");
export type TaskId = typeof TaskId.Type;

/** A live pseudo-terminal opened with `terminal.open`. */
export const TerminalId = id("TerminalId");
export type TerminalId = typeof TerminalId.Type;

/** A named set of projects one orchestrator works across. */
export const WorkspaceId = id("WorkspaceId");
export type WorkspaceId = typeof WorkspaceId.Type;

/** A step of a thread's plan; stable across the plan's refreshes, so an edit follows its step. */
export const PlanStepId = id("PlanStepId");
export type PlanStepId = typeof PlanStepId.Type;
