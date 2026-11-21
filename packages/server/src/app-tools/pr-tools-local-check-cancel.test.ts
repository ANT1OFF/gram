// A worker's own managed check stops once it no longer matters: when its merge intent is dropped,
// or when it asks with local_check `cancel: true`. Gram's check is a fake that runs until it is
// interrupted, standing in for the process group the real one would stop.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { hasGit } from "../git/test-repo.ts";
import { makeWorld, waitReal, withServer } from "../orchestration/test-harness.ts";
import { soloPr } from "./pr-tools-solo-kit.ts";

describe("cancelling a worker's own local check", () => {
  it.effect.skipIf(!hasGit)(
    "dropping merge_when_ready cancels its check, and local_check cancels one only it would start",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        let started = 0;
        let stopped = 0;
        world.localCheckRunner = () =>
          Effect.sync(() => void started++).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Effect.sync(() => void stopped++)),
          );
        yield* withServer(
          world,
          Effect.gen(function* () {
            const pr = yield* soloPr(world);
            const base = pr.moveBase("base.txt");
            yield* pr.publish(base);
            expect(yield* pr.tool("local_check").run({})).toMatchObject({ status: "running" });
            yield* waitReal(
              "the check",
              Effect.sync(() => started === 1),
            );
            // Armed, the merge waits on the same check rather than start another.
            yield* pr.tool("merge_when_ready").run({});
            // An armed merge would start it again, so a cancel is refused, saying how.
            const refused = yield* pr.tool("local_check").run({ cancel: true }).pipe(Effect.flip);
            expect(refused.message).toContain("enabled: false");
            expect(stopped).toBe(0);
            yield* pr.tool("merge_when_ready").run({ enabled: false });
            yield* waitReal(
              "the cancel",
              Effect.sync(() => stopped === 1),
            );
            yield* pr.told("Gram cancelled its full check");
            expect(started).toBe(1);
            // Not a verdict on the code: asked again, it runs, and the thread can stop it itself.
            expect(yield* pr.tool("local_check").run({})).toMatchObject({ status: "running" });
            yield* waitReal(
              "the second check",
              Effect.sync(() => started === 2),
            );
            expect(yield* pr.tool("local_check").run({ cancel: true })).toMatchObject({
              status: "cancelled",
              cancelled: [{ head: pr.head, base }],
            });
            expect(stopped).toBe(2);
            expect(yield* pr.tool("local_check").run({ cancel: true })).toMatchObject({
              cancelled: [],
            });
          }),
        );
      }).pipe(Effect.scoped),
  );
});
