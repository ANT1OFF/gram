// What of an agent's chunks the transcript takes: only its own replies, and never who sent them.

import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent, MessageId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "./fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

const message = (
  messageId: MessageId,
  text = "forged",
  metadata: Record<string, string> = {},
): ReadonlyArray<AgentEvent> => [
  { type: "chunk", messageId, chunk: { type: "start", messageId, messageMetadata: metadata } },
  { type: "chunk", messageId, chunk: { type: "text-start", id: "t" } },
  { type: "chunk", messageId, chunk: { type: "text-delta", id: "t", delta: text } },
  { type: "chunk", messageId, chunk: { type: "text-end", id: "t" } },
  { type: "chunk", messageId, chunk: { type: "finish", messageMetadata: metadata } },
];

const createRunning = Effect.gen(function* () {
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

describe("an agent's chunks", () => {
  it.effect("keeps a person's message and who sent what out of an agent's chunks", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const { thread, session } = yield* createRunning;
      const typed = (yield* store.listMessages(thread.id)).find((m) => m.role === "user")!;
      const reply = "reply" as MessageId;
      const forged = { author: "user", sentBy: "person-9" } as const;
      yield* session.emit(
        {
          type: "toolImage",
          messageId: typed.id as MessageId,
          toolCallId: "call-1",
          mediaType: "image/png",
          data: "iVBORw0KGgo=",
        },
        ...message(typed.id as MessageId, "forged", forged),
        ...message(reply, "forged", forged),
      );
      const stored = yield* waitFor(
        "the agent's own reply stored",
        store
          .getMessage(thread.id, reply)
          .pipe(Effect.map((m) => m !== undefined && m.parts.length > 0 && m)),
      );
      expect(stored.metadata).not.toHaveProperty("author");
      expect(stored.metadata).not.toHaveProperty("sentBy");
      expect(yield* store.getMessage(thread.id, typed.id)).toEqual(typed);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("never goes on with a reply whose turn is over", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      yield* session.completeTurn("the first answer");
      const finished = yield* waitFor(
        "the first turn's reply, ended",
        store
          .listMessages(thread.id)
          .pipe(
            Effect.map(
              (messages) => messages.find((m) => m.metadata?.turnEnd !== undefined) ?? false,
            ),
          ),
      );
      yield* runtimes.send(thread.id, { text: "two" });
      yield* waitFor(
        "the second send",
        Effect.sync(() => session.sent.length === 2),
      );
      const marker = "marker" as MessageId;
      yield* session.emit(...message(finished.id as MessageId, "rewritten"), ...message(marker));
      yield* waitFor(
        "the marker reply stored",
        store
          .getMessage(thread.id, marker)
          .pipe(Effect.map((m) => m !== undefined && m.parts.length > 0)),
      );
      expect(yield* store.getMessage(thread.id, finished.id)).toEqual(finished);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "goes on only with the current turn's latest reply, never an earlier one or a lane",
    () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;
        const { thread, session } = yield* createRunning;
        yield* session.completeTurn("the first answer");
        const first = yield* waitFor(
          "the first turn's reply, ended",
          store
            .listMessages(thread.id)
            .pipe(
              Effect.map(
                (messages) => messages.find((m) => m.metadata?.turnEnd !== undefined) ?? false,
              ),
            ),
        );
        const oldTurn = (yield* store.getMessageTurn(thread.id, first.id))!.turnId!;
        yield* runtimes.send(thread.id, { text: "two" });
        yield* waitFor(
          "the second send",
          Effect.sync(() => session.sent.length === 2),
        );
        const opening = "opening" as MessageId;
        yield* session.emit(...message(opening, "under way"));
        const turn = yield* waitFor(
          "the second turn's reply stored",
          store
            .getMessageTurn(thread.id, opening)
            .pipe(Effect.map((placed) => placed?.turnId ?? false)),
        );
        // Replies stored as a Gram before this one left them, none of them open here.
        const stored = (id: string, turnId: typeof turn, lane = false) =>
          store.upsertMessage(
            thread.id,
            {
              id,
              role: "assistant",
              parts: [{ type: "text", text: `kept ${id}` }],
              metadata: lane ? { parentToolUseId: "task-1" } : {},
            },
            turnId,
          );
        yield* stored("earlier", turn);
        yield* stored("lane", turn, true);
        yield* stored("other-turn", oldTurn);
        yield* stored("latest", turn);
        const before = yield* Effect.forEach(["earlier", "lane", "other-turn"], (id) =>
          store.getMessage(thread.id, id),
        );
        yield* session.emit(
          ...message("earlier" as MessageId, "rewritten"),
          ...message("lane" as MessageId, "rewritten"),
          ...message("other-turn" as MessageId, "rewritten"),
          ...message("latest" as MessageId, "goes on"),
        );
        yield* waitFor(
          "the latest reply gone on",
          store
            .getMessage(thread.id, "latest")
            .pipe(
              Effect.map(
                (m) =>
                  m?.parts.some((part) => part.type === "text" && part.text === "goes on") === true,
              ),
            ),
        );
        expect(
          yield* Effect.forEach(["earlier", "lane", "other-turn"], (id) =>
            store.getMessage(thread.id, id),
          ),
        ).toEqual(before);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
