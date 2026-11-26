// Behind an embedder's GitHub relay, a read or merge made for a thread goes out with that thread's
// handle, so the route answers it for that thread alone.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { armedWorkerBadge } from "../app-tools/pr-tools-kit.ts";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import {
  atAutonomy,
  completeTurn,
  makeWorld,
  openOrchestrator,
  publishGit,
  spawn,
  waitReal,
  withServer,
} from "./test-harness.ts";
import { markGithubRelayed } from "../embedding/github-relay.ts";

markGithubRelayed(true);

describe.skipIf(!hasGit)("GitHub calls made for a thread", () => {
  it.effect(
    "carry that thread's handle, from its tools and from the merge they arm",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            world.originRepos.set(world.repo, "acme/app");
            const { session, thread } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "mail", title: "Mail" });
            yield* completeTurn(worker.session);
            yield* atAutonomy(thread, "full");
            const from = world.ghCalls.length;
            // Its PR's head, which binding it and asking for its merge read on GitHub.
            world.prHeads.set(12, { headRefName: worker.thread.checkout.branch! });
            yield* worker.session.callTool("pr_bind", { repo: "acme/app", number: 12 });
            yield* worker.session.callTool("merge_when_ready", {});
            yield* store
              .getThread(worker.thread.id)
              .pipe(Effect.flatMap((t) => publishGit(world, t, { pr: armedWorkerBadge(true) })));
            yield* waitReal(
              "the merge",
              Effect.sync(() => world.ghCalls.some((c) => c[2] === "merge") || undefined),
            );
            const calls = world.ghCalls
              .map((call, at) => ({ call: call.join(" "), token: world.ghTokens[at] }))
              .slice(from)
              .filter(({ call }) => call.includes("acme/app"));
            expect(calls.some(({ call }) => call.startsWith("gh pr merge"))).toBe(true);
            for (const { token } of calls) expect(token).toBe(`gram-thread:${worker.thread.id}`);
          }),
        );
      }).pipe(Effect.scoped),
    { timeout: 90_000 },
  );
});
