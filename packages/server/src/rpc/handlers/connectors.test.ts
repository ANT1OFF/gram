import { describe, expect, it } from "@effect/vitest";
import type { Thread, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { randomUUID } from "node:crypto";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { FakeAgentControl } from "../../runtime/fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "../../runtime/test-harness.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import { connectorHandlers } from "./connectors.ts";

/** A stored thread no session has been opened for, as after a restart. */
const coldThread = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const project = yield* store.ensureProject({ root: "/work/cold", name: "cold" });
  const thread: Thread = {
    id: randomUUID() as ThreadId,
    projectId: project.id,
    title: "Cold",
    userNamed: true,
    model: { agent: "claude", model: "haiku" },
    mode: "default",
    checkout: { kind: "main", path: "/work/cold", branch: "main" },
    labels: [],
    pinned: false,
    parked: false,
    unread: false,
    createdAt: 0,
    lastActivityAt: 0,
  };
  yield* store.insertThread(thread);
  return thread;
});

describe("connectors RPCs", () => {
  it.effect("list a live session's connectors, and reconnect and toggle them through it", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const handlers = yield* connectorHandlers;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
      });
      yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));

      expect(yield* handlers["connectors.list"]({ threadId: thread.id })).toEqual({
        live: true,
        connectors: [
          { name: "github", status: "connected", scope: "user" },
          {
            name: "linear",
            status: "needs-auth",
            scope: "claudeai",
            url: "https://mcp.linear.app/mcp",
            claudeAi: { id: "mcpsrv_linear" },
          },
        ],
      });
      yield* handlers["connectors.reconnect"]({ threadId: thread.id, name: "linear" });
      yield* handlers["connectors.setEnabled"]({
        threadId: thread.id,
        name: "github",
        enabled: false,
      });
      // Sign-in is the agent's: only the page to open comes back, never a token.
      expect(
        yield* handlers["connectors.authenticate"]({ threadId: thread.id, name: "linear" }),
      ).toEqual({ kind: "open", authorizationUrl: "https://idp.example/authorize?server=linear" });
      expect((yield* fake.latest(thread.id)).connectorCalls).toEqual([
        "reconnect:linear",
        "enable:github:false",
        "authenticate:linear",
      ]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("report a thread without a session instead of starting one", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const handlers = yield* connectorHandlers;
      const thread = yield* coldThread;

      expect(yield* handlers["connectors.list"]({ threadId: thread.id })).toEqual({
        live: false,
        reason: "noSession",
      });
      expect(
        yield* handlers["connectors.reconnect"]({ threadId: thread.id, name: "github" }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({
        _tag: "InvalidState",
        message: "Start the thread to change its connectors.",
      });
      expect(
        yield* handlers["connectors.setEnabled"]({
          threadId: thread.id,
          name: "github",
          enabled: true,
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "InvalidState" });
      expect(
        yield* handlers["connectors.authenticate"]({ threadId: thread.id, name: "github" }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ message: "Start the thread to change its connectors." });
      expect(yield* runtimes.status(thread.id)).toBe("cold");

      expect(
        yield* handlers["connectors.list"]({ threadId: "missing" as ThreadId }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "ThreadNotFound" });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
