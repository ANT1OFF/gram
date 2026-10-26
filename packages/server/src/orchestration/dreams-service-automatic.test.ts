// Automatic Dreams across threshold epochs.
import { describe, expect, it } from "@effect/vitest";
import { type DreamId, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { Dreams } from "./dreams.ts";
import { Orchestration } from "./service.ts";
import { openOrchestrator, waitReal } from "./test-harness.ts";
import {
  type DreamServer,
  inDreams,
  writeOutput,
  startDream,
  finishDream,
  completeConversation,
} from "./dreams-service-kit.ts";

describe.skipIf(!hasGit)("automatic Dream integration", () => {
  for (const reset of ["edit", "reenable"] as const)
    for (const available of [true, false])
      it.effect(`keeps an old model lookup (${available}) out of a new ${reset} epoch`, () => {
        let changed = false;
        let freshId: ThreadId | undefined;
        let terminalMarked: Effect.Effect<boolean> = Effect.succeed(false);
        let resetAndComplete: Effect.Effect<void> = Effect.void;
        return inDreams(
          (world) =>
            Effect.gen(function* () {
              const { workspaceId, project } = yield* openOrchestrator(world);
              const store = yield* ThreadStore;
              const dreams = yield* Dreams;
              const orchestration = yield* Orchestration;
              const state = yield* store.getWorkspace(workspaceId);
              const first = yield* startDream(workspaceId);
              yield* orchestration.setCharter(workspaceId, {
                ...state.charter,
                automaticDreamThreshold: 2,
              });
              yield* completeConversation(project.root);
              yield* completeConversation(project.root);
              yield* waitReal(
                "old ready epoch",
                dreams
                  .automaticStatus(workspaceId)
                  .pipe(
                    Effect.map(
                      (status) => status.completed === 2 && status.detail.includes("running"),
                    ),
                  ),
              );
              const oldEpoch = (yield* store.getAutomaticDreamState(workspaceId))?.epoch;
              terminalMarked = store
                .getAutomaticDreamState(workspaceId)
                .pipe(Effect.map((schedule) => schedule?.lastSuccessDreamId === first.dream.id));
              const context = yield* Effect.context<DreamServer>();
              resetAndComplete = Effect.gen(function* () {
                if (reset === "reenable")
                  yield* orchestration.setCharter(workspaceId, state.charter);
                yield* orchestration.setCharter(workspaceId, {
                  ...state.charter,
                  automaticDreamThreshold: 3,
                });
                freshId = (yield* completeConversation(project.root)).id;
              }).pipe(Effect.provide(context), Effect.orDie);
              writeOutput(first.dream, {
                "MEMORY.md": "# Synthetic model lookup epoch candidate\n",
              });
              yield* finishDream(first.dream, first.session, "completed");
              yield* waitReal(
                "new completion accounted",
                store
                  .getAutomaticDreamState(workspaceId)
                  .pipe(
                    Effect.map(
                      (schedule) => freshId !== undefined && schedule?.seen.includes(freshId),
                    ),
                  ),
              );
              const status = yield* dreams.automaticStatus(workspaceId);
              const schedule = yield* store.getAutomaticDreamState(workspaceId);
              expect(changed).toBe(true);
              expect(schedule?.epoch).not.toBe(oldEpoch);
              expect(status).toMatchObject({ threshold: 3, completed: 1 });
              expect(schedule?.lastFailure).toBeUndefined();
              expect(schedule?.lastSuccessDreamId).toBeUndefined();
              expect(schedule?.lastFailureDreamId).toBeUndefined();
              expect(yield* store.listDreams(workspaceId)).toHaveLength(1);
              expect(
                (yield* FakeAgentControl).sessions.filter(
                  (opened) => opened.options.audience === "dream",
                ),
              ).toHaveLength(1);
            }),
          {
            modelGate: () =>
              Effect.gen(function* () {
                if (changed || !(yield* terminalMarked)) return true;
                changed = true;
                // Public settings transaction at the old retry's model-listing boundary.
                yield* resetAndComplete;
                return available;
              }),
          },
        );
      });
  for (const reset of ["edit", "reenable"] as const)
    for (const ending of ["failed", "canceled", "completed"] as const)
      it.effect(`leaves a new ${reset} epoch untouched by stale ${ending} accounting`, () => {
        let endedId: DreamId | undefined;
        let freshId: ThreadId | undefined;
        let changed = false;
        let resetAndComplete: Effect.Effect<void> = Effect.void;
        return inDreams(
          (world) =>
            Effect.gen(function* () {
              const { workspaceId, project } = yield* openOrchestrator(world);
              const store = yield* ThreadStore;
              const dreams = yield* Dreams;
              const orchestration = yield* Orchestration;
              const state = yield* store.getWorkspace(workspaceId);
              const first = yield* startDream(workspaceId);
              yield* orchestration.setCharter(workspaceId, {
                ...state.charter,
                automaticDreamThreshold: 2,
              });
              yield* completeConversation(project.root);
              yield* completeConversation(project.root);
              yield* waitReal(
                "old ready epoch",
                dreams
                  .automaticStatus(workspaceId)
                  .pipe(
                    Effect.map(
                      (status) => status.completed === 2 && status.detail.includes("running"),
                    ),
                  ),
              );
              const oldEpoch = (yield* store.getAutomaticDreamState(workspaceId))?.epoch;
              const context = yield* Effect.context<DreamServer>();
              resetAndComplete = Effect.gen(function* () {
                if (reset === "reenable")
                  yield* orchestration.setCharter(workspaceId, state.charter);
                yield* orchestration.setCharter(workspaceId, {
                  ...state.charter,
                  automaticDreamThreshold: 3,
                });
                freshId = (yield* completeConversation(project.root)).id;
              }).pipe(Effect.provide(context), Effect.orDie);
              endedId = first.dream.id;
              if (ending === "canceled") yield* dreams.cancel(first.dream.id);
              else {
                if (ending === "completed")
                  writeOutput(first.dream, {
                    "MEMORY.md": "# Synthetic stale-success candidate\n",
                  });
                yield* finishDream(first.dream, first.session, ending);
              }
              yield* waitReal(
                "new-epoch completion delivered",
                store
                  .getAutomaticDreamState(workspaceId)
                  .pipe(
                    Effect.map(
                      (schedule) => freshId !== undefined && schedule?.seen.includes(freshId),
                    ),
                  ),
              );
              const status = yield* dreams.automaticStatus(workspaceId);
              const schedule = yield* store.getAutomaticDreamState(workspaceId);
              expect(status).toMatchObject({ threshold: 3, completed: 1 });
              expect(schedule?.epoch).not.toBe(oldEpoch);
              expect(schedule?.lastFailureDreamId).toBeUndefined();
              expect(schedule?.lastSuccessDreamId).toBeUndefined();
              expect(schedule?.observedDreamId).toBeUndefined();
              expect(schedule?.lastFailure).toBeUndefined();
              expect(yield* store.listDreams(workspaceId)).toHaveLength(1);
              expect(
                (yield* FakeAgentControl).sessions.filter(
                  (opened) => opened.options.audience === "dream",
                ),
              ).toHaveLength(1);
              yield* (yield* ThreadRuntimes).markCompleted(freshId!, "agent");
              yield* dreams.automaticConfigurationChanged;
              expect((yield* dreams.automaticStatus(workspaceId)).completed).toBe(1);
            }),
          {
            onListDreams: (rows) =>
              Effect.gen(function* () {
                if (
                  changed ||
                  endedId === undefined ||
                  !rows.some((row) => row.id === endedId && row.status === ending)
                )
                  return;
                changed = true;
                // Only the scheduler's store is wrapped: normal settings APIs commit after
                // its terminal read and before its conditional accounting transaction.
                yield* resetAndComplete;
              }),
          },
        );
      });
});
