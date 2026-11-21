import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { vi } from "vitest";
import { hasGit } from "../git/test-repo.ts";
import {
  completeTurn,
  makeWorld,
  openOrchestrator,
  spawn,
  withServer,
  type Server,
  type World,
} from "./test-harness.ts";

// Behind an embedding deployment's GitHub route, every `gh` reads with the deployment's access.
vi.mock("../embedding/github-relay.ts", async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  githubRelayed: () => true,
}));

const inServer = <A, E>(body: (world: World) => Effect.Effect<A, E, Server | Scope.Scope>) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    return yield* withServer(world, body(world));
  });

describe.skipIf(!hasGit)("repositories an agent names behind a GitHub route", () => {
  it.effect(
    "are read only when the thread works in them, and refused before any read otherwise",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          world.originRepos.set(world.repo, "acme/app");
          const { session } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "mail", title: "Mail" });
          yield* completeTurn(worker.session);
          const refused = (tool: string, input: Record<string, unknown>) =>
            worker.session.callTool(tool, input).pipe(
              Effect.flip,
              Effect.map((error) => error.message),
            );
          const outside = "isn't a repository this thread works in";
          expect(yield* refused("pr_bind", { repo: "someone/private", number: 5 })).toContain(
            outside,
          );
          expect(
            yield* refused("schedule_wake", { note: "look", onPr: "someone/private#5" }),
          ).toContain(outside);
          expect(
            yield* refused("schedule_wake", {
              note: "look",
              condition: { kind: "branchMoved", repo: "someone/private" },
            }),
          ).toContain(outside);
          expect(yield* refused("depends_on", { pr: "someone/private#5" })).toContain(outside);
          expect(yield* refused("merge_when_ready", { pr: "someone/private#5" })).toContain(
            outside,
          );
          expect(
            yield* refused("merge_when_ready", { pr: 12, after: ["someone/private#5"] }),
          ).toContain(outside);
          expect(
            yield* refused("run_monitor", {
              run: "https://github.com/someone/private/actions/runs/77",
            }),
          ).toContain(outside);
          expect(yield* refused("run_monitor", { repo: "someone/private", run: "77" })).toContain(
            outside,
          );
          // Nothing of it went to GitHub.
          expect(
            world.ghCalls.filter((call) => call.join(" ").includes("someone/private")),
          ).toEqual([]);
          // Its own workspace's repository it binds as before.
          expect(
            yield* worker.session.callTool("pr_bind", { repo: "acme/app", number: 12 }),
          ).toMatchObject({ bound: { repo: "acme/app", number: 12 } });
        }),
      ),
    { timeout: 90_000 },
  );
});
