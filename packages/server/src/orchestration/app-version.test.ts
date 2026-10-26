// The running app's version and build, as an orchestrator reads them to tell whether a fix is live.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { hasGit } from "../git/test-repo.ts";
import { makeWorld, openOrchestrator, withServer } from "./test-harness.ts";

describe.skipIf(!hasGit)("the running app's version", () => {
  it.effect("heads the digest and comes with list_workers", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const { session } = yield* openOrchestrator(world);
          expect(session.sent[0]?.text.split("\n")[0]).toMatch(/ · app 0\.4\.0 \(1a2b3c4\)$/);
          expect(yield* session.callTool("list_workers", {})).toMatchObject({
            app: "0.4.0 (1a2b3c4)",
          });
        }),
        { appVersion: "0.4.0", appBuild: "1a2b3c4d".repeat(5) },
      );
    }).pipe(Effect.scoped),
  );

  it.effect("is left out when the version isn't known", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const { session } = yield* openOrchestrator(world);
          expect(session.sent[0]?.text.split("\n")[0]).not.toContain(" · app ");
          expect(yield* session.callTool("list_workers", {})).not.toHaveProperty("app");
        }),
      );
    }).pipe(Effect.scoped),
  );
});
