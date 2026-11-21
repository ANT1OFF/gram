// An embedding's answer over HTTP (`asks/answer`) names the card it was given for: a card with a
// key refuses an answer without it, or with another, and takes nothing from it.

import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent, RequestAnswer, RequestId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { HttpServerResponse, HttpServerRequest } from "../platform/unstable.ts";
import { ThreadStore, type ThreadStoreShape } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { KEYLESS_ANSWER } from "../runtime/card-key.ts";
import { RuntimeTestLayer, waitFor } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { answerAsk } from "./ask-answer.ts";

const ID = "r1" as RequestId;
const allow: RequestAnswer = { kind: "approval", decision: "allow", scope: "once" };

const approval: AgentEvent = {
  type: "request",
  request: {
    kind: "approval",
    id: ID,
    toolName: "Bash",
    displayName: "Bash",
    input: { command: "rm -rf build" },
    suggestions: [],
  },
};

/** The thread as a check made before its card was asked reads it: no card yet. */
const before = (real: ThreadStoreShape) => ({
  appendActorEvents: real.appendActorEvents,
  listRequests: () => Effect.succeed([]),
});

/** An answer posted as an embedding posts it, and what the route said. */
const post = (
  threadId: string,
  shown: string | undefined,
  seen?: (store: ThreadStoreShape) => Pick<ThreadStoreShape, "appendActorEvents" | "listRequests">,
) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const real = yield* ThreadStore;
    const store = seen === undefined ? real : seen(real);
    const body = JSON.stringify({
      threadId,
      requestId: ID,
      answer: allow,
      ...(shown === undefined ? {} : { shown }),
    });
    const response = yield* answerAsk(
      { runtimes, store },
      HttpServerRequest.fromWeb(
        new Request("http://127.0.0.1/asks/answer", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
          },
          body,
        }),
      ),
      { id: "p-1", name: "P", role: "member" },
      "signed",
    );
    const web = HttpServerResponse.toWeb(response);
    return { status: web.status, body: (yield* Effect.promise(() => web.json())) as unknown };
  });

const running = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;
  const fake = yield* FakeAgentControl;
  const thread = yield* runtimes.create({
    projectRoot: "/work/repo",
    checkout: { kind: "main", path: "/work/repo" },
    input: { text: "one" },
  });
  const session = yield* waitFor(
    "the first send",
    fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
  );
  return { thread, session };
});

describe("an embedding's answer to a card", () => {
  it.effect("is refused without the card's key, or with another, and goes with it", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const { thread, session } = yield* running;
      yield* session.emit(approval);
      const card = yield* waitFor(
        "the card",
        store
          .listRequests(thread.id)
          .pipe(Effect.map((requests) => requests.find((request) => request.id === ID) ?? false)),
      );
      expect(card.shown).toBeDefined();
      const keyless = yield* post(thread.id, undefined);
      expect(keyless).toEqual({
        status: 409,
        body: { _tag: "InvalidState", message: KEYLESS_ANSWER },
      });
      const other = yield* post(thread.id, "another-card");
      expect(other.status).toBe(404);
      expect(session.responses).toEqual([]);
      expect((yield* store.listRequests(thread.id)).map((request) => request.id)).toEqual([ID]);
      expect(yield* post(thread.id, card.shown)).toEqual({ status: 200, body: {} });
      expect(session.responses.map((response) => response.requestId)).toEqual([ID]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("is refused without a key when the card is asked again with one after the check", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const { thread, session } = yield* running;
      yield* session.emit(approval);
      yield* waitFor(
        "the card",
        store
          .listRequests(thread.id)
          .pipe(Effect.map((requests) => requests.some((request) => request.id === ID))),
      );
      // The route's early check reads the thread as it stood before the keyed card was asked;
      // the answer must still be refused where it is taken.
      expect(yield* post(thread.id, undefined, before)).toEqual({
        status: 409,
        body: { _tag: "InvalidState", message: KEYLESS_ANSWER },
      });
      expect(session.responses).toEqual([]);
      expect((yield* store.listRequests(thread.id)).map((request) => request.id)).toEqual([ID]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("goes without a key for a card that has none", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const { thread, session } = yield* running;
      // A card stored with no key, as a server before keys stored it.
      if (approval.type !== "request") throw new Error("not a request");
      yield* store.putRequest(thread.id, approval.request, 1);
      expect(yield* post(thread.id, undefined)).toEqual({ status: 200, body: {} });
      expect(session.responses.map((response) => response.requestId)).toEqual([ID]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
