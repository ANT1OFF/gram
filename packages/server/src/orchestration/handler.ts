import {
  InvalidState,
  OrchestrationRpcs,
  type DraftId,
  type ThreadId,
  type UserInput,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { attachmentsDir, withDraftAttachments } from "../attachments/attachments.ts";
import { ServerConfig } from "../config.ts";
import { logDefects, type Handlers } from "../rpc/handlers/common.ts";
import { currentReader, privacyOfWorkspace, readerMay } from "../embedding/readable-by.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { steerOrSend } from "../runtime/steer-or-send.ts";
import { ThreadArchive } from "./archive.ts";
import { makeFinishedWorkers } from "./finished-workers.ts";
import { routineHandlers } from "../routines/routines.ts";
import { Orchestration } from "./service.ts";
import { clientInput } from "../runtime/user-input.ts";

/** `workspace.*`, `orchestrator.*`, `thread.detach` and `thread.joinWorkspace`. */
export const orchestrationHandlers = Effect.gen(function* () {
  const orchestration = yield* Orchestration;
  const runtimes = yield* ThreadRuntimes;
  const config = yield* ServerConfig;
  const finished = makeFinishedWorkers({
    store: yield* ThreadStore,
    archive: Option.getOrUndefined(yield* Effect.serviceOption(ThreadArchive)),
  });

  const deliver = (threadId: ThreadId, input: UserInput) =>
    steerOrSend(runtimes, threadId, input).pipe(Effect.asVoid);

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
    "workspace.list": () =>
      orchestration.listWorkspaces.pipe(
        Effect.flatMap((all) =>
          Effect.map(currentReader, (reader) =>
            all.filter((state) =>
              readerMay(
                reader,
                privacyOfWorkspace(state.workspace.id, state.workspace.orchestratorThreadId),
              ),
            ),
          ),
        ),
      ),
    "workspace.save": (input) => orchestration.saveWorkspace(input),
    "workspace.remove": ({ workspaceId }) => orchestration.removeWorkspace(workspaceId),
    "workspace.taskPreflight": (input) => orchestration.taskPreflight(input),
    "workspace.startTask": ({
      target,
      input: sent,
      draftId,
      autonomy,
      orchestrator: picked,
      selection,
    }) =>
      Effect.gen(function* () {
        const input = clientInput(sent);
        const move = yield* orchestration.prepareTaskOrchestrator({
          target,
          ...(picked === undefined ? {} : { orchestrator: picked }),
        });
        return yield* orchestration.withTaskStartup(
          {
            target,
            ...(autonomy === undefined ? {} : { autonomy }),
            ...(picked === undefined ? {} : { orchestrator: picked }),
          },
          selection,
          (current) =>
            Effect.gen(function* () {
              const orchestrator = yield* orchestration.open(
                "projectId" in target ? { projectId: target.projectId, autonomy } : target,
                current.orchestratorThreadId !== undefined && picked !== undefined
                  ? undefined
                  : current.orchestrator,
              );
              if (orchestrator.workspaceId === undefined) {
                return yield* new InvalidState({ message: "The orchestrator has no workspace." });
              }
              yield* adopted(draftId, orchestrator.id, input, (task) =>
                orchestrator.sessionSwitch !== undefined
                  ? runtimes.send(orchestrator.id, task).pipe(Effect.asVoid)
                  : move === "fresh"
                    ? orchestration
                        .sendAfterHandoff(orchestrator.workspaceId!, task)
                        .pipe(
                          Effect.flatMap((held) =>
                            held ? Effect.void : deliver(orchestrator.id, task),
                          ),
                        )
                    : deliver(orchestrator.id, task),
              );
              return orchestrator;
            }),
        );
      }),
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
    "orchestrator.switch": ({ workspaceId, model, note }) =>
      orchestration.handoff(workspaceId, "user", model, note === undefined ? {} : { note }),
    "orchestrator.retrySwitch": ({ workspaceId }) => orchestration.retrySwitch(workspaceId),
    "orchestrator.cancelSwitch": ({ workspaceId }) => orchestration.cancelSwitch(workspaceId),
    "orchestrator.handoff": ({ workspaceId, checkpoint, model }) =>
      orchestration.handoff(workspaceId, "user", model, {
        ...(checkpoint === undefined ? {} : { checkpoint }),
        ...(model === undefined ? {} : { fresh: true }),
      }),
    "orchestrator.releaseHeldBrief": ({ workspaceId, id }) =>
      orchestration.releaseHeldBrief(workspaceId, id),
    "workerQuestion.answer": (input) => orchestration.answerQuestionAsUser(input),
    "workerQuestion.dismiss": (input) => orchestration.dismissQuestionAsUser(input),
    "orchestrator.finishedWorkers": ({ workspaceId }) => finished.list(workspaceId),
    "orchestrator.finishedWorkersPage": ({ workspaceId, after }) =>
      finished.page(workspaceId, after),
    "orchestrator.finishedWorker": ({ threadId }) => finished.detail(threadId),
    "thread.detach": ({ threadId }) => orchestration.detach(threadId),
    "thread.joinTargets": ({ threadId }) => orchestration.joinTargets(threadId),
    "thread.joinWorkspace": ({ threadId, workspaceId, ...input }) =>
      orchestration.joinWorkspace(threadId, workspaceId, input),
  } satisfies Partial<Handlers>;
});

/** The orchestration group's handler layer. */
export const OrchestrationHandlersLive = OrchestrationRpcs.toLayer(
  Effect.gen(function* () {
    const handlers = { ...(yield* orchestrationHandlers), ...(yield* routineHandlers) };
    return OrchestrationRpcs.of(logDefects(OrchestrationRpcs, handlers));
  }),
);
