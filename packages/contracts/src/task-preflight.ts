import * as Schema from "effect/Schema";
import { ModelRef } from "./domain.ts";
import { ThreadId } from "./ids.ts";

/** Read-only task selection, pinned by the start control and revalidated before any holder exists. */
export const TaskModelSelection = Schema.Struct({
  orchestrator: ModelRef,
  orchestratorThreadId: Schema.optionalKey(ThreadId),
  /**
   * Why the orchestrator doesn't open on the model its slot follows (a tier nothing here fills),
   * naming what it opens on instead, for the preview to show. Absent when it opens as its slot says.
   */
  orchestratorNote: Schema.optionalKey(Schema.String),
  /**
   * The model the running orchestrator is on, when the task's pick (`StartTaskInput.orchestrator`)
   * moves it to `orchestrator` as the task starts. Absent when it stays as it is.
   */
  orchestratorFrom: Schema.optionalKey(ModelRef),
  /**
   * With `orchestratorFrom`: the running session can't carry over to the pick, so the move is a
   * fresh session on it, from memory, its conversation kept above a divider.
   */
  orchestratorFresh: Schema.optionalKey(Schema.Boolean),
});
export type TaskModelSelection = typeof TaskModelSelection.Type;

/** A task selection a new task may start on, including a supplied preview. */
export const SupportedTaskModelSelection = Schema.Struct({
  orchestrator: ModelRef,
  orchestratorThreadId: Schema.optionalKey(ThreadId),
});
