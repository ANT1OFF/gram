// An embedding host's conversations: which thread owns each, a reply going out through the event
// sink to a real receiver on loopback, a hand-over, and the return when a worker closes.
import { describe, expect, it } from "@effect/vitest";
import { applySettingsPatch, type SinkBatch, type SinkEvent, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ConversationAppToolsLive } from "../app-tools/conversation-tools.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl, makeFakeAgentAdapter } from "../runtime/fake-agent.ts";
import { CheckoutService, TurnHooks } from "../runtime/hooks.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { UsageLimitReadings } from "../usage/limit-readings.ts";
import { Conversations } from "./conversations.ts";
import { EventSink } from "./event-sink.ts";

/** A sink receiver on loopback that keeps what it is sent, in order. */
const receiver = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ close: () => void; url: string; held: Array<SinkEvent> }>((resolve) => {
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
            held,
            url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
            close: () => {
              server.closeAllConnections();
              server.close();
            },
          }),
        );
      }),
  ),
  ({ close }) => Effect.sync(close),
);

const serverLayer = (sinkUrl: string) =>
  ConversationAppToolsLive.pipe(
    Layer.provideMerge(Conversations.layer),
    Layer.provideMerge(AppToolRegistry.layer),
    Layer.provideMerge(ThreadRuntimes.layerOnLocalHost),
    Layer.provideMerge(UsageLimitReadings.layer),
    Layer.provideMerge(EventSink.layer),
    Layer.provideMerge(EventHub.layer),
    Layer.provideMerge(ThreadStore.layerSqlite(":memory:")),
    Layer.provideMerge(makeFakeAgentAdapter({ reply: "echo" })),
    Layer.provideMerge(TurnHooks.layerNoop),
    Layer.provideMerge(CheckoutService.layerNoGit),
    Layer.provideMerge(
      ServerConfig.layer({ ...TEST_CONFIG, eventSink: { url: sinkUrl, token: "sink-token" } }),
    ),
    Layer.orDie,
  );

const eventually = <A, E, R>(label: string, check: Effect.Effect<A | undefined | false, E, R>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 1000; i++) {
      const value = yield* check;
      if (value !== undefined && value !== false) return value;
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

const ofType = (held: ReadonlyArray<SinkEvent>, type: string) =>
  held.filter((event) => event.type === type);

const C = { id: "slack:T1/C2/1700000000.000100", label: "Slack · #runbooks" };

describe("conversations", () => {
  it.live("are owned by the thread a host first sends one to, which alone replies there", () =>
    Effect.gen(function* () {
      const sink = yield* receiver;
      yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        yield* store.updateSettings(
          (settings) => applySettingsPatch(settings, { experimental: { embedding: true } }),
          [["experimental", "embedding"]],
        );
        const runtimes = yield* ThreadRuntimes;
        const conversations = yield* Conversations;
        const fake = yield* FakeAgentControl;
        const make = (spawnedBy?: ThreadId) =>
          runtimes.create({
            projectRoot: "/work/home",
            checkout: { kind: "main", path: "/work/home" },
            ...(spawnedBy === undefined
              ? {}
              : { spawnedBy: { threadId: spawnedBy, feature: "rota" } }),
          });
        const desk = yield* make();
        const other = yield* make();

        // The first thread a message from it is sent to owns it, and the agent is told so.
        expect(yield* conversations.arrive(desk.id, C)).toBe(desk.id);
        yield* runtimes.send(desk.id, { text: "Who is on call?", conversation: C });
        const session = yield* fake.latest(desk.id);
        yield* eventually(
          "the message",
          Effect.sync(() => session.sent.length === 1),
        );
        expect(session.sent[0]!.text).toBe(
          `[From Slack · #runbooks (conversation ${C.id}). Answer there with the \`reply\` tool, naming this conversation; what you write in this chat isn't posted there.]\nWho is on call?`,
        );
        const [stored] = yield* store.listMessages(desk.id);
        expect(stored!.parts).toContainEqual(
          expect.objectContaining({ type: "data-conversation", data: C }),
        );

        // Another thread a message from it reaches doesn't take it, and is told not to answer.
        expect(yield* conversations.arrive(other.id, C)).toBe(desk.id);
        yield* runtimes.send(other.id, { text: "Me too", conversation: C });
        const otherSession = yield* fake.latest(other.id);
        yield* eventually(
          "the second",
          Effect.sync(() => otherSession.sent.length === 1),
        );
        expect(otherSession.sent[0]!.text).toContain("which another thread answers");

        // Only its owner's reply goes out, once per key.
        const reply = { conversation: C.id, text: "Ana is, until 18:00.", key: "k1" };
        const sent = (yield* session.callTool("reply", reply)) as { sent: boolean; id: string };
        expect(sent.sent).toBe(true);
        expect(String(yield* otherSession.callTool("reply", reply).pipe(Effect.flip))).toContain(
          "doesn't own the conversation",
        );
        const replies = yield* eventually(
          "the reply at the host",
          Effect.sync(() => {
            const found = ofType(sink.held, "conversation.reply");
            return found.length === 1 && found;
          }),
        );
        expect(replies[0]).toMatchObject({
          threadId: desk.id,
          data: { id: sent.id, conversation: C.id, text: "Ana is, until 18:00." },
        });

        // Handed to a worker, it is the worker's; closed, it comes back.
        const worker = yield* make(desk.id);
        yield* conversations.hand(desk.id, worker.id, [C.id]);
        expect((yield* store.getThread(worker.id)).conversations).toEqual([C]);
        expect((yield* store.getThread(desk.id)).conversations).toBeUndefined();
        expect(String(yield* session.callTool("reply", reply).pipe(Effect.flip))).toContain(
          "doesn't own",
        );
        expect(
          yield* conversations.hand(desk.id, worker.id, [C.id]).pipe(Effect.flip),
        ).toMatchObject({ message: expect.stringContaining("don't own") });
        yield* runtimes.close(worker.id);
        yield* eventually(
          "the return",
          store.getThread(desk.id).pipe(Effect.map((t) => t.conversations?.length === 1)),
        );
        const owners = yield* eventually(
          "the owners at the host",
          Effect.sync(() => {
            const found = ofType(sink.held, "conversation.owner");
            return found.length === 3 && found;
          }),
        );
        expect(owners.map((event) => event.data["owner"])).toEqual([desk.id, worker.id, desk.id]);
      }).pipe(Effect.provide(serverLayer(sink.url)));
    }),
  );
});
