import { describe, expect, it } from "@effect/vitest";
import type { GramUIMessageChunk } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "./fake-agent.ts";
import { MessageAccumulator } from "./message-accumulator.ts";
import { RuntimeTestLayer, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

describe("agent message ids", () => {
  it.effect("sends the user message id to the agent and records it as the agent id", () =>
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
      const [user] = yield* store.listMessages(thread.id);
      expect(session.sentIds).toEqual([user!.id]);
      expect(user!.metadata?.agentMessageIds).toEqual([user!.id]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it("accumulates assistant agent ids across metadata chunks, in order and without repeats", () => {
    const acc = new MessageAccumulator("m1");
    const chunks = [
      { type: "start", messageMetadata: { agent: "claude", agentMessageIds: ["a"] } },
      { type: "message-metadata", messageMetadata: { agentMessageIds: ["a", "b"] } },
      { type: "finish", messageMetadata: { agentMessageIds: ["c"] } },
    ];
    for (const chunk of chunks) acc.apply(chunk as unknown as GramUIMessageChunk);
    expect(acc.snapshot().metadata).toEqual({ agent: "claude", agentMessageIds: ["a", "b", "c"] });
  });
});
