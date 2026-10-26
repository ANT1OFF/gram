import { describe, expect, it } from "@effect/vitest";
import type { Thread, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { FakeAgentControl } from "../../runtime/fake-agent.ts";
import { RuntimeTestLayer } from "../../runtime/test-harness.ts";
import { sessionHandlers } from "./sessions.ts";

describe("sessions.delete", () => {
  it.effect("deletes a past session through its agent, but not one a thread shows", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const handlers = yield* sessionHandlers;
      const projectRoot = tmpdir();

      yield* handlers["sessions.delete"]({ agent: "claude", projectRoot, agentSessionId: "old" });
      expect(fake.deletedSessions).toEqual(["old"]);

      const project = yield* store.ensureProject({ root: projectRoot, name: "tmp" });
      const thread: Thread = {
        id: randomUUID() as ThreadId,
        projectId: project.id,
        title: "Tracing",
        userNamed: true,
        model: { agent: "claude", model: "haiku" },
        mode: "default",
        checkout: { kind: "main", path: projectRoot },
        labels: [],
        pinned: false,
        parked: false,
        unread: false,
        createdAt: 0,
        lastActivityAt: 0,
        agentSessionId: "shown",
      };
      yield* store.insertThread(thread);
      const error = yield* Effect.flip(
        handlers["sessions.delete"]({ agent: "claude", projectRoot, agentSessionId: "shown" }),
      );
      expect(error).toMatchObject({ _tag: "InvalidState", threadId: thread.id });
      expect(error.message).toContain("Tracing");
      expect(fake.deletedSessions).toEqual(["old"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
