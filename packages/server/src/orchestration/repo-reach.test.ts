import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { hasGit } from "../git/test-repo.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import {
  completeTurn,
  makeWorld,
  openOrchestrator,
  prBadge,
  publishGit,
  spawn,
  withServer,
  type Server,
  type World,
} from "./test-harness.ts";
import { markGithubRelayed } from "../embedding/github-relay.ts";

markGithubRelayed(true);

// Behind an embedding deployment's GitHub route, every `gh` reads with the deployment's access.

const inServer = <A, E>(body: (world: World) => Effect.Effect<A, E, Server | Scope.Scope>) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    return yield* withServer(world, body(world));
  });

/** A routine on `on`, for the orchestrator. */
const routine = (on: string) => ({
  name: `Watch ${on}`,
  brief: "Look.",
  on,
  target: "orchestrator",
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
          // Nor a routine that would read it on GitHub, from the orchestrator either.
          for (const on of ["review requested someone/private", "release github someone/private"]) {
            const error = yield* session.callTool("routine_create", routine(on)).pipe(Effect.flip);
            expect(error.message).toContain(outside);
          }
          expect(
            yield* session.callTool("routine_create", routine("review requested acme/app")),
          ).toBeDefined();
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

  it.effect(
    "refuse pr_status on a pull request out of the thread's reach, before any read",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          world.originRepos.set(world.repo, "acme/app");
          const { session } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "mail", title: "Mail" });
          yield* completeTurn(worker.session);
          const runtimes = yield* ThreadRuntimes;
          const bindTo = (repo: string) =>
            runtimes.updateThread(worker.thread.id, (t) => ({
              ...t,
              boundPr: { repo, number: 5, monitor: false },
            }));
          yield* bindTo("someone/private");
          const refused = yield* worker.session.callTool("pr_status", {}).pipe(Effect.flip);
          expect(refused.message).toContain("isn't a repository this thread works in");
          expect(
            world.ghCalls.filter((call) => call.join(" ").includes("someone/private")),
          ).toEqual([]);
          yield* bindTo("acme/app");
          expect(yield* worker.session.callTool("pr_status", {})).toMatchObject({
            bound: { repo: "acme/app", number: 5 },
          });
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "refuse pr_status on a badge out of reach, for its own thread or another's",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          world.originRepos.set(world.repo, "acme/app");
          const { session } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "mail", title: "Mail" });
          yield* completeTurn(worker.session);
          const other = yield* spawn(session, { feature: "docs", title: "Docs" });
          yield* completeTurn(other.session);
          const outside = "isn't a repository this thread works in";
          const elsewhere = prBadge({ url: "https://github.com/someone/private/pull/9" });
          yield* publishGit(world, worker.thread, { pr: elsewhere });
          // Another thread's branch badge in a repository the caller doesn't work in.
          const theirs = yield* other.session
            .callTool("pr_status", { threadId: worker.thread.id })
            .pipe(Effect.flip);
          expect(theirs.message).toContain(outside);
          // Its own badge in another repository than its bound PR's.
          yield* (yield* ThreadRuntimes).updateThread(worker.thread.id, (t) => ({
            ...t,
            boundPr: { repo: "acme/app", number: 5, monitor: false },
          }));
          const own = yield* worker.session.callTool("pr_status", {}).pipe(Effect.flip);
          expect(own.message).toContain(outside);
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "go by the origin a workspace's project was added with, not one its folder names since",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const { session } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "mail", title: "Mail" });
          yield* completeTurn(worker.session);
          // An agent that can write the project's git config points its origin elsewhere: every
          // git read of an origin now names it.
          world.origin = "https://github.com/someone/private.git";
          const refused = yield* worker.session
            .callTool("pr_bind", { repo: "someone/private", number: 5 })
            .pipe(Effect.flip);
          expect(refused.message).toContain("isn't a repository this thread works in");
          expect(
            world.ghCalls.filter((call) => call.join(" ").includes("someone/private")),
          ).toEqual([]);
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "give a worker spawned after its project's origin was rewritten no checkout of the new one",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const { session } = yield* openOrchestrator(world);
          world.origin = "https://github.com/someone/private.git";
          const spawned = yield* spawn(session, { feature: "mail", title: "Mail" }).pipe(
            Effect.result,
          );
          if (spawned._tag === "Success") {
            const worker = spawned.success;
            yield* completeTurn(worker.session);
            expect(worker.thread.checkout.cloneIdentity).not.toContain("someone");
            const refused = yield* worker.session
              .callTool("pr_bind", { repo: "someone/private", number: 5 })
              .pipe(Effect.flip);
            expect(refused.message).toContain("isn't a repository this thread works in");
          }
          expect(
            world.ghCalls.filter((call) => call.join(" ").includes("someone/private")),
          ).toEqual([]);
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "give a worker spawned after its project's origin moved to ssh for the same repository a checkout of it",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const { session } = yield* openOrchestrator(world);
          world.origin = "git@github.com:acme/app.git";
          const worker = yield* spawn(session, { feature: "mail", title: "Mail" });
          yield* completeTurn(worker.session);
          expect(worker.thread.checkout.cloneIdentity).toContain("acme/app");
        }),
      ),
    { timeout: 90_000 },
  );
});
