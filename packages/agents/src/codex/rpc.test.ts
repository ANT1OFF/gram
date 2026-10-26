import { describe, expect, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexRpcError, makeCodexRpc } from "./rpc.ts";

const fakeIo = Effect.gen(function* () {
  const written: Array<unknown> = [];
  const lines = yield* Queue.unbounded<string, CodexRpcError | Cause.Done>();
  return {
    io: {
      write: (line: string) => Effect.sync(() => void written.push(JSON.parse(line))),
      lines: Stream.fromQueue(lines),
    },
    written,
    push: (message: unknown) => Queue.offerUnsafe(lines, JSON.stringify(message)),
    end: () => Queue.endUnsafe(lines),
  };
});

/** Lets the forked request write before the test answers it. */
const waitForWrites = (written: ReadonlyArray<unknown>, count: number) =>
  Effect.gen(function* () {
    while (written.length < count) yield* Effect.yieldNow;
  });

describe("makeCodexRpc", () => {
  it.effect("answers requests by id and streams notifications and server requests in order", () =>
    Effect.gen(function* () {
      const f = yield* fakeIo;
      const rpc = yield* makeCodexRpc(f.io);
      const fiber = yield* Effect.forkScoped(
        rpc.request("turn/interrupt", { threadId: "t", turnId: "u" }),
      );
      yield* waitForWrites(f.written, 1);
      expect(f.written).toEqual([
        { id: 0, method: "turn/interrupt", params: { threadId: "t", turnId: "u" } },
      ]);

      f.push({ method: "turn/started", params: { threadId: "t" } });
      // A server request shares the id space of neither side: id 0 here isn't our response.
      f.push({ id: 0, method: "item/tool/requestUserInput", params: { threadId: "t" } });
      f.push({ id: 0, result: {} });
      expect(yield* Fiber.join(fiber)).toEqual({});

      yield* rpc.respond(0, { answers: {} });
      yield* rpc.notify("initialized");
      expect(f.written.slice(1)).toEqual([
        { id: 0, result: { answers: {} } },
        { method: "initialized" },
      ]);

      f.end();
      const messages = yield* Stream.runCollect(rpc.messages);
      expect(messages.map((m) => m.method)).toEqual(["turn/started", "item/tool/requestUserInput"]);
    }),
  );

  it.effect("fails on an error response, and fails pending requests when the server exits", () =>
    Effect.gen(function* () {
      const f = yield* fakeIo;
      const rpc = yield* makeCodexRpc(f.io);
      const rejected = yield* Effect.forkScoped(
        Effect.flip(rpc.request("thread/delete", { threadId: "t" })),
      );
      yield* waitForWrites(f.written, 1);
      f.push({ id: 0, error: { code: -32600, message: "no such thread" } });
      expect(yield* Fiber.join(rejected)).toEqual(
        new CodexRpcError({ method: "thread/delete", message: "no such thread" }),
      );

      const pending = yield* Effect.forkScoped(
        Effect.flip(rpc.request("thread/delete", { threadId: "t" })),
      );
      yield* waitForWrites(f.written, 2);
      f.end();
      expect((yield* Fiber.join(pending)).message).toBe("codex app-server exited");
      expect((yield* Effect.flip(rpc.request("thread/delete", { threadId: "t" }))).message).toBe(
        "codex app-server exited",
      );
    }),
  );
});
