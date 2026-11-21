// An answer names the card it was given for (`PendingRequest.shown`): a card the agent put up again
// under the same id never takes an answer given for the one before it.

import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent, RequestId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "./fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

const ID = "r1" as RequestId;

const approval = (command: string, id: RequestId = ID): AgentEvent => ({
  type: "request",
  request: {
    kind: "approval",
    id,
    toolName: "Bash",
    displayName: "Bash",
    input: { command },
    suggestions: [],
  },
});

describe("an answer given for a card", () => {
  it.effect("is never taken by a card asked again under its id", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
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
      const cardOf = (command: string) =>
        waitFor(
          `the card for ${command}`,
          store
            .listRequests(thread.id)
            .pipe(
              Effect.map(
                (requests) =>
                  requests.find(
                    (request) =>
                      request.id === ID &&
                      request.kind === "approval" &&
                      request.input["command"] === command,
                  ) ?? false,
              ),
            ),
        );
      yield* session.emit(approval("rm -rf build"));
      const first = yield* cardOf("rm -rf build");
      // The person's click is on its way when the agent asks again, for something else.
      yield* session.emit(approval("git push --force"));
      const second = yield* cardOf("git push --force");
      expect(first.shown).toBeDefined();
      expect(second.shown).not.toBe(first.shown);
      const allow = { kind: "approval", decision: "allow", scope: "once" } as const;
      const stale = yield* runtimes.respond(thread.id, ID, allow, first.shown).pipe(Effect.flip);
      expect(stale._tag).toBe("RequestNotFound");
      const [many] = yield* runtimes.respondMany([
        { threadId: thread.id, requestId: ID, answer: allow, shown: first.shown },
      ]);
      expect(many).toMatchObject({ ok: false });
      expect(session.responses).toEqual([]);
      // Given for the card as it now stands, it goes.
      yield* runtimes.respond(thread.id, ID, allow, second.shown);
      expect(session.responses.map((response) => response.requestId)).toEqual([ID]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps the card of a request replayed as it was, and the answer given for it", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
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
      yield* session.emit(approval("rm -rf build"));
      const card = yield* waitFor(
        "the card",
        store
          .listRequests(thread.id)
          .pipe(Effect.map((requests) => requests.find((request) => request.id === ID) ?? false)),
      );
      // A session that redialled asks again for what it still waits on, as it was.
      yield* session.emit(approval("rm -rf build"), approval("ls", "r2" as RequestId));
      // Taken in order: once the next request is up, the replay was handled.
      yield* waitFor(
        "the request after the replay",
        store
          .listRequests(thread.id)
          .pipe(Effect.map((requests) => requests.some((request) => request.id === "r2"))),
      );
      expect((yield* store.listRequests(thread.id)).find((request) => request.id === ID)).toEqual(
        card,
      );
      yield* runtimes.respond(
        thread.id,
        ID,
        { kind: "approval", decision: "allow", scope: "once" },
        card.shown,
      );
      expect(session.responses.map((response) => response.requestId)).toEqual([ID]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
