// A merge freeze holds its own workspace's merges; every workspace's only on the user's yes.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { MergeFreezes } from "../git/merge-freezes.ts";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import {
  atAutonomy,
  completeTurn,
  makeWorld,
  openOrchestrator,
  spawn,
  waitReal,
  withServer,
} from "./test-harness.ts";

describe.skipIf(!hasGit)("a merge freeze's reach", () => {
  it.effect(
    "holds only its workspace's merges, and every workspace's only once the user says yes",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const freezes = yield* MergeFreezes;
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const registry = yield* AppToolRegistry;
            world.defaultBranches.set("acme/app", "main");
            world.originRepos.set(world.repo, "acme/app");
            const opened = yield* openOrchestrator(world);
            const release = yield* spawn(opened.session, { feature: "release", title: "Release" });
            yield* completeTurn(release.session);
            yield* atAutonomy(opened.thread, "full");
            const own = opened.workspaceId;
            const freezeTool = registry
              .forTransport(release.thread.id, "worker")
              .find((tool) => tool.descriptor.name === "merge_freeze")!;

            yield* freezeTool.run({ repo: "acme/app", reason: "the cut" });
            expect(yield* freezes.holding("acme/app", "main", 12, own)).toMatchObject({
              branch: "main",
            });
            // Another workspace's merge, and a thread in none, go on.
            expect(yield* freezes.holding("acme/app", "main", 12, "elsewhere")).toBeUndefined();
            expect(yield* freezes.holding("acme/app", "main", 12, undefined)).toBeUndefined();

            // Every workspace's is asked of the user, even at full autonomy; a no leaves it as it was.
            const asked = yield* freezeTool
              .run({ repo: "acme/app", reason: "the cut", acrossWorkspaces: true })
              .pipe(Effect.flip, Effect.forkScoped);
            const [card] = yield* waitReal(
              "the card for a freeze across workspaces",
              store
                .listRequests(release.thread.id)
                .pipe(Effect.map((all) => all.length === 1 && all)),
            );
            yield* runtimes.respond(release.thread.id, card!.id, {
              kind: "approval",
              decision: "deny",
              scope: "once",
            });
            expect((yield* Fiber.join(asked)).message).toContain("declined merge_freeze");
            expect(yield* freezes.holding("acme/app", "main", 12, "elsewhere")).toBeUndefined();

            // A yes holds them all.
            const granted = yield* freezeTool
              .run({ repo: "acme/app", reason: "the cut", acrossWorkspaces: true })
              .pipe(Effect.forkScoped);
            const [second] = yield* waitReal(
              "the second card",
              store
                .listRequests(release.thread.id)
                .pipe(Effect.map((all) => all.length === 1 && all)),
            );
            yield* runtimes.respond(release.thread.id, second!.id, {
              kind: "approval",
              decision: "allow",
              scope: "once",
            });
            yield* Fiber.join(granted);
            expect(yield* freezes.holding("acme/app", "main", 12, "elsewhere")).toMatchObject({
              acrossWorkspaces: true,
            });
          }),
        );
      }),
    { timeout: 90_000 },
  );
});
