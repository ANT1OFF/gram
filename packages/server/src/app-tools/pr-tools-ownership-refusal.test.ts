import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
} from "../orchestration/test-harness.ts";
import { AppToolRegistry } from "./registry.ts";

describe.skipIf(!hasGit)("ownership doubts stay with the calling agent at full autonomy", () => {
  for (const doubt of ["fork", "other thread", "provider failure"] as const) {
    it.effect(
      `refuses ${doubt} for every ownership-gated tool, then permits re-arming after repair`,
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          yield* withServer(
            world,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              const runtimes = yield* ThreadRuntimes;
              const registry = yield* AppToolRegistry;
              const { session, thread } = yield* openOrchestrator(world);
              const worker = yield* spawn(session, { feature: "repair" });
              const sibling = yield* spawn(session, { feature: "holder" });
              yield* completeTurn(worker.session);
              yield* completeTurn(sibling.session);
              yield* atAutonomy(thread, "full", { mergeReviewPolicy: "bot" });
              world.prHeads.set(12, {
                headRefName: worker.thread.checkout.branch!,
                fork: doubt === "fork",
              });
              yield* runtimes.updateThread(worker.thread.id, (t) => ({
                ...t,
                boundPr: { repo: "acme/app", number: 12, monitor: false },
              }));
              if (doubt === "other thread")
                yield* runtimes.updateThread(sibling.thread.id, (t) => ({
                  ...t,
                  boundPr: { repo: "acme/app", number: 12, monitor: false },
                }));
              if (doubt === "provider failure")
                world.prHeadRead = Effect.die("synthetic provider read failed");
              for (const audience of ["worker", "orchestrator"] as const) {
                const caller = audience === "worker" ? worker.thread.id : thread.id;
                const tools = registry.forTransport(caller, audience);
                const input = audience === "worker" ? {} : { threadId: worker.thread.id };
                for (const name of [
                  "merge_when_ready",
                  "set_auto_merge",
                  ...(audience === "worker" ? ["local_check"] : []),
                ]) {
                  const tool = tools.find((t) => t.descriptor.name === name)!;
                  const refused = yield* tool.run(input).pipe(Effect.flip);
                  expect(refused.message).toContain(
                    "Gram couldn't confirm this one is the worker's own",
                  );
                  expect(refused.message).toContain(`Then call ${name} again`);
                  expect(refused.message).toContain("the user wasn't asked");
                  expect(yield* store.listRequests(caller)).toEqual([]);
                }
              }
              expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
              expect(
                (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady,
              ).toBeUndefined();
              // Repair the cause; the same worker can re-arm without user intervention.
              world.prHeads.set(12, { headRefName: worker.thread.checkout.branch! });
              world.prHeadRead = undefined;
              yield* runtimes.updateThread(sibling.thread.id, ({ boundPr: _bound, ...t }) => t);
              const merge = registry
                .forTransport(worker.thread.id, "worker")
                .find((t) => t.descriptor.name === "merge_when_ready")!;
              yield* merge.run({});
              expect(
                (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady,
              ).toMatchObject({ allowedBy: "autonomy" });
              expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
            }),
          );
        }).pipe(Effect.scoped),
    );
  }

  for (const autonomy of ["supervised", "publish"] as const) {
    it.effect(`keeps ownership cards unchanged at ${autonomy}`, () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const registry = yield* AppToolRegistry;
            const { session, thread } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "card" });
            yield* completeTurn(worker.session);
            yield* store.updateWorkspace(thread.workspaceId!, (state) => ({
              ...state,
              charter: { ...state.charter, autonomy, mergeReviewPolicy: "bot" },
            }));
            world.prHeads.set(12, { headRefName: worker.thread.checkout.branch!, fork: true });
            yield* runtimes.updateThread(worker.thread.id, (t) => ({
              ...t,
              boundPr: { repo: "acme/app", number: 12, monitor: false },
            }));
            const tools = registry.forTransport(worker.thread.id, "worker");
            for (const name of ["merge_when_ready", "set_auto_merge", "local_check"]) {
              const tool = tools.find((t) => t.descriptor.name === name)!;
              const call = yield* Effect.forkScoped(tool.run({}).pipe(Effect.flip));
              const card = yield* waitReal(
                "the ownership card below full",
                store.listRequests(worker.thread.id).pipe(Effect.map((all) => all[0])),
              );
              expect(card).toMatchObject({ kind: "approval", displayName: name, scopes: ["once"] });
              if (card.kind !== "approval") throw new Error("not an approval");
              expect(card.decisionReason).toBeUndefined();
              expect(card.autonomyNote).toBeUndefined();
              yield* runtimes.respond(worker.thread.id, card.id, {
                kind: "approval",
                decision: "deny",
                scope: "once",
              });
              expect((yield* Fiber.join(call)).message).toBe(`The user declined ${name}.`);
            }
            expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
    );
  }
});
