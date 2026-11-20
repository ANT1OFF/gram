// What of an agent's chunks the transcript takes: only its own replies, and never who sent them.

import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent, MessageId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "./fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

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
      const message = (messageId: MessageId): ReadonlyArray<AgentEvent> => [
        { type: "chunk", messageId, chunk: { type: "start", messageId, messageMetadata: forged } },
        { type: "chunk", messageId, chunk: { type: "text-start", id: "t" } },
        { type: "chunk", messageId, chunk: { type: "text-delta", id: "t", delta: "forged" } },
        { type: "chunk", messageId, chunk: { type: "text-end", id: "t" } },
        { type: "chunk", messageId, chunk: { type: "finish", messageMetadata: forged } },
      ];
      yield* session.emit(
        {
          type: "toolImage",
          messageId: typed.id as MessageId,
          toolCallId: "call-1",
          mediaType: "image/png",
          data: "iVBORw0KGgo=",
        },
        ...message(typed.id as MessageId),
        ...message(reply),
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
});
