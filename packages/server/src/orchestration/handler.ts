import {
  InvalidState,
  OrchestrationRpcs,
  ThreadId,
  type DraftId,
  type UserInput,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { attachmentsDir, withDraftAttachments } from "../attachments/attachments.ts";
import { ServerConfig } from "../config.ts";
import { logDefects, type Handlers } from "../rpc/handlers/common.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { ThreadArchive } from "./archive.ts";
import { makeFinishedWorkers } from "./finished-workers.ts";
import { Orchestration } from "./service.ts";

/** `workspace.*`, `orchestrator.*`, `thread.detach` and `thread.joinWorkspace`. */
export const orchestrationHandlers = Effect.gen(function* () {
  const orchestration = yield* Orchestration;
  const runtimes = yield* ThreadRuntimes;
  const config = yield* ServerConfig;
  const finished = makeFinishedWorkers({
    store: yield* ThreadStore,
    // Absent in test layers that keep no archive: only closed records are read there.
    archive: Option.getOrUndefined(yield* Effect.serviceOption(ThreadArchive)),
  });

  /** The user's words to the orchestrator: steered into a turn that can take them, else sent. */
  const deliver = (threadId: ThreadId, input: UserInput) =>
    Effect.gen(function* () {
      const summary = yield* runtimes.summaryOf(threadId);
      const steered =
        summary?.capabilities?.steer === true &&
        summary.status === "running" &&
        (yield* runtimes.steer(threadId, input).pipe(
          Effect.as(true),
          // The turn can end between the snapshot and the steer; then it is an ordinary send.
          Effect.catchTag("InvalidState", () => Effect.succeed(false)),
        ));
      if (!steered) yield* runtimes.send(threadId, input);
    });

  /** Runs `run` with the draft's attachments moved into the thread's folder, as `thread.create` does. */
  const adopted = <A, E>(
    draftId: DraftId | undefined,
    threadId: ThreadId,
    input: UserInput,
    run: (input: UserInput) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | InvalidState> =>
    draftId === undefined
      ? run(input)
      : withDraftAttachments(attachmentsDir(config.dataDir), draftId, threadId, input, (moved) =>
          run(moved ?? input),
        );

  return {
    "workspace.list": () => orchestration.listWorkspaces,
    "workspace.save": (input) => orchestration.saveWorkspace(input),
    "workspace.remove": ({ workspaceId }) => orchestration.removeWorkspace(workspaceId),
    "workspace.taskPreflight": (input) => orchestration.taskPreflight(input),
    "workspace.startTask": ({ target, input, draftId, direct, autonomy, selection }) =>
      orchestration.withTaskStartup(
        {
          target,
          ...(direct === undefined ? {} : { direct }),
          ...(autonomy === undefined ? {} : { autonomy }),
        },
        selection,
        (current) =>
          Effect.gen(function* () {
            const orchestrator = yield* orchestration.open(
              "projectId" in target ? { projectId: target.projectId, autonomy } : target,
              current.orchestrator,
            );
            const workspaceId = orchestrator.workspaceId;
            if (workspaceId === undefined) {
              return yield* new InvalidState({ message: "The orchestrator has no workspace." });
            }
            if (direct === undefined) {
              yield* adopted(draftId, orchestrator.id, input, (task) =>
                deliver(orchestrator.id, task),
              );
              return orchestrator;
            }
            // Chosen here so the draft's attachments move into the worker before its first send.
            const id = Schema.decodeSync(ThreadId)(randomUUID());
            return yield* adopted(draftId, id, input, (task) =>
              orchestration.startWorker(workspaceId, {
                id,
                projectId: direct.projectId,
                base: direct.base,
                input: task,
                ...(current.worker === undefined ? {} : { model: current.worker }),
              }),
            );
          }),
      ),
    "orchestrator.open": ({ workspaceId, projectId }) => {
      if (workspaceId !== undefined && projectId === undefined) {
        return orchestration.open({ workspaceId });
      }
      if (projectId !== undefined && workspaceId === undefined) {
        return orchestration.open({ projectId });
      }
      return Effect.fail(
        new InvalidState({ message: "Name a workspace or a project to open, not both." }),
      );
    },
    "orchestrator.setCharter": ({ workspaceId, charter }) =>
      orchestration.setCharter(workspaceId, charter),
    "orchestrator.setPaused": ({ workspaceId, paused }) =>
      orchestration.setPaused(workspaceId, paused),
    "orchestrator.ledger": ({ workspaceId }) => orchestration.ledger(workspaceId),
    "orchestrator.watchLedger": ({ workspaceId }) => orchestration.watchLedger(workspaceId),
    "orchestrator.featureCards": ({ workspaceId }) => orchestration.featureCards(workspaceId),
    "orchestrator.watchFeatureCards": ({ workspaceId }) =>
      orchestration.watchFeatureCards(workspaceId),
    "orchestrator.setStage": ({ workspaceId, ...input }) =>
      orchestration.setStage(workspaceId, input),
    "orchestrator.setGroup": ({ workspaceId, ...input }) =>
      orchestration.setGroup(workspaceId, input),
    "orchestrator.archiveFeature": ({ workspaceId, feature }) =>
      orchestration.archiveFeature(workspaceId, feature),
    "orchestrator.setFeaturePaused": ({ workspaceId, feature, paused }) =>
      orchestration.setFeaturePaused(workspaceId, feature, paused),
    "orchestrator.renameFeature": ({ workspaceId, feature, to }) =>
      orchestration.renameFeature(workspaceId, feature, to),
    "orchestrator.switch": ({ workspaceId, model }) =>
      orchestration.handoff(workspaceId, "user", model),
    "orchestrator.retrySwitch": ({ workspaceId }) => orchestration.retrySwitch(workspaceId),
    "orchestrator.cancelSwitch": ({ workspaceId }) => orchestration.cancelSwitch(workspaceId),
    "orchestrator.handoff": ({ workspaceId }) => orchestration.handoff(workspaceId, "user"),
    "orchestrator.releaseWorker": ({ threadId }) => orchestration.releaseWorker(threadId),
    "orchestrator.releaseHeldBrief": ({ workspaceId, id }) =>
      orchestration.releaseHeldBrief(workspaceId, id),
    "orchestrator.takeOverWorker": ({ threadId }) => orchestration.takeOverWorker(threadId),
    // The user's own answer or dismissal: theirs to give, so it isn't refused while paused.
    "workerQuestion.answer": (input) => orchestration.answerQuestionAsUser(input),
    "workerQuestion.dismiss": (input) => orchestration.dismissQuestionAsUser(input),
    "orchestrator.finishedWorkers": ({ workspaceId }) => finished.list(workspaceId),
    "orchestrator.finishedWorker": ({ threadId }) => finished.detail(threadId),
    "thread.detach": ({ threadId }) => orchestration.detach(threadId),
    "thread.joinTargets": ({ threadId }) => orchestration.joinTargets(threadId),
    "thread.joinWorkspace": ({ threadId, workspaceId, ...input }) =>
      orchestration.joinWorkspace(threadId, workspaceId, input),
  } satisfies Partial<Handlers>;
});

/** The orchestration group's handler layer. */
export const OrchestrationHandlersLive = OrchestrationRpcs.toLayer(
  Effect.map(orchestrationHandlers, (handlers) =>
    OrchestrationRpcs.of(logDefects(OrchestrationRpcs, handlers)),
  ),
);
