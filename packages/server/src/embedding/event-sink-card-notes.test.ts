import { describe, expect, it } from "@effect/vitest";
import type { RequestId, SinkBatch, SinkEvent, Thread, ThreadId } from "@gram/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OwnEvent } from "../events/event-hub.ts";
import { makeEventSink } from "./event-sink.ts";

/** A JSON endpoint on loopback that keeps the sink's events in order. */
const receiver = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ server: Server; url: string; held: Array<SinkEvent> }>((resolve) => {
        const held: Array<SinkEvent> = [];
        const server = createServer((request, response) => {
          const chunks: Array<Buffer> = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            const batch = JSON.parse(Buffer.concat(chunks).toString("utf8")) as SinkBatch;
            for (const event of batch.events) if (event.seq === held.length + 1) held.push(event);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ ack: held.length }));
          });
        });
        server.listen(0, "127.0.0.1", () =>
          resolve({
            server,
            url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
            held,
          }),
        );
      }),
  ),
  ({ server }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
);

const eventually = <A>(label: string, check: Effect.Effect<A | undefined | false>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 1000; i++) {
      const value = yield* check;
      if (value !== undefined && value !== false) return value;
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

const threadA = "thread-a" as ThreadId;
const threadB = "thread-b" as ThreadId;
const thread = (id: ThreadId) =>
  ({
    id,
    title: id,
    role: "worker",
    model: { agent: "claude", model: "opus" },
  }) as unknown as Thread;

describe("the event sink's notes on a card", () => {
  it.live("are a thread's own: another thread's card of the same id takes none of them", () =>
    Effect.gen(function* () {
      const to = yield* receiver;
      const events = yield* Queue.unbounded<OwnEvent>();
      const sink = yield* makeEventSink({
        endpoint: { url: to.url, token: "sink-token" },
        file: ":memory:",
        on: Effect.succeed(true),
        threads: Effect.succeed([thread(threadA), thread(threadB)]),
        events: Stream.fromQueue(events),
        retryBase: Duration.millis(5),
        retryMax: Duration.millis(20),
        recheck: Duration.millis(5),
      });
      const id = "req-1" as RequestId;
      yield* sink.noteAnswer(
        id,
        { answeredBy: "ada", proof: { statement: "s", method: "POST", path: "/p", body: "{}" } },
        threadA,
      );
      const resolved = () => to.held.filter((event) => event.type === "ask.resolved");
      yield* Queue.offer(events, {
        type: "thread.requestResolved",
        threadId: threadB,
        requestId: id,
      } as never);
      const [other] = yield* eventually(
        "thread B's resolution",
        Effect.sync(() => resolved().length >= 1 && resolved()),
      );
      expect(other).toMatchObject({ threadId: threadB, data: { id, how: "withdrawn" } });
      expect(other!.actor).toBeUndefined();
      expect(other!.data["proof"]).toBeUndefined();

      yield* Queue.offer(events, {
        type: "thread.requestResolved",
        threadId: threadA,
        requestId: id,
      } as never);
      const own = yield* eventually(
        "thread A's resolution",
        Effect.sync(() => resolved().length >= 2 && resolved()[1]),
      );
      expect(own).toMatchObject({
        threadId: threadA,
        actor: { kind: "person", id: "ada" },
        data: { id, how: "answered", answeredBy: "ada" },
      });
    }),
  );
});
