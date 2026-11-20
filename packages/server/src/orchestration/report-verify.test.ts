import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import {
  makeWorld,
  openOrchestrator,
  spawn,
  withServer,
  type Server,
  type World,
} from "./test-harness.ts";

// A worker's `done` report carries Gram's own record of the repository's required verify drivers
// on its head: what `VerifyStatus` says, whatever the worker put in its input.

const inServer = <A, E>(body: (world: World) => Effect.Effect<A, E, Server | Scope.Scope>) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    return yield* withServer(world, body(world));
  });

describe.skipIf(!hasGit)("a report's verify record", () => {
  it.effect(
    "records Gram's own word on the required verify drivers with a done report, never the worker's",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const { session, workspaceId } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "mail-trigger", title: "Mail trigger" });
          world.verifyRequired = { head: "b".repeat(40), passed: ["unit"], missing: ["shots"] };
          const result = yield* worker.session.callTool("report", {
            state: "done",
            summary: "Done.",
            verify: { head: "c".repeat(40), passed: ["unit", "shots"], missing: [] },
          });
          expect(result).toMatchObject({ reported: true, note: expect.stringContaining("shots") });
          const [stored] = yield* store.listWorkerReports(workspaceId);
          expect(stored?.report.verify).toEqual(world.verifyRequired);

          world.verifyRequired = undefined;
          yield* worker.session.callTool("report", { state: "progress", summary: "More." });
          const reports = yield* store.listWorkerReports(workspaceId);
          expect(reports.at(-1)?.report.verify).toBeUndefined();
        }),
      ),
  );
});
