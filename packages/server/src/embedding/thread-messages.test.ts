// Whom the platform's message into a thread is sent for: a fake inbound, store and runtimes, and
// one machine started for a run that no person signs in as.

import { describe, expect, it } from "@effect/vitest";
import { type HostId, type Thread, ThreadId, ThreadNotFound } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { currentCaller, NOT_YOUR_MACHINE } from "../host/ownership.ts";
import { RemoteHosts } from "../host/remote-hosts.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { ActingPerson } from "./person.ts";
import { EmbedInbound, type EmbedHandler } from "./inbound.ts";
import { ThreadMessagesInboundLive } from "./thread-messages.ts";

const RUN = "run/0123456789abcdef";
const HOST = "m-run" as HostId;
const threadId = ThreadId.make("home-orchestrator");
const thread = {
  id: threadId,
  checkout: { kind: "main", path: "/work/home", hostId: HOST },
} as unknown as Thread;

/** Each call that reached the runtimes, with whom it was routed for and who wrote it. */
const reached: Array<{ call: string; routedFor: string | undefined; acting: string | undefined }> =
  [];
const recorded: Array<unknown> = [];
const routes = new Map<string, EmbedHandler>();

const seen = (call: string) =>
  Effect.gen(function* () {
    const caller = yield* currentCaller;
    reached.push({ call, routedFor: caller?.person, acting: yield* ActingPerson });
  });

const TestLayer = ThreadMessagesInboundLive.pipe(
  Layer.provide(
    Layer.succeed(EmbedInbound, {
      route: (method, name, handler) =>
        Effect.sync(() => void routes.set(`${method} ${name}`, handler)),
      respond: () => Effect.succeed(undefined),
    }),
  ),
  Layer.provide(
    Layer.succeed(ThreadRuntimes, {
      send: () => seen("send").pipe(Effect.as({ queued: false })),
      interrupt: () => seen("interrupt"),
    } as unknown as (typeof ThreadRuntimes)["Service"]),
  ),
  Layer.provide(
    Layer.succeed(ThreadStore, {
      getThread: (id: ThreadId) =>
        id === threadId
          ? Effect.succeed(thread)
          : Effect.fail(new ThreadNotFound({ threadId: id })),
      messageReceipt: (..._: ReadonlyArray<unknown>) => _[5],
      appendActorEvents: (events: ReadonlyArray<unknown>) =>
        Effect.sync(() => void recorded.push(...events)),
    } as unknown as (typeof ThreadStore)["Service"]),
  ),
  Layer.provide(
    Layer.succeed(RemoteHosts, {
      machines: { list: () => [{ id: HOST, owner: RUN }] },
    } as unknown as (typeof RemoteHosts)["Service"]),
  ),
);

const post = (name: string, body: Record<string, unknown>) =>
  Effect.suspend(() => routes.get(`POST ${name}`)!(body));

describe("a message the platform sends into a thread on a machine started for a run", () => {
  it.effect("is refused for a person, and taken for the thread, as the person's", () =>
    Effect.gen(function* () {
      const person = { id: "user-7", name: "Ada" };
      const message = { threadId, person, key: "m-1", text: "Are you there?" };

      // For the person, as before: the machine is the run's, not theirs.
      const refused = yield* post("thread-messages", message);
      expect(refused.status).toBe(409);
      expect(refused.body).toEqual({ error: NOT_YOUR_MACHINE });
      const stopRefused = yield* post("thread-interrupt", { threadId, person });
      expect(stopRefused.status).toBe(409);
      expect(reached).toEqual([]);

      // Only `person` or `thread`.
      expect((yield* post("thread-messages", { ...message, for: "anyone" })).status).toBe(400);

      // For the thread: reached as its machine's owner, written and recorded as the person's.
      const taken = yield* post("thread-messages", { ...message, for: "thread" });
      expect(taken.status).toBe(200);
      const stopped = yield* post("thread-interrupt", { threadId, person, for: "thread" });
      expect(stopped.status).toBe(200);
      expect(reached).toEqual([
        { call: "send", routedFor: RUN, acting: "user-7" },
        { call: "interrupt", routedFor: RUN, acting: "user-7" },
      ]);
      expect(recorded).toEqual([
        expect.objectContaining({ action: "thread.send", actor: expect.objectContaining(person) }),
        expect.objectContaining({
          action: "thread.interrupt",
          actor: expect.objectContaining(person),
        }),
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );
});
