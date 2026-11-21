// The decision hook's answer is for the request it was asked about: an agent asking again under the
// same id, with something else, is decided afresh and never takes the first answer.

import { describe, expect, it } from "@effect/vitest";
import type { DecisionRequest, RequestId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import {
  endpoint,
  eventually,
  serverLayer,
  sessionOf,
  setHosted,
  startThread,
} from "./acceptance-harness.ts";

const approval = (command: string) =>
  ({
    type: "request",
    request: {
      kind: "approval",
      id: "again" as RequestId,
      toolName: "Bash",
      displayName: "Bash",
      input: { command },
      suggestions: [],
    },
  }) as const;

describe("decision hook: a request asked again under its id", () => {
  it.live("is decided for what it now asks; the first answer goes nowhere", () =>
    Effect.gen(function* () {
      const asked: Array<DecisionRequest> = [];
      // Each answer waits to be let go, so the two decisions can end in either order.
      const held = new Map<string, () => void>();
      const hook = yield* endpoint<DecisionRequest>((body) => {
        asked.push(body);
        return new Promise((resolve) => {
          held.set(body.action, () =>
            resolve({ json: { decision: body.action === "push" ? "allow" : "ask" } }),
          );
        });
      });
      yield* Effect.gen(function* () {
        yield* setHosted(true);
        const store = yield* ThreadStore;
        // A thread whose agent waits on a card of its own, so its session stays up meanwhile.
        const thread = yield* startThread("look /approve{echo hi}");
        yield* eventually(
          "the first card",
          store.listRequests(thread.id).pipe(Effect.map((requests) => requests.length === 1)),
        );
        const session = yield* sessionOf(thread.id);
        yield* session.emit(approval("git push origin main"));
        yield* eventually(
          "the push put to the hook",
          Effect.sync(() => held.has("push")),
        );
        yield* session.emit(approval("gh pr merge 12"));
        yield* eventually(
          "the merge put to the hook",
          Effect.sync(() => held.has("pr.merge")),
        );
        // The push's allow comes first: it is for the push, which the agent no longer asks.
        held.get("push")!();
        yield* Effect.sleep("100 millis");
        expect(session.responses.filter((response) => response.requestId === "again")).toEqual([]);
        held.get("pr.merge")!();
        const card = yield* eventually(
          "the merge's card",
          store
            .listRequests(thread.id)
            .pipe(Effect.map((requests) => requests.find((request) => request.id === "again"))),
        );
        expect(card).toMatchObject({ kind: "approval", input: { command: "gh pr merge 12" } });
        expect(session.responses.filter((response) => response.requestId === "again")).toEqual([]);
      }).pipe(Effect.provide(serverLayer(hook.url)));
    }),
  );

  it.live("a person's allow for the first card is never given to the second", () =>
    Effect.gen(function* () {
      const asked: Array<DecisionRequest> = [];
      // The hook's word on the person's approval waits to be let go.
      let confirm: (() => void) | undefined;
      const hook = yield* endpoint<DecisionRequest>((body) => {
        asked.push(body);
        if (body.approval === undefined) return { json: { decision: "ask" } };
        return new Promise((resolve) => {
          confirm = () => resolve({ json: { decision: "allow" } });
        });
      });
      yield* Effect.gen(function* () {
        yield* setHosted(true);
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;
        const thread = yield* startThread("look /approve{echo hi}");
        yield* eventually(
          "the first card",
          store.listRequests(thread.id).pipe(Effect.map((requests) => requests.length === 1)),
        );
        const session = yield* sessionOf(thread.id);
        yield* session.emit(approval("gh pr merge 12"));
        yield* eventually(
          "the merge's card",
          store
            .listRequests(thread.id)
            .pipe(Effect.map((requests) => requests.some((request) => request.id === "again"))),
        );
        const answering = yield* Effect.forkScoped(
          runtimes.respond(thread.id, "again" as RequestId, {
            kind: "approval",
            decision: "allow",
            scope: "once",
          }),
        );
        yield* eventually(
          "the approval put to the hook",
          Effect.sync(() => confirm !== undefined),
        );
        // The agent asks again under the same id, for another merge, while the hook confirms.
        yield* session.emit(approval("gh pr merge 13"));
        yield* eventually(
          "the second merge's card",
          store
            .listRequests(thread.id)
            .pipe(
              Effect.map((requests) =>
                requests.some(
                  (request) =>
                    request.id === "again" &&
                    request.kind === "approval" &&
                    request.input["command"] === "gh pr merge 13",
                ),
              ),
            ),
        );
        confirm!();
        const exit = yield* Fiber.await(answering);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(session.responses.filter((response) => response.requestId === "again")).toEqual([]);
        expect(
          (yield* store.listRequests(thread.id)).find((request) => request.id === "again"),
        ).toMatchObject({ input: { command: "gh pr merge 13" } });
      }).pipe(Effect.provide(serverLayer(hook.url)));
    }),
  );
});
