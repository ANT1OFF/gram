import {
  applyAgentGoal,
  applyAgentPlan,
  applyUserEdit,
  PlanStepId,
  type AgentPlanInput,
  type BoundPr,
  type PlanEdit,
  type PlanItem,
  type ThreadId,
  type PlanContext,
  type ThreadPlan,
} from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { randomUUID } from "node:crypto";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore, type ThreadPlanRecord } from "../persistence/thread-store.ts";

export interface ThreadPlansShape {
  /** The thread's plan; absent until somebody wrote one. */
  get(threadId: ThreadId): Effect.Effect<ThreadPlan | undefined>;
  /** The plan and the agent's latest todo list together, as a summary carries them. */
  record(threadId: ThreadId): Effect.Effect<ThreadPlanRecord>;
  /** The agent's todo list changed (`PlanEvent`). */
  setTurnPlan(threadId: ThreadId, items: ReadonlyArray<PlanItem>): Effect.Effect<void>;
  /** The agent's own goal changed or was cleared (`GoalEvent`). */
  setAgentGoal(threadId: ThreadId, objective: string | undefined): Effect.Effect<void>;
  /** The agent's `set_plan`; `followed` are the thread's PRs, whose repos its step PRs take. */
  setByAgent(
    threadId: ThreadId,
    input: AgentPlanInput,
    followed: ReadonlyArray<BoundPr>,
  ): Effect.Effect<ThreadPlan | undefined>;
  /** The user's edit (`thread.setPlan`). */
  edit(threadId: ThreadId, edit: PlanEdit): Effect.Effect<ThreadPlan | undefined>;
  /** Sends the stored plan and todo list as `thread.plan`, for a thread clients were told had gone. */
  publish(threadId: ThreadId): Effect.Effect<void>;
  /** Any other rewrite of the plan, such as the helper's; `f` answering the same plan writes nothing. */
  update(
    threadId: ThreadId,
    f: (plan: ThreadPlan | undefined) => ThreadPlan | undefined,
  ): Effect.Effect<ThreadPlan | undefined>;
}

const newStepId = (): PlanStepId => Schema.decodeSync(PlanStepId)(randomUUID().slice(0, 8));

const context = (): PlanContext => ({ now: Date.now(), newId: newStepId });

/**
 * The one writer of `thread_plans`: every change is stored and then published as a whole
 * `thread.plan`, one at a time, so the last event a client sees is the last write.
 */
export class ThreadPlans extends Context.Service<ThreadPlans, ThreadPlansShape>()(
  "@gram/server/ThreadPlans",
) {
  static readonly layer: Layer.Layer<ThreadPlans, never, ThreadStore | EventHub> = Layer.effect(
    ThreadPlans,
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const hub = yield* EventHub;
      const writes = yield* Semaphore.make(1);

      const publishRecord = (threadId: ThreadId, record: ThreadPlanRecord) =>
        hub.publish({
          type: "thread.plan",
          threadId,
          items: record.turnPlan ?? [],
          ...(record.plan === undefined ? {} : { plan: record.plan }),
        });

      const write = (threadId: ThreadId, f: (record: ThreadPlanRecord) => ThreadPlanRecord) =>
        writes.withPermits(1)(
          Effect.gen(function* () {
            let changed = false;
            const after = yield* store.updatePlan(threadId, (record) => {
              const next = f(record);
              changed = next !== record;
              return next;
            });
            if (changed) yield* publishRecord(threadId, after);
            return after;
          }),
        );

      const updatePlan = (
        threadId: ThreadId,
        f: (plan: ThreadPlan | undefined) => ThreadPlan | undefined,
      ) =>
        write(threadId, (record) => {
          const plan = f(record.plan);
          return plan === record.plan ? record : { ...record, plan };
        }).pipe(Effect.map((record) => record.plan));

      return ThreadPlans.of({
        get: (threadId) => store.getPlan(threadId).pipe(Effect.map((record) => record.plan)),
        record: store.getPlan,
        setTurnPlan: (threadId, items) =>
          write(threadId, (record) => ({ ...record, turnPlan: [...items] })).pipe(Effect.asVoid),
        setAgentGoal: (threadId, objective) =>
          updatePlan(threadId, (plan) => applyAgentGoal(plan, objective, Date.now())).pipe(
            Effect.asVoid,
          ),
        setByAgent: (threadId, input, followed) =>
          updatePlan(threadId, (plan) => applyAgentPlan(plan, input, followed, context())),
        edit: (threadId, edit) =>
          updatePlan(threadId, (plan) => applyUserEdit(plan, edit, context())),
        publish: (threadId) =>
          writes.withPermits(1)(
            Effect.gen(function* () {
              const record = yield* store.getPlan(threadId);
              if (record.plan !== undefined || record.turnPlan !== undefined) {
                yield* publishRecord(threadId, record);
              }
            }),
          ),
        update: updatePlan,
      });
    }),
  );
}
