// The decision hook over an action the server takes itself (`embedding/guard.ts`), against a real
// HTTP endpoint on loopback: a refusal stops it, an ask raises a card that carries the decision, and
// an answer the hook doesn't take raises a new card rather than ending the action.
import { describe, expect, it } from "@effect/vitest";
import type { DecisionRequest, Thread, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { endpoint, setHosted } from "./acceptance-harness.ts";
import { DecisionHook } from "./decision-hook.ts";
import { makeActionGuard } from "./guard.ts";
import { ActingPerson } from "./person.ts";

describe("decision hook: an action the server takes", () => {
  const thread = { id: "thread-1" as ThreadId } as Thread;
  const question = {
    action: "pr.merge" as const,
    initiator: "person" as const,
    detail: { repo: "acme/app", number: 12 },
  };
  const card = Effect.succeed({
    toolName: "pr.merge",
    displayName: "Merge",
    description: "Merge",
    input: {},
  });

  it.live("a refusal fails the action with the reason; off, it is let through unasked", () =>
    Effect.gen(function* () {
      let calls = 0;
      const hook = yield* endpoint<DecisionRequest>(() => {
        calls++;
        return { json: { decision: "refuse", reason: "Merges are frozen." } };
      });
      const layer = DecisionHook.layer.pipe(
        Layer.provideMerge(ThreadStore.layerSqlite(":memory:")),
        Layer.provideMerge(ServerConfig.layer({ ...TEST_CONFIG, decisionHook: { url: hook.url } })),
        Layer.orDie,
      );
      yield* Effect.gen(function* () {
        const guard = makeActionGuard({
          hook: yield* DecisionHook,
          store: { getThread: () => Effect.succeed(thread) },
          runtimes: { requestApproval: () => Effect.die("no card is raised") },
        });
        // Off, it is let through unasked, and says the hook did not decide it.
        expect(yield* guard(thread.id, question, card)).toBe(false);
        expect(calls).toBe(0);
        yield* setHosted(true);
        const refused = yield* Effect.flip(guard(thread.id, question, card));
        expect(refused.message).toBe("Refused by policy (pr.merge): Merges are frozen.");
        expect(calls).toBe(1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.live("ask waits for a person, then asks again; a rejection stops it there", () =>
    Effect.gen(function* () {
      const asked: Array<DecisionRequest> = [];
      const hook = yield* endpoint<DecisionRequest>((body) => {
        asked.push(body);
        return { json: { decision: body.approval === undefined ? "ask" : "allow" } };
      });
      const layer = DecisionHook.layer.pipe(
        Layer.provideMerge(ThreadStore.layerSqlite(":memory:")),
        Layer.provideMerge(ServerConfig.layer({ ...TEST_CONFIG, decisionHook: { url: hook.url } })),
        Layer.orDie,
      );
      yield* Effect.gen(function* () {
        yield* setHosted(true);
        const answers: Array<"allow" | "deny"> = ["allow", "deny"];
        const notes: Array<unknown> = [];
        const guard = makeActionGuard({
          hook: yield* DecisionHook,
          store: { getThread: () => Effect.succeed(thread) },
          runtimes: {
            requestApproval: (_threadId, _reach, _request, decided) =>
              Effect.succeed({
                kind: "approval" as const,
                decision: answers.shift()!,
                scope: "once" as const,
                answeredBy: "person-2",
                resolution: {
                  threadId: thread.id,
                  requestId: "card-1" as never,
                  origin: "user" as const,
                  reason: "approved",
                  resolvedAt: 0,
                },
              }).pipe(Effect.tap(() => Effect.sync(() => void notes.push(decided)))),
          },
        });
        // The person who pressed the button is the actor; the one who approved the card is named
        // on the second call.
        expect(
          yield* guard(thread.id, question, card).pipe(
            Effect.provideService(ActingPerson, "person-1"),
          ),
        ).toBe(true);
        // The card carries the decision that asked for it, so the host takes its answer as that
        // decision's approval (`ask.opened`'s `decisionId`).
        expect(notes).toEqual([{ decisionId: asked[0]!.id }]);
        expect(asked.map((request) => request.actor)).toEqual([
          { kind: "person", id: "person-1" },
          { kind: "person", id: "person-1" },
        ]);
        expect(asked.map((request) => request.approval)).toEqual([
          undefined,
          { decisionId: asked[0]!.id, askId: "card-1", answeredBy: "person-2" },
        ]);
        // A person's rejection goes to the hook too, which can only ask again: it never allows.
        const refused = yield* Effect.flip(guard(thread.id, question, card));
        expect(refused.message).toBe("Not approved (pr.merge).");
        expect(asked).toHaveLength(4);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.live(
    "an answer the hook doesn't take raises a new card, so it neither allows nor ends it",
    () =>
      Effect.gen(function* () {
        const asked: Array<DecisionRequest> = [];
        const hook = yield* endpoint<DecisionRequest>((body) => {
          asked.push(body);
          // The first answer is from someone the hook doesn't name: it asks again.
          return {
            json: {
              decision: asked.length === 3 ? "allow" : "ask",
              ...(asked.length === 2 ? { reason: "Not theirs to approve." } : {}),
            },
          };
        });
        const layer = DecisionHook.layer.pipe(
          Layer.provideMerge(ThreadStore.layerSqlite(":memory:")),
          Layer.provideMerge(
            ServerConfig.layer({ ...TEST_CONFIG, decisionHook: { url: hook.url } }),
          ),
          Layer.orDie,
        );
        yield* Effect.gen(function* () {
          yield* setHosted(true);
          const cards: Array<{ reason: unknown; decided: unknown }> = [];
          const guard = makeActionGuard({
            hook: yield* DecisionHook,
            store: { getThread: () => Effect.succeed(thread) },
            runtimes: {
              requestApproval: (_threadId, _reach, request, decided) =>
                Effect.sync(() => {
                  cards.push({ reason: request.decisionReason, decided });
                  return {
                    kind: "approval" as const,
                    decision: "allow" as const,
                    scope: "once" as const,
                    answeredBy: cards.length === 1 ? "someone-else" : "approver",
                    resolution: {
                      threadId: thread.id,
                      requestId: `card-${cards.length}` as never,
                      origin: "user" as const,
                      reason: "approved",
                      resolvedAt: 0,
                    },
                  };
                }),
            },
          });
          expect(yield* guard(thread.id, question, card)).toBe(true);
          // Each card carries the decision that raised it, and the second says why it was raised.
          expect(cards).toEqual([
            { reason: undefined, decided: { decisionId: asked[0]!.id } },
            { reason: "Not theirs to approve.", decided: { decisionId: asked[1]!.id } },
          ]);
          expect(asked.map((request) => request.approval?.answeredBy)).toEqual([
            undefined,
            "someone-else",
            "approver",
          ]);
        }).pipe(Effect.provide(layer));
      }),
  );
});
