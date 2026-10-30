import * as Schema from "effect/Schema";
import { ModelRef } from "./domain.ts";
import { ThreadId } from "./ids.ts";

/**
 * One model a New task's direct worker can be started on: a roster entry as it runs here, with the
 * user's note about it, or the orchestrator's own model when the charter has no roster.
 */
export const TaskWorkerChoice = Schema.Struct({
  model: ModelRef,
  /** The roster entry's `useFor`, as the user wrote it. */
  useFor: Schema.optionalKey(Schema.String),
  /** The entry a worker gets when nobody picks one. */
  default: Schema.optionalKey(Schema.Literal(true)),
  /** Why a worker can't be started on it here, ending in its fix; absent when it can. */
  unavailable: Schema.optionalKey(Schema.String),
});
export type TaskWorkerChoice = typeof TaskWorkerChoice.Type;

/** Read-only task selection, pinned by the start control and revalidated before any holder exists. */
export const TaskModelSelection = Schema.Struct({
  orchestrator: ModelRef,
  orchestratorThreadId: Schema.optionalKey(ThreadId),
  /**
   * The direct worker's model: the one picked, else the roster's default. Absent for a direct task
   * when the default can't run here and nothing was picked; `workerChoices` then says why.
   */
  worker: Schema.optionalKey(ModelRef),
  /** For a direct task, the models its worker may be started on, in the roster's order. */
  workerChoices: Schema.optionalKey(Schema.Array(TaskWorkerChoice)),
});
export type TaskModelSelection = typeof TaskModelSelection.Type;

/** A task selection a new task may start on, including a supplied preview. */
export const SupportedTaskModelSelection = Schema.Struct({
  orchestrator: ModelRef,
  orchestratorThreadId: Schema.optionalKey(ThreadId),
  worker: Schema.optionalKey(ModelRef),
});
