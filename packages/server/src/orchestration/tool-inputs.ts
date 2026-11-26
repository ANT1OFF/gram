import {
  AppToolError,
  PlanStepId,
  QuestionChoice,
  QUESTION_DESCRIPTION_MAX,
  QUESTION_LABEL_MAX,
  QUESTION_OPTIONS_MAX,
  type QuestionEdit,
  WakeCondition,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { MEMORY_REVISION_NEW, memoryRevision } from "./memory.ts";
import { refusal } from "./rules.ts";

/** An edit of `questions.md` as `modify` takes it, or the tool's refusal in the edit's words. */
export const questionEdit = (tool: string, edit: QuestionEdit) =>
  edit.ok
    ? Effect.succeed({ content: edit.content, result: edit })
    : Effect.fail(new AppToolError({ tool, message: edit.problem }));

/** What a question's options show, as `ask_user` and `ask_question` describe it to the agent. */
export const VISUALS_HELP =
  " For a mock's directions, give each option an `image` (a screenshot) and a `preview` (its page and board), and name the mock in `mock` (its mock.json or a page), with paths relative to your folder or absolute, inside your worktree or repo; read_playbook mock-first.";

export const questionOptions = Schema.Array(
  Schema.Struct({
    ...QuestionChoice.fields,
    label: Schema.String.check(Schema.isMaxLength(QUESTION_LABEL_MAX)),
    description: Schema.optionalKey(
      Schema.String.check(Schema.isMaxLength(QUESTION_DESCRIPTION_MAX)),
    ),
  }),
).check(Schema.isMaxLength(QUESTION_OPTIONS_MAX));

export const hasVisuals = (option: QuestionChoice): boolean =>
  option.image !== undefined || option.preview !== undefined;

export const NOT_AN_ORCHESTRATOR =
  "This thread is not its workspace's orchestrator, so its memory isn't open here.";

/** Whether a memory file is under `prefix`, or any file without one. */
export const underPrefix =
  (prefix: string | undefined) =>
  (file: { readonly path: string }): boolean =>
    prefix === undefined || file.path.startsWith(prefix);

/**
 * Refuses a change made from a revision the file has moved on from, with the file's current text
 * and revision, so the caller can merge its change into it and write again.
 */
export const checkRevision = (
  tool: string,
  path: string,
  revision: string | undefined,
  current: string | undefined,
): Effect.Effect<void, AppToolError> => {
  const now = current === undefined ? MEMORY_REVISION_NEW : memoryRevision(current);
  if (revision === undefined || revision === now) return Effect.void;
  const message =
    current === undefined
      ? `${path} isn't in memory any more (you read revision ${revision}). Write it again with revision "${MEMORY_REVISION_NEW}" if it should still exist.`
      : `${path} changed since you read it (you read revision ${revision}; it is now ${now}). Merge your change into its current text below, keeping what you aren't changing, and write again with revision ${now}.\n\n${current}`;
  return Effect.fail(new AppToolError({ tool, message: refusal("stale_revision", message) }));
};

/** `schedule_wake` lists its condition flat (`WakeConditionInput`); this decodes it as the union. */
export const decodeWakeCondition = Schema.decodeUnknownEffect(WakeCondition);

/**
 * Where a worker runs: on a machine of its own (`own`, with the size and processor its work needs,
 * as the host provider offers them; `exclusive` with it for one that is never shared), on one its
 * orchestrator already has (`shareWith`, by its name or a worker's thread id on it), on any of its
 * orchestrator's shared machines with room (`shared`), or on its orchestrator's own (`own: false`).
 * Left out, or naming none of them: where the workspace puts workers by default
 * (`OrchestratorCharter.workerPacking`), which unset is its orchestrator's own.
 */
export const WorkerSandbox = Schema.Struct({
  own: Schema.optionalKey(Schema.Boolean),
  shared: Schema.optionalKey(Schema.Boolean),
  exclusive: Schema.optionalKey(Schema.Boolean),
  size: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(40))),
  architecture: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(40))),
  isolation: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(40))),
  environment: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(40))),
  shareWith: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(200))),
  /** Why it goes there rather than your machine, in a sentence the user reads on its row. */
  reason: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(400))),
});
export type WorkerSandbox = typeof WorkerSandbox.Type;

export const newStepId = () => Schema.decodeSync(PlanStepId)(randomUUID().slice(0, 8));
