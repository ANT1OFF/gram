import { describe, expect, it } from "@effect/vitest";
import type { WaitId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadWaits } from "../waits/service.ts";
import { Orchestration } from "./service.ts";
import {
  completeTurn,
  makeWorld,
  spawn,
  waitSent,
  withServer,
  type World,
} from "./test-harness.ts";
import { withWorker } from "./worker-question-harness.ts";

// An orchestrator withdraws what its own workers added to Waiting on you once it no longer makes
// sense, so the user isn't left to tick it done. Only that orchestrator: a sibling worker or
// another workspace's orchestrator is refused.

const otherOrchestrator = (other: World) =>
  Effect.gen(function* () {
    const orchestration = yield* Orchestration;
    const store = yield* ThreadStore;
    const project = yield* store.ensureProject({ root: other.repo, name: "other" });
    const state = yield* orchestration.saveWorkspace({
      name: "other",
      projectIds: [project.id],
      homeProjectId: project.id,
    });
    const thread = yield* orchestration.open({ workspaceId: state.workspace.id });
    const session = yield* waitSent(thread.id, 1);
    yield* completeTurn(session);
    return session;
  });

describe("an orchestrator and its workers' Waiting on you", () => {
  it.effect("withdraws its own worker's item, which the worker hears as withdrawn", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const other = yield* makeWorld;
      return yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const waits = yield* ThreadWaits;
          const { session, thread, worker } = yield* withWorker(world);
          const sibling = yield* spawn(session, { feature: "mail", title: "Mail trigger" });
          yield* completeTurn(session);
          const elsewhere = yield* otherOrchestrator(other);
          const { id } = (yield* worker.session.callTool("wait_on_user", {
            kind: "action",
            title: "Run assume example-prod",
          })) as { id: WaitId };
          const workerId = worker.thread.id;

          // Neither a sibling worker nor another workspace's orchestrator may touch it.
          for (const caller of [sibling.session, elsewhere]) {
            for (const [name, input] of [
              ["resolve_wait", { id, threadId: workerId }],
              ["list_waits", { threadId: workerId }],
            ] as const) {
              const refused = yield* caller.callTool(name, input).pipe(Effect.flip);
              expect(String(refused)).toContain(
                caller === elsewhere ? "only its own orchestrator" : "threadId",
              );
            }
          }
          expect((yield* store.getWait(workerId, id)).resolvedAt).toBeUndefined();

          // Its own orchestrator reads it without marking it heard for the worker.
          expect(yield* session.callTool("list_waits", { threadId: workerId })).toMatchObject({
            waits: [{ id, state: "open" }],
          });
          expect(
            yield* session.callTool("resolve_wait", {
              id,
              threadId: workerId,
              note: "the deploy job runs it now",
            }),
          ).toEqual({
            id,
            threadId: workerId,
            resolvedBy: "agent",
            ending: "withdrawn",
            resolvedByThread: thread.id,
          });
          expect(yield* store.getWait(workerId, id)).toMatchObject({
            ending: "withdrawn",
            resolverThread: thread.id,
            note: "the deploy job runs it now",
          });
          expect(
            yield* session.callTool("list_waits", { threadId: workerId, state: "all" }),
          ).toMatchObject({ waits: [{ id, state: "withdrawn", resolvedByThread: thread.id }] });

          // The worker didn't withdraw it, so its next message tells it.
          const drafted = yield* waits.draftNote(workerId, []);
          expect(drafted?.news).toMatchObject([{ id, ending: "withdrawn" }]);
          expect(drafted?.note).toContain("the deploy job runs it now");
        }),
      );
    }),
  );
});
