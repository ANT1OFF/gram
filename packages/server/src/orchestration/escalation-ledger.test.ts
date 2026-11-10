import { describe, expect, it } from "@effect/vitest";
import { escalationStep } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { Orchestration } from "./service.ts";
import {
  makeWorld,
  openOrchestrator,
  prBadge,
  publishGit,
  settle,
  spawn,
  stopSilently,
  withServer,
} from "./test-harness.ts";

// The ledger's next step for a worker whose checks fail: advice for the orchestrator, no chrome.

describe("a worker whose checks are failing", () => {
  it.effect("gets the next step in the ledger and the digest, and loses it once they pass", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { session, workspaceId } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, {
            feature: "mail-trigger",
            title: "Queue worker",
            effort: "medium",
          });
          yield* stopSilently(worker.session);
          const entry = () =>
            orchestration
              .ledger(workspaceId)
              .pipe(Effect.map((ledger) => ledger.features[0]!.workers[0]!));

          yield* publishGit(world, worker.thread, { pr: prBadge({ checks: "failing" }) });
          yield* settle;
          const failing = yield* entry();
          expect(failing.nextStep).toBe(escalationStep(worker.thread.model));
          expect(failing.nextStep).toContain("then the next tier up");

          yield* publishGit(world, worker.thread, { pr: prBadge({ checks: "passing" }) });
          yield* settle;
          expect(yield* entry()).not.toHaveProperty("nextStep");
        }),
      );
    }),
  );
});
