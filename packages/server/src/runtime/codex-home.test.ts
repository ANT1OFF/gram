import { describe, expect, it } from "@effect/vitest";
import type { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "./fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

const idle = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    yield* waitFor("idle", runtimes.status(threadId).pipe(Effect.map((s) => s === "idle")));
  });

describe("a thread's Codex home", () => {
  it.effect("is recorded from identity and passed back whenever the session reopens", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
      });
      yield* idle(thread.id);
      const first = fake.sessions[0]!;
      expect(first.options.codexHome).toBeUndefined();

      yield* first.emit({
        type: "identity",
        agentSessionId: first.agentSessionId,
        codexHome: "gateway",
        model: "fake",
        tools: [],
        commands: [],
      });
      yield* waitFor(
        "the recorded home",
        store.getThread(thread.id).pipe(Effect.map((t) => t.codexHome === "gateway")),
      );

      // Before any turn the session opens fresh under the same id, in the same home.
      yield* runtimes.moveCheckout(thread.id, { kind: "worktree", path: "/work/one" });
      const reopened = yield* waitFor(
        "the reopened session",
        Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]),
      );
      expect(reopened.options).toMatchObject({
        sessionId: first.agentSessionId,
        codexHome: "gateway",
      });
      yield* idle(thread.id);

      yield* runtimes.send(thread.id, { text: "work" });
      yield* waitFor(
        "the send",
        Effect.sync(() => reopened.sent.length === 1),
      );
      yield* reopened.completeTurn();
      yield* idle(thread.id);
      yield* runtimes.moveCheckout(thread.id, { kind: "worktree", path: "/work/two" });
      const resumed = yield* waitFor(
        "the resumed session",
        Effect.sync(() => fake.sessions.length === 3 && fake.sessions[2]),
      );
      expect(resumed.options).toMatchObject({
        resumeId: first.agentSessionId,
        codexHome: "gateway",
      });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("resumes a picked session in its listed home, and one with none in the user's", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const picked = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        resumeSessionId: "sess-gateway",
        codexHome: "gateway",
      });
      expect(picked.codexHome).toBe("gateway");
      yield* runtimes.send(picked.id, { text: "continue" });
      const session = yield* waitFor(
        "the resumed session",
        Effect.sync(() => fake.sessions.length === 1 && fake.sessions[0]),
      );
      expect(session.options).toMatchObject({ resumeId: "sess-gateway", codexHome: "gateway" });

      const unrecorded = yield* runtimes.create({
        projectRoot: "/work/other",
        checkout: { kind: "main", path: "/work/other" },
        resumeSessionId: "sess-unrecorded",
      });
      expect(unrecorded.codexHome).toBeUndefined();
      yield* runtimes.send(unrecorded.id, { text: "continue" });
      const unrecordedSession = yield* waitFor(
        "the unrecorded session",
        Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]),
      );
      expect(unrecordedSession.options.resumeId).toBe("sess-unrecorded");
      expect(unrecordedSession.options.codexHome).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
