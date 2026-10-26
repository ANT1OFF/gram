import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "../runtime/test-harness.ts";
import { RETRY_DEADLINE, ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { callAppTool } from "./http-mcp.ts";
import { AppToolRegistry, defineAppTool } from "./registry.ts";

// Invented offline MCP action: no GitHub, CLI account, personal database or real merge.
const setup = (running = true) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const store = yield* ThreadStore;
    const registry = yield* AppToolRegistry;
    let executed = false;
    yield* registry.register([
      defineAppTool({
        descriptor: {
          name: "merge_when_ready",
          class: "outward",
          description: "Merge invented PR.",
        },
        input: Schema.Struct({ pr: Schema.optionalKey(Schema.Number) }),
        handle: () =>
          Effect.sync(() => {
            executed = true;
            return { armed: true };
          }),
      }),
    ]);
    const thread = yield* runtimes.create({
      projectRoot: "/work/invented",
      checkout: { kind: "main", path: "/work/invented" },
      model: { agent: "codex", model: "gpt-6.1-sol" },
    });
    if (running) yield* runtimes.send(thread.id, { text: "invented turn" });
    yield* waitFor(
      "ready",
      runtimes.status(thread.id).pipe(Effect.map((s) => s === (running ? "running" : "idle"))),
    );
    const tool = registry
      .forTransport(thread.id)
      .find((t) => t.descriptor.name === "merge_when_ready")!;
    const call = yield* Effect.forkScoped(callAppTool(tool, {}));
    const card = yield* waitFor("card", store.listRequests(thread.id).pipe(Effect.map(([r]) => r)));
    return { runtimes, store, thread, call, card, executed: () => executed };
  });

describe("merge decline provenance oracle", () => {
  for (const reason of ["completed", "interrupted", "error", "maxTurns"] as const) {
    it.effect(`does not attribute ${reason} turn cleanup to the user`, () =>
      Effect.gen(function* () {
        const { thread, call, card, executed, store } = yield* setup();
        const session = yield* (yield* FakeAgentControl).latest(thread.id);
        yield* session.emit({ type: "turnEnd", reason });
        const result = yield* Fiber.join(call);
        console.info("synthetic-permission-receipt", JSON.stringify(result));
        expect(result).toMatchObject({
          isError: true,
          structuredContent: {
            approvalResolution: {
              origin: "runtime",
              reason: `turn-${reason}`,
              requestId: card.id,
              threadId: thread.id,
            },
          },
        });
        expect(JSON.stringify(result.content)).not.toContain("The user declined");
        expect(executed()).toBe(false);
        expect(yield* store.listRequests(thread.id)).toEqual([]);
      }).pipe(Effect.provide(RuntimeTestLayer)),
    );
  }

  it.effect("does not attribute session shutdown to the user", () =>
    Effect.gen(function* () {
      const { runtimes, thread, call, executed } = yield* setup();
      yield* runtimes.close(thread.id);
      const result = yield* Fiber.join(call);
      console.info("synthetic-permission-receipt", JSON.stringify(result));
      expect(JSON.stringify(result.content)).not.toContain("The user declined");
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          approvalResolution: { origin: "runtime" },
        },
      });
      expect(executed()).toBe(false);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("labels an actual reject response as a user decline", () =>
    Effect.gen(function* () {
      const { runtimes, thread, call, card, executed } = yield* setup();
      yield* runtimes.respond(thread.id, card.id, {
        kind: "approval",
        decision: "deny",
        scope: "once",
      });
      const result = yield* Fiber.join(call);
      console.info("synthetic-permission-receipt", JSON.stringify(result));
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "The user declined merge_when_ready." }],
        structuredContent: {
          approvalResolution: { origin: "user", reason: "rejected", requestId: card.id },
        },
      });
      expect(executed()).toBe(false);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("records explicit Stop as runtime cancellation", () =>
    Effect.gen(function* () {
      const { runtimes, thread, call, executed } = yield* setup();
      yield* runtimes.interrupt(thread.id);
      const result = yield* Fiber.join(call);
      console.info("synthetic-permission-receipt", JSON.stringify(result));
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          approvalResolution: { origin: "runtime", reason: "stop-requested" },
        },
      });
      expect(executed()).toBe(false);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("records an idle session exit without a user decision", () =>
    Effect.gen(function* () {
      const { thread, call, executed } = yield* setup(false);
      yield* (yield* (yield* FakeAgentControl).latest(thread.id)).end();
      const result = yield* Fiber.join(call);
      console.info("synthetic-permission-receipt", JSON.stringify(result));
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          approvalResolution: { origin: "runtime", reason: "session-ended" },
        },
      });
      expect(executed()).toBe(false);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("records the runtime retry deadline without attributing it to the user", () =>
    Effect.gen(function* () {
      const { runtimes, thread, call, executed } = yield* setup();
      let retrying = false;
      yield* runtimes.observe({
        onRetrying: (_, on) =>
          Effect.sync(() => {
            retrying = on;
          }),
      });
      yield* (yield* (yield* FakeAgentControl).latest(thread.id)).emit({
        type: "status",
        status: "retrying",
      });
      yield* waitFor(
        "retrying",
        Effect.sync(() => retrying),
      );
      yield* TestClock.adjust(RETRY_DEADLINE);
      const result = yield* Fiber.join(call);
      console.info("synthetic-permission-receipt", JSON.stringify(result));
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          approvalResolution: { origin: "runtime", reason: "retry-deadline" },
        },
      });
      expect(executed()).toBe(false);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("records runtime shutdown without a user decision", () =>
    Effect.gen(function* () {
      const { runtimes, call, executed } = yield* setup();
      yield* runtimes.shutdown;
      const result = yield* Fiber.join(call);
      console.info("synthetic-permission-receipt", JSON.stringify(result));
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          approvalResolution: { origin: "runtime", reason: "runtime-shutdown" },
        },
      });
      expect(executed()).toBe(false);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("executes only after an actual Allow response", () =>
    Effect.gen(function* () {
      const { runtimes, thread, call, card, executed } = yield* setup();
      yield* runtimes.respond(thread.id, card.id, {
        kind: "approval",
        decision: "allow",
        scope: "once",
      });
      expect(yield* Fiber.join(call)).toEqual({
        content: [{ type: "text", text: '{"armed":true}' }],
      });
      expect(executed()).toBe(true);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("cancels a disconnected MCP call without a decline or execution", () =>
    Effect.gen(function* () {
      const { store, thread, call, executed } = yield* setup();
      yield* Fiber.interrupt(call);
      expect(yield* store.listRequests(thread.id)).toEqual([]);
      expect(executed()).toBe(false);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
