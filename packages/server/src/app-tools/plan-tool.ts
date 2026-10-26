import { MAX_PLAN_STEPS, PlanStepStatus, planProgress } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { ThreadPlansShape } from "../plans/service.ts";
import { defineAppTool, failed } from "./definition.ts";

/**
 * `set_plan`: the agent's own plan for the thread, which wins over the
 * helper's. Offered to every plain thread and worker, described lightly so that an agent keeps one
 * only where the work is longer than a turn.
 */
export const setPlanTool = (plans: ThreadPlansShape, store: Pick<ThreadStoreShape, "getThread">) =>
  defineAppTool({
    descriptor: {
      name: "set_plan",
      class: "self",
      description:
        "Keep a short plan for this thread when the work spans several steps, PRs or sessions: " +
        `a goal and up to ${MAX_PLAN_STEPS} steps the user would recognise, each todo, doing, ` +
        "done, blocked or dropped, with the PR number a step is about. Each call replaces the " +
        "steps; ones the user edited stay. Not needed for a quick question or a one-turn change.",
    },
    audience: ["plain", "worker"],
    input: Schema.Struct({
      goal: Schema.optionalKey(Schema.String),
      steps: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            text: Schema.NonEmptyString,
            status: PlanStepStatus,
            pr: Schema.optionalKey(Schema.Int),
          }),
        ).check(Schema.isMaxLength(MAX_PLAN_STEPS)),
      ),
    }),
    handle: (threadId, input) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const followed = [
          ...(thread.boundPr === undefined ? [] : [thread.boundPr]),
          ...(thread.extraPrs ?? []),
        ];
        const plan = yield* plans.setByAgent(threadId, input, followed);
        if (plan === undefined) return { plan: null };
        const { done, total } = planProgress(plan);
        return {
          goal: plan.goal,
          steps: plan.steps.map((step) => ({
            text: step.text,
            status: step.status,
            ...(step.source === "user" ? { editedByUser: true } : {}),
          })),
          progress: `${done} of ${total}`,
        };
      }).pipe(Effect.mapError(failed("set_plan"))),
  });
