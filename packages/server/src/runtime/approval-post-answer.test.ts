import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "./agent-hosts.ts";
import { FakeAgentAdapter, FakeAgentControl } from "./fake-agent.ts";
import { CheckoutService, TurnHooks } from "./hooks.ts";
import { makeRuntimeTestLayer, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

// Invented account-free Codex sessions. The barrier blocks provider I/O after the app answer.
describe("app approval post-answer interruption", () => {
  for (const decision of ["allow", "deny"] as const) {
    for (const lifecycle of ["stop", "session-end", "shutdown", "close"] as const) {
      it.effect(
        `${decision} remains decided while cancellation releases ${lifecycle} and lock waiters`,
        () =>
          Effect.gen(function* () {
            let armed = false;
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const agents = Layer.effectContext(
              Effect.gen(function* () {
                const hosts = yield* AgentHosts;
                const control = yield* FakeAgentControl;
                return Context.make(
                  AgentHosts,
                  AgentHosts.of({
                    get: (kind) =>
                      hosts.get(kind).pipe(
                        Effect.map((host) => ({
                          ...host,
                          open: (options) =>
                            host.open(options).pipe(
                              Effect.map((session) => ({
                                ...session,
                                send: (input, sendOptions) =>
                                  armed
                                    ? Deferred.succeed(entered, undefined).pipe(
                                        Effect.andThen(Deferred.await(release)),
                                        Effect.andThen(session.send(input, sendOptions)),
                                      )
                                    : session.send(input, sendOptions),
                              })),
                            ),
                        })),
                      ),
                  }),
                ).pipe(Context.add(FakeAgentControl, control));
              }),
            ).pipe(Layer.provide(FakeAgentAdapter));

            yield* Effect.gen(function* () {
              const rt = yield* ThreadRuntimes;
              const store = yield* ThreadStore;
              const control = yield* FakeAgentControl;
              const thread = yield* rt.create({
                projectRoot: "/invented",
                checkout: { kind: "main", path: "/invented" },
                model: { agent: "codex", model: "gpt-6.1-sol" },
                mode: "default",
              });
              yield* waitFor("idle", rt.status(thread.id).pipe(Effect.map((s) => s === "idle")));
              const session = control.sessions[0]!;
              let completed = 0;
              const asking = yield* Effect.forkScoped(
                rt
                  .requestApproval(thread.id, {
                    toolName: "invented",
                    displayName: "Invented",
                    input: {},
                    suggestions: [],
                    scopes: ["once"],
                  })
                  .pipe(Effect.tap(() => Effect.sync(() => completed++))),
              );
              const card = yield* waitFor(
                "card",
                store.listRequests(thread.id).pipe(Effect.map((cards) => cards[0])),
              );
              yield* rt.requestSystemDelivery(thread.id, "invented-queued", {
                build: () => Effect.succeed({ text: "invented queued" }),
                accepted: () => Effect.void,
                failed: () => Effect.void,
              });
              armed = true;
              const answer = { kind: "approval" as const, decision, scope: "once" as const };
              const responder = yield* Effect.forkScoped(rt.respond(thread.id, card.id, answer));
              yield* Deferred.await(entered);
              const decided = yield* Fiber.join(asking);
              const ending = yield* Effect.forkScoped(
                lifecycle === "stop"
                  ? rt.interrupt(thread.id)
                  : lifecycle === "shutdown"
                    ? rt.shutdown
                    : lifecycle === "close"
                      ? rt.close(thread.id)
                      : session
                          .end()
                          .pipe(
                            Effect.andThen(
                              waitFor(
                                "session exited",
                                rt.status(thread.id).pipe(Effect.map((s) => s === "error")),
                              ),
                            ),
                          ),
              );
              const cancel = yield* Effect.forkScoped(Fiber.interrupt(responder));
              const duplicate = yield* Effect.forkScoped(
                Effect.exit(rt.respond(thread.id, card.id, answer)),
              );
              for (let i = 0; i < 100; i++) yield* Effect.yieldNow;
              const observed = {
                responder: responder.pollUnsafe(),
                cancel: cancel.pollUnsafe(),
                duplicate: duplicate.pollUnsafe(),
                ending: ending.pollUnsafe(),
                sent: session.sent.length,
                completed,
              };
              // Release before assertions: unchanged failing source must also tear down safely.
              armed = false;
              yield* Deferred.succeed(release, undefined);
              yield* Fiber.join(cancel);
              const duplicateExit = yield* Fiber.join(duplicate);
              yield* Fiber.join(ending);
              expect(decided).toMatchObject({
                decision,
                resolution: {
                  origin: "user",
                  reason: decision === "allow" ? "approved" : "rejected",
                },
              });
              expect(yield* Fiber.join(asking)).toEqual(decided);
              expect(observed.completed).toBe(1);
              expect(observed.sent).toBe(0);
              expect(session.sent).toHaveLength(0);
              expect(observed.responder).toBeDefined();
              expect(observed.cancel).toBeDefined();
              expect(observed.duplicate).toBeDefined();
              expect(observed.ending).toBeDefined();
              expect(Exit.isFailure(duplicateExit)).toBe(true);
            }).pipe(
              Effect.ensuring(Deferred.succeed(release, undefined)),
              Effect.provide(
                makeRuntimeTestLayer(
                  TurnHooks.layerNoop,
                  CheckoutService.layerNoGit,
                  undefined,
                  agents,
                ),
              ),
            );
          }),
      );
    }
  }
});
