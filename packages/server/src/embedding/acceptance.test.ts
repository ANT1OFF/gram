// The acceptance of the decision hook and the event sink, against real HTTP endpoints on loopback:
// a refusal stops the action and says why, and the sink picks up after a restart with no gap.

import { describe, expect, it } from "@effect/vitest";
import {
  applySettingsPatch,
  type DecisionRequest,
  type DecisionResponse,
  type ServerEvent,
  type SinkBatch,
  type SinkEvent,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { EventHub, type OwnEvent } from "../events/event-hub.ts";
import { type StoredMessage, ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl, makeFakeAgentAdapter } from "../runtime/fake-agent.ts";
import { CheckoutService, TurnHooks } from "../runtime/hooks.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { UsageLimitReadings } from "../usage/limit-readings.ts";
import { DecisionHook } from "./decision-hook.ts";
import { EventSink, makeEventSink, type EventSinkShape } from "./event-sink.ts";
import { ActingPerson } from "./person.ts";
import { makeActionGuard } from "./guard.ts";
import { openOutbox } from "./outbox.ts";

/** A JSON endpoint on loopback that answers each POST with what `answer` makes of its body. */
const endpoint = <Body>(answer: (body: Body) => { status?: number; json: unknown }) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ server: Server; url: string; tokens: Array<string | undefined> }>(
          (resolve) => {
            const tokens: Array<string | undefined> = [];
            const server = createServer((request, response) => {
              const chunks: Array<Buffer> = [];
              request.on("data", (chunk: Buffer) => chunks.push(chunk));
              request.on("end", () => {
                tokens.push(request.headers.authorization);
                const { status = 200, json } = answer(
                  JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body,
                );
                response.writeHead(status, { "content-type": "application/json" });
                response.end(JSON.stringify(json));
              });
            });
            server.listen(0, "127.0.0.1", () =>
              resolve({
                server,
                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
                tokens,
              }),
            );
          },
        ),
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

/** Polls in real time: the endpoints answer over real sockets. */
const eventually = <A, E, R>(label: string, check: Effect.Effect<A | undefined | false, E, R>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 1000; i++) {
      const value = yield* check;
      if (value !== undefined && value !== false) return value;
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

const serverLayer = (
  decisionUrl: string | undefined,
  sinkUrl?: string,
  sinkMessages = false,
  /** A data folder for a server that is started again; absent, nothing outlives the layer. */
  dir?: string,
) =>
  AppToolRegistry.layer.pipe(
    Layer.provideMerge(ThreadRuntimes.layerOnLocalHost),
    Layer.provideMerge(UsageLimitReadings.layer),
    Layer.provideMerge(DecisionHook.layer.pipe(Layer.provideMerge(EventSink.layer))),
    Layer.provideMerge(EventHub.layer),
    Layer.provideMerge(
      ThreadStore.layerSqlite(dir === undefined ? ":memory:" : join(dir, "gram.db")),
    ),
    Layer.provideMerge(makeFakeAgentAdapter({ reply: "echo", toolStepDelay: "20 millis" })),
    Layer.provideMerge(TurnHooks.layerNoop),
    Layer.provideMerge(CheckoutService.layerNoGit),
    Layer.provideMerge(
      ServerConfig.layer({
        ...TEST_CONFIG,
        ...(dir === undefined ? {} : { dataDir: dir, databaseFile: join(dir, "gram.db") }),
        ...(decisionUrl === undefined
          ? {}
          : {
              decisionHook:
                decisionUrl === "unusable"
                  ? ("unusable" as const)
                  : { url: decisionUrl, token: "hook-token" },
            }),
        ...(sinkUrl === undefined ? {} : { eventSink: { url: sinkUrl, token: "sink-token" } }),
        ...(sinkMessages ? { eventSinkMessages: true } : {}),
      }),
    ),
    Layer.orDie,
  );

const setHosted = (on: boolean) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    yield* store.updateSettings(
      (settings) => applySettingsPatch(settings, { experimental: { embedding: on } }),
      [["experimental", "embedding"]],
    );
  });

const collectEvents = Effect.gen(function* () {
  const hub = yield* EventHub;
  const events: Array<ServerEvent> = [];
  yield* Effect.forkScoped(
    Stream.runForEach(
      hub.internalEvents(() => true),
      (event) => Effect.sync(() => void events.push(event)),
    ),
  );
  return events;
});

const startThread = (text: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    return yield* runtimes.create({
      projectRoot: "/work/repo",
      checkout: { kind: "main", path: "/work/repo" },
      input: { text },
    });
  });

const sessionOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const control = yield* FakeAgentControl;
    return yield* control.latest(threadId);
  });

/** What the receiver holds once the sink has nothing more to send it. */
const settledAt = (to: { readonly held: ReadonlyArray<SinkEvent> }) =>
  Effect.gen(function* () {
    let before = -1;
    yield* eventually(
      "the sink to go quiet",
      Effect.sleep("150 millis").pipe(
        Effect.map(() => {
          const quiet = to.held.length === before;
          before = to.held.length;
          return quiet;
        }),
      ),
    );
    return [...to.held];
  });

/** One person's thread whose reply streams in many deltas, run to its end. */
const streamedTurn = (text = "say a lot /stream{400}") =>
  Effect.gen(function* () {
    yield* setHosted(true);
    const runtimes = yield* ThreadRuntimes;
    const thread = yield* startThread(text).pipe(Effect.provideService(ActingPerson, "person-1"));
    yield* eventually(
      "the turn to end",
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const messages = yield* store.listMessages(thread.id);
        const status = yield* runtimes.status(thread.id);
        return status === "idle" && messages.at(-1)?.metadata?.turnEnd !== undefined && messages;
      }),
    );
    return thread;
  });

describe("decision hook: an agent's outward command", () => {
  it.live("a refusal stops the push, with no card, and says why to the agent and the user", () =>
    Effect.gen(function* () {
      const asked: Array<DecisionRequest> = [];
      const hook = yield* endpoint<DecisionRequest>((body) => {
        asked.push(body);
        return {
          json: {
            decision: "refuse",
            reason: "Pushes to main are closed this week.",
          } satisfies DecisionResponse,
        };
      });
      yield* Effect.gen(function* () {
        yield* setHosted(true);
        const store = yield* ThreadStore;
        const events = yield* collectEvents;
        const thread = yield* startThread("ship it /approve{git push origin main}");
        const session = yield* sessionOf(thread.id);

        yield* eventually(
          "the agent's answer",
          Effect.sync(() => session.responses.length === 1),
        );
        expect(session.responses[0]!.answer).toEqual({
          kind: "approval",
          decision: "deny",
          scope: "once",
          message: "Refused by policy (push): Pushes to main are closed this week.",
        });
        // The command never ran: the fake's turn reports the denial.
        const runtimes = yield* ThreadRuntimes;
        yield* eventually(
          "the turn to end",
          runtimes.status(thread.id).pipe(Effect.map((status) => status === "idle")),
        );
        expect(yield* store.listRequests(thread.id)).toEqual([]);
        expect(events.some((event) => event.type === "thread.request")).toBe(false);
        expect(events).toContainEqual({
          type: "notify",
          kind: "info",
          title: "Refused by policy (push): Pushes to main are closed this week.",
          threadId: thread.id,
        });
        // The session opened under the hook's gates, and the hook was asked once, as specified.
        expect(session.options).toMatchObject({ outwardGate: "all", gateConnectors: true });
        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatchObject({
          v: 1,
          action: "push",
          initiator: "agent",
          actor: { kind: "thread", id: thread.id },
          thread: { id: thread.id, role: "plain" },
          detail: { command: "git push origin main" },
        });
        expect(hook.tokens).toEqual(["Bearer hook-token"]);
      }).pipe(Effect.provide(serverLayer(hook.url)));
    }),
  );

  it.live("an allowed push is answered for the agent with no card", () =>
    Effect.gen(function* () {
      const hook = yield* endpoint<DecisionRequest>(() => ({ json: { decision: "allow" } }));
      yield* Effect.gen(function* () {
        yield* setHosted(true);
        const events = yield* collectEvents;
        const thread = yield* startThread("ship it /approve{git push origin feat}");
        const session = yield* sessionOf(thread.id);
        yield* eventually(
          "the agent's answer",
          Effect.sync(() => session.responses.length === 1),
        );
        expect(session.responses[0]!.answer).toEqual({
          kind: "approval",
          decision: "allow",
          scope: "once",
        });
        expect(events.some((event) => event.type === "thread.request")).toBe(false);
      }).pipe(Effect.provide(serverLayer(hook.url)));
    }),
  );

  it.live("an endpoint that is down refuses", () =>
    Effect.gen(function* () {
      const hook = yield* endpoint<DecisionRequest>(() => ({ status: 503, json: {} }));
      yield* Effect.gen(function* () {
        yield* setHosted(true);
        const thread = yield* startThread("ship it /approve{gh pr merge 12 --squash}");
        const session = yield* sessionOf(thread.id);
        yield* eventually(
          "the agent's answer",
          Effect.sync(() => session.responses.length === 1),
        );
        expect(session.responses[0]!.answer).toMatchObject({
          decision: "deny",
          message:
            "Refused by policy (pr.merge): The decision endpoint could not be asked, so this was refused.",
        });
      }).pipe(Effect.provide(serverLayer(hook.url)));
    }),
  );

  it.live("an endpoint that was configured and can't be used refuses, not allows", () =>
    Effect.gen(function* () {
      yield* setHosted(true);
      const thread = yield* startThread("ship it /approve{git push origin feat}");
      const session = yield* sessionOf(thread.id);
      yield* eventually(
        "the agent's answer",
        Effect.sync(() => session.responses.length === 1),
      );
      expect(session.responses[0]!.answer).toMatchObject({
        decision: "deny",
        message:
          "Refused by policy (push): The decision endpoint could not be asked, so this was refused.",
      });
    }).pipe(Effect.provide(serverLayer("unusable"))),
  );

  it.live("ask raises the card, and its approval is put to the hook again before it runs", () =>
    Effect.gen(function* () {
      const asked: Array<DecisionRequest> = [];
      let second: DecisionResponse = { decision: "allow" };
      const hook = yield* endpoint<DecisionRequest>((body) => {
        asked.push(body);
        return {
          json:
            body.approval === undefined
              ? ({ decision: "ask", reason: "A maintainer signs off merges." } as const)
              : second,
        };
      });
      const run = (expected: "allow" | "deny") =>
        Effect.gen(function* () {
          asked.length = 0;
          yield* setHosted(true);
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const thread = yield* startThread("ship it /approve{gh pr merge 12}");
          const session = yield* sessionOf(thread.id);
          const card = yield* eventually(
            "the card",
            store.listRequests(thread.id).pipe(Effect.map((requests) => requests[0])),
          );
          expect(card).toMatchObject({
            kind: "approval",
            input: { command: "gh pr merge 12" },
            decisionReason: "A maintainer signs off merges.",
          });
          expect(session.responses).toEqual([]);
          yield* runtimes
            .respond(thread.id, card.id, { kind: "approval", decision: "allow", scope: "once" })
            .pipe(Effect.provideService(ActingPerson, "person-7"));
          expect(session.responses.map((response) => response.answer.kind)).toEqual(["approval"]);
          expect(session.responses[0]!.answer).toMatchObject({ decision: expected });
          expect(asked).toHaveLength(2);
          expect(asked[1]).toMatchObject({
            action: "pr.merge",
            actor: { kind: "thread", id: thread.id },
            approval: { decisionId: asked[0]!.id, askId: card.id, answeredBy: "person-7" },
          });
        }).pipe(Effect.provide(serverLayer(hook.url)));
      yield* run("allow");
      second = { decision: "refuse", reason: "You can't approve your own merge." };
      yield* run("deny");
    }),
  );

  it.live("with hosted features off, nothing is asked and the card is the one it always was", () =>
    Effect.gen(function* () {
      const asked: Array<DecisionRequest> = [];
      const hook = yield* endpoint<DecisionRequest>((body) => {
        asked.push(body);
        return { json: { decision: "refuse" } };
      });
      yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        const thread = yield* startThread("ship it /approve{git push origin main}");
        const session = yield* sessionOf(thread.id);
        const card = yield* eventually(
          "the card",
          store.listRequests(thread.id).pipe(Effect.map((requests) => requests[0])),
        );
        expect(card).toMatchObject({
          kind: "approval",
          input: { command: "git push origin main" },
        });
        expect(session.options).not.toHaveProperty("gateConnectors");
        expect(session.options).not.toHaveProperty("outwardGate");
        expect(asked).toEqual([]);
      }).pipe(Effect.provide(serverLayer(hook.url)));
    }),
  );
});

describe("decision hook: an action the server takes", () => {
  const thread = { id: "thread-1" as ThreadId } as Thread;
  const question = {
    action: "pr.merge" as const,
    initiator: "person" as const,
    detail: { repo: "acme/app", number: 12 },
  };
  const card = Effect.succeed({
    toolName: "pr.merge",
    displayName: "Merge",
    description: "Merge",
    input: {},
  });

  it.live("a refusal fails the action with the reason; off, it is let through unasked", () =>
    Effect.gen(function* () {
      let calls = 0;
      const hook = yield* endpoint<DecisionRequest>(() => {
        calls++;
        return { json: { decision: "refuse", reason: "Merges are frozen." } };
      });
      const layer = DecisionHook.layer.pipe(
        Layer.provideMerge(ThreadStore.layerSqlite(":memory:")),
        Layer.provideMerge(ServerConfig.layer({ ...TEST_CONFIG, decisionHook: { url: hook.url } })),
        Layer.orDie,
      );
      yield* Effect.gen(function* () {
        const guard = makeActionGuard({
          hook: yield* DecisionHook,
          store: { getThread: () => Effect.succeed(thread) },
          runtimes: { requestApproval: () => Effect.die("no card is raised") },
        });
        yield* guard(thread.id, question, card);
        expect(calls).toBe(0);
        yield* setHosted(true);
        const refused = yield* Effect.flip(guard(thread.id, question, card));
        expect(refused.message).toBe("Refused by policy (pr.merge): Merges are frozen.");
        expect(calls).toBe(1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.live("ask waits for a person, then asks again; a rejection stops it there", () =>
    Effect.gen(function* () {
      const asked: Array<DecisionRequest> = [];
      const hook = yield* endpoint<DecisionRequest>((body) => {
        asked.push(body);
        return { json: { decision: body.approval === undefined ? "ask" : "allow" } };
      });
      const layer = DecisionHook.layer.pipe(
        Layer.provideMerge(ThreadStore.layerSqlite(":memory:")),
        Layer.provideMerge(ServerConfig.layer({ ...TEST_CONFIG, decisionHook: { url: hook.url } })),
        Layer.orDie,
      );
      yield* Effect.gen(function* () {
        yield* setHosted(true);
        const answers: Array<"allow" | "deny"> = ["allow", "deny"];
        const guard = makeActionGuard({
          hook: yield* DecisionHook,
          store: { getThread: () => Effect.succeed(thread) },
          runtimes: {
            requestApproval: () =>
              Effect.succeed({
                kind: "approval" as const,
                decision: answers.shift()!,
                scope: "once" as const,
                answeredBy: "person-2",
                resolution: {
                  threadId: thread.id,
                  requestId: "card-1" as never,
                  origin: "user" as const,
                  reason: "approved",
                  resolvedAt: 0,
                },
              }),
          },
        });
        // The person who pressed the button is the actor; the one who approved the card is named
        // on the second call.
        yield* guard(thread.id, question, card).pipe(
          Effect.provideService(ActingPerson, "person-1"),
        );
        expect(asked.map((request) => request.actor)).toEqual([
          { kind: "person", id: "person-1" },
          { kind: "person", id: "person-1" },
        ]);
        expect(asked.map((request) => request.approval)).toEqual([
          undefined,
          { decisionId: asked[0]!.id, askId: "card-1", answeredBy: "person-2" },
        ]);
        const refused = yield* Effect.flip(guard(thread.id, question, card));
        expect(refused.message).toBe("Not approved (pr.merge).");
        expect(asked).toHaveLength(3);
      }).pipe(Effect.provide(layer));
    }),
  );
});

const sinkAt = (file: string, url: string, on: Effect.Effect<boolean> = Effect.succeed(true)) =>
  makeEventSink({
    endpoint: { url, token: "sink-token" },
    file,
    on,
    threads: Effect.succeed([]),
    batchSize: 3,
    retryBase: Duration.millis(5),
    retryMax: Duration.millis(20),
    recheck: Duration.millis(5),
  });

const recordStatuses = (sink: EventSinkShape, from: number, to: number) =>
  Effect.forEach(
    Array.from({ length: to - from + 1 }, (_, i) => from + i),
    (n) =>
      sink.record({
        type: "thread.status",
        threadId: "thread-1",
        data: { id: "thread-1", status: "running", idle: false, n },
      }),
    { discard: true },
  );

/** A thread as far as the sink reads one. */
const sinkThread = (id: string, createdAt: number) =>
  ({ id, title: id, model: { agent: "claude", model: "m" }, createdAt }) as unknown as Thread;

/** Threads with stored messages, for a sink made by hand: `rows` is what its store holds. */
const storedThreads = () => {
  const rows = new Map<string, Array<StoredMessage>>();
  const put = (threadId: string, seq: number, text = `${threadId} ${seq}`) => {
    const id = `${threadId}-m${seq}`;
    const row: StoredMessage = {
      seq,
      rev: 1,
      role: "assistant",
      message: { id, role: "assistant", parts: [{ type: "text", text }] } as never,
    };
    const held = (rows.get(threadId) ?? []).filter((one) => one.seq !== seq);
    rows.set(
      threadId,
      [...held, row].toSorted((a, b) => a.seq - b.seq),
    );
    return id;
  };
  const read: NonNullable<Parameters<typeof makeEventSink>[0]["messages"]> = (threadId, select) =>
    Effect.sync(() =>
      "messageId" in select
        ? (rows.get(threadId) ?? []).filter((row) => row.message.id === select.messageId)
        : (rows.get(threadId) ?? [])
            .filter((row) => row.seq > select.afterSeq)
            .slice(0, select.limit),
    );
  return { rows, put, thread: sinkThread, read };
};

/** The ids of the messages among `events`, in order. */
const messageIds = (events: ReadonlyArray<SinkEvent>) =>
  events.filter((event) => event.type === "message").map((event) => event.data["id"]);

describe("event sink", () => {
  /** A receiver that keeps what it is sent in order, and can be told to stop taking it. */
  const receiver = Effect.gen(function* () {
    const held: Array<SinkEvent> = [];
    const sources = new Set<string>();
    const state = { down: false, posts: 0 };
    const server = yield* endpoint<SinkBatch>((batch) => {
      state.posts++;
      if (state.down) return { status: 503, json: {} };
      sources.add(batch.source);
      for (const event of batch.events) {
        // At least once: what it holds already is ignored, and a gap is not taken.
        if (event.seq === held.length + 1) held.push(event);
      }
      return { json: { ack: held.length } };
    });
    return { held, sources, state, url: server.url, tokens: server.tokens };
  });

  it.live("replays from where the receiver left off after a restart, with no gap", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-sink-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      const file = join(dir, "event-sink.db");
      const to = yield* receiver;

      // First run: seven events reach the receiver, then it goes down and five more are recorded.
      const first = yield* Scope.make();
      const sink = yield* sinkAt(file, to.url).pipe(Scope.provide(first));
      yield* recordStatuses(sink, 1, 6);
      yield* eventually(
        "the first seven",
        Effect.sync(() => to.held.length === 7),
      );
      to.state.down = true;
      yield* recordStatuses(sink, 7, 11);
      const postsWhileDown = to.state.posts;
      yield* eventually(
        "a refused send",
        Effect.sync(() => to.state.posts > postsWhileDown),
      );
      // The server stops with five events unsent.
      yield* Scope.close(first, { _tag: "Success", value: undefined } as never);
      expect(to.held).toHaveLength(7);

      // Second run on the same file: the receiver is back, and more happens.
      to.state.down = false;
      const again = yield* sinkAt(file, to.url);
      yield* recordStatuses(again, 12, 13);
      yield* eventually(
        "everything",
        Effect.sync(() => to.held.length === 15),
      );

      // One source, every number once, in order: 1 `sink.started`, 6 statuses, 5 from before the
      // restart, the second run's `sink.started`, then its 2.
      expect(to.sources.size).toBe(1);
      expect(to.held.map((event) => event.seq)).toEqual(
        Array.from({ length: 15 }, (_, i) => i + 1),
      );
      expect(
        to.held.map((event) => (event.type === "sink.started" ? "start" : event.data["n"])),
      ).toEqual(["start", 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, "start", 12, 13]);
      expect(new Set(to.tokens)).toEqual(new Set(["Bearer sink-token"]));
    }),
  );

  it.live("does not believe an ack past what it sent, and keeps sending the same events", () =>
    Effect.gen(function* () {
      const held: Array<SinkEvent> = [];
      const sources = new Set<string>();
      const state = { lying: true };
      const server = yield* endpoint<SinkBatch>((batch) => {
        sources.add(batch.source);
        if (state.lying) return { json: { ack: batch.events.at(-1)!.seq + 5 } };
        for (const event of batch.events) if (event.seq === held.length + 1) held.push(event);
        return { json: { ack: held.length } };
      });
      const sink = yield* sinkAt(":memory:", server.url);
      yield* recordStatuses(sink, 1, 3);
      yield* eventually(
        "two sends",
        Effect.sync(() => server.tokens.length >= 2),
      );
      state.lying = false;
      yield* eventually(
        "all four",
        Effect.sync(() => held.length === 4),
      );
      expect(sources.size).toBe(1);
      expect(held.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    }),
  );

  it.live(
    "keeps who started a thread across a restart, and lists the cards open at a turn-on",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "gram-sink-"));
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
        const file = join(dir, "event-sink.db");
        const to = yield* receiver;
        const thread = {
          id: "thread-9",
          title: "T",
          model: { agent: "claude", model: "m" },
        } as unknown as Thread;
        const first = yield* Scope.make();
        const sink = yield* sinkAt(file, to.url).pipe(Scope.provide(first));
        // On when it was made: that first snapshot is the server's own start.
        yield* eventually(
          "the start's snapshot",
          Effect.sync(() => to.held.find((event) => event.type === "sink.started")),
        );
        expect(to.held[0]!.data).toMatchObject({ restarted: true, openAsks: [] });
        yield* sink.noteCreator(thread.id, "person-3");
        yield* Scope.close(first, { _tag: "Success", value: undefined } as never);

        // Off at start, so the first `sink.started` is a turn-on: it lists what is open then.
        let on = false;
        yield* makeEventSink({
          endpoint: { url: to.url, token: "sink-token" },
          file,
          on: Effect.sync(() => on),
          threads: Effect.succeed([thread]),
          openAsks: Effect.succeed(["card-4"]),
          retryBase: Duration.millis(5),
          recheck: Duration.millis(5),
        });
        on = true;
        const turnedOn = yield* eventually(
          "the turn-on's snapshot",
          Effect.sync(() => to.held.findLast((event) => event.type === "sink.started")),
        );
        yield* eventually(
          "two snapshots",
          Effect.sync(() => to.held.filter((event) => event.type === "sink.started").length === 2),
        );
        const latest = to.held.findLast((event) => event.type === "sink.started")!;
        expect(turnedOn.type).toBe("sink.started");
        expect(latest.data).toMatchObject({
          openAsks: ["card-4"],
          threads: [{ id: "thread-9", createdBy: "person-3" }],
        });
        expect(latest.data["restarted"]).toBeUndefined();
      }),
  );

  it.live("goes back to what the receiver says it holds", () =>
    Effect.gen(function* () {
      const to = yield* receiver;
      const sink = yield* sinkAt(":memory:", to.url);
      yield* recordStatuses(sink, 1, 4);
      yield* eventually(
        "five",
        Effect.sync(() => to.held.length === 5),
      );
      // The receiver loses its newest two; its next ack says so, and they are sent again.
      to.held.length = 3;
      yield* recordStatuses(sink, 5, 5);
      yield* eventually(
        "six",
        Effect.sync(() => to.held.length === 6),
      );
      expect(to.held.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(to.held.map((event) => event.data["n"] ?? "start")).toEqual(["start", 1, 2, 3, 4, 5]);
    }),
  );

  it.live("records nothing while hosted features are off, and opens with a snapshot when on", () =>
    Effect.gen(function* () {
      const to = yield* receiver;
      let on = false;
      const sink = yield* sinkAt(
        ":memory:",
        to.url,
        Effect.sync(() => on),
      );
      yield* recordStatuses(sink, 1, 3);
      yield* Effect.sleep("30 millis");
      expect(to.state.posts).toBe(0);
      on = true;
      yield* Effect.sleep("10 millis");
      yield* recordStatuses(sink, 4, 4);
      yield* eventually(
        "two",
        Effect.sync(() => to.held.length === 2),
      );
      expect(to.held.map((event) => event.data["n"] ?? event.type)).toEqual(["sink.started", 4]);
    }),
  );

  it.live("the server's own events reach the sink: threads, asks and decisions", () =>
    Effect.gen(function* () {
      const to = yield* receiver;
      const hook = yield* endpoint<DecisionRequest>(() => ({
        json: { decision: "ask", title: "Sign off the release" },
      }));
      yield* Effect.gen(function* () {
        yield* setHosted(true);
        const store = yield* ThreadStore;
        const thread = yield* startThread("ship it /approve{gh release create v1}").pipe(
          Effect.provideService(ActingPerson, "person-1"),
        );
        const card = yield* eventually(
          "the card",
          store.listRequests(thread.id).pipe(Effect.map((requests) => requests[0])),
        );
        const opened = yield* eventually(
          "ask.opened at the receiver",
          Effect.sync(() => to.held.find((event) => event.type === "ask.opened")),
        );
        const decision = to.held.find((event) => event.type === "decision")!;
        expect(decision).toMatchObject({
          threadId: thread.id,
          actor: { kind: "thread", id: thread.id },
          data: { action: "release", decision: "ask" },
        });
        expect(opened).toMatchObject({
          threadId: thread.id,
          data: {
            id: card.id,
            kind: "approval",
            title: "Sign off the release",
            decisionId: decision.data["id"],
          },
        });
        // A person's answer closes it as answered, with who and what they said.
        const runtimes = yield* ThreadRuntimes;
        yield* runtimes
          .respond(thread.id, card.id, { kind: "approval", decision: "allow", scope: "once" })
          .pipe(Effect.provideService(ActingPerson, "person-7"));
        const resolved = yield* eventually(
          "ask.resolved at the receiver",
          Effect.sync(() => to.held.find((event) => event.type === "ask.resolved")),
        );
        expect(resolved).toMatchObject({
          threadId: thread.id,
          actor: { kind: "person", id: "person-7" },
          data: { id: card.id, how: "answered", decision: "approve", answeredBy: "person-7" },
        });
        // Hosted features were turned on after the server started: nothing was open then.
        expect(to.held[0]).toMatchObject({ type: "sink.started", data: { openAsks: [] } });
        expect(to.held[0]!.data["restarted"]).toBeUndefined();
        // The thread says who started it, on every upsert.
        const upserts = to.held.filter((event) => event.type === "thread.upsert");
        expect(upserts.length).toBeGreaterThan(0);
        for (const upsert of upserts) expect(upsert.data["createdBy"]).toBe("person-1");
        expect(to.held.map((event) => event.seq)).toEqual(to.held.map((_, i) => i + 1));
      }).pipe(Effect.provide(serverLayer(hook.url, to.url)));
    }),
  );

  it.live("with messages asked for, each stored message is sent whole, never as it streams", () =>
    Effect.gen(function* () {
      const to = yield* receiver;
      yield* Effect.gen(function* () {
        // A turn of several steps: thinking, tool calls, then the reply, each saved as it ends.
        const thread = yield* streamedTurn("look around /tool");
        const store = yield* ThreadStore;
        const stored = yield* store.storedMessages(thread.id, { afterSeq: 0, limit: 100 });
        expect(stored.map((one) => one.role)).toEqual(["user", "assistant", "assistant"]);
        const held = yield* settledAt(to);
        const sent = held.filter((event) => event.type === "message");
        // The thread is known before its first message.
        expect(held.findIndex((event) => event.type === "thread.upsert")).toBeLessThan(
          held.findIndex((event) => event.type === "message"),
        );
        for (const event of sent) expect(event.threadId).toBe(thread.id);

        // The person's message: once, as stored, from the person who sent it.
        const user = stored[0]!;
        const users = sent.filter((event) => event.data["id"] === user.message.id);
        expect(users).toHaveLength(1);
        expect(users[0]!.actor).toEqual({ kind: "person", id: "person-1" });
        expect(users[0]!.data).toEqual({
          id: user.message.id,
          rev: user.rev,
          role: "user",
          turnId: user.turnId,
          at: user.message.metadata!.createdAt,
          seq: 1,
          message: JSON.parse(JSON.stringify(user.message)),
          truncated: false,
        });
        expect(user.message.metadata?.sentBy).toBe("person-1");

        // The replies were stored many times as they streamed, a step at a time. Each is sent
        // when it has finished, whole, and the last once more when the turn's end is stamped on
        // it: never a part of one.
        const tools = stored.flatMap((one) =>
          one.message.parts.filter((part) => part.type.startsWith("tool-")),
        );
        expect(tools.length).toBeGreaterThan(1);
        expect(stored.at(-1)!.rev - user.rev).toBeGreaterThan(sent.length + 2);
        for (const reply of stored.slice(1)) {
          const replies = sent.filter((event) => event.data["id"] === reply.message.id);
          expect(replies.length).toBeGreaterThanOrEqual(1);
          expect(replies.length).toBeLessThanOrEqual(2);
          const { turnEnd: _, usage: __, ...finished } = reply.message.metadata!;
          for (const event of replies) {
            expect(event.actor).toBeUndefined();
            expect(event.data).toMatchObject({
              role: "assistant",
              turnId: reply.turnId,
              seq: reply.seq,
            });
            const message = event.data["message"] as typeof reply.message;
            expect(message.parts).toEqual(JSON.parse(JSON.stringify(reply.message.parts)));
            expect(message.metadata).toMatchObject(JSON.parse(JSON.stringify(finished)));
          }
          // The last one sent is the message as it is stored now. A save that changed nothing
          // (the turn's end stores every open message again) took a revision and sent nothing.
          expect(replies.at(-1)!.data).toMatchObject({
            message: JSON.parse(JSON.stringify(reply.message)),
            truncated: false,
          });
          expect(replies.at(-1)!.data["rev"]).toBeLessThanOrEqual(reply.rev);
          const revs = replies.map((event) => event.data["rev"] as number);
          expect(revs).toEqual(revs.toSorted((a, b) => a - b));
        }
        expect(sent.length).toBeLessThanOrEqual(4);
        expect(held.map((event) => event.seq)).toEqual(held.map((_, i) => i + 1));
      }).pipe(Effect.provide(serverLayer(undefined, to.url, true)));
    }),
  );

  it.live("a fork's copied messages are sent under the fork, after its thread", () =>
    Effect.gen(function* () {
      const to = yield* receiver;
      yield* Effect.gen(function* () {
        const thread = yield* streamedTurn();
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;
        const last = (yield* store.listMessages(thread.id)).at(-1)!;
        const plan = yield* runtimes.forkTarget(thread.id, last.id);
        const fork = yield* runtimes.fork(plan, {
          checkout: { kind: "main", path: "/work/fork" },
        });
        const copies = yield* store.storedMessages(fork.id, { afterSeq: 0, limit: 100 });
        expect(copies).toHaveLength(2);
        const held = yield* eventually(
          "the fork's messages at the receiver",
          Effect.sync(() => {
            const sent = to.held.filter(
              (event) => event.type === "message" && event.threadId === fork.id,
            );
            return sent.length === 2 && sent;
          }),
        );
        expect(held.map((event) => event.data["id"])).toEqual(
          copies.map((copy) => copy.message.id),
        );
        expect(held.map((event) => event.data["seq"])).toEqual([1, 2]);
        const upsert = to.held.find(
          (event) => event.type === "thread.upsert" && event.threadId === fork.id,
        )!;
        expect(upsert.seq).toBeLessThan(held[0]!.seq);
      }).pipe(Effect.provide(serverLayer(undefined, to.url, true)));
    }),
  );

  it.live("a message is sent again only when it changed, and large ones a few to a batch", () =>
    Effect.gen(function* () {
      const to = yield* receiver;
      const batches: Array<number> = [];
      const counting = yield* endpoint<SinkBatch>((batch) => {
        batches.push(batch.events.filter((event) => event.type === "message").length);
        return { json: { ack: batch.events.at(-1)!.seq } };
      });
      const threadId = "thread-1" as ThreadId;
      const rows = new Map<string, StoredMessage>();
      const put = (id: string, rev: number, text: string) =>
        rows.set(id, {
          seq: Number(id.slice(1)),
          rev,
          role: "assistant",
          message: { id, role: "assistant", parts: [{ type: "text", text }] } as never,
        });
      const sinkOver = (url: string, events: Queue.Queue<OwnEvent>) =>
        makeEventSink({
          endpoint: { url, token: "sink-token" },
          file: ":memory:",
          on: Effect.succeed(true),
          threads: Effect.succeed([]),
          events: Stream.fromQueue(events),
          messages: (_, select) =>
            Effect.sync(() =>
              "messageId" in select
                ? [rows.get(select.messageId)].filter((row) => row !== undefined)
                : [...rows.values()]
                    .filter((row) => row.seq > select.afterSeq)
                    .slice(0, select.limit),
            ),
          batchBytes: 250_000,
          retryBase: Duration.millis(5),
          recheck: Duration.millis(5),
        });
      const events = yield* Queue.unbounded<OwnEvent>();
      yield* sinkOver(to.url, events);
      const settled = (messageId: string) =>
        Queue.offer(events, { type: "message.settled", threadId, messageId });
      const sent = () => to.held.filter((event) => event.type === "message");

      // The sink reads a message when it gets to its event, so each step waits for the last.
      put("m1", 1, "first");
      yield* settled("m1");
      yield* eventually(
        "the first message",
        Effect.sync(() => sent().length === 1),
      );
      // Stored again with nothing changed, then changed, then gone before the sink read it.
      put("m1", 2, "first");
      yield* settled("m1");
      put("m1", 3, "first, and more");
      yield* settled("m1");
      yield* eventually(
        "the changed message",
        Effect.sync(() => sent().length === 2),
      );
      rows.delete("m1");
      yield* settled("m1");
      put("m2", 4, "second");
      yield* settled("m2");
      yield* eventually(
        "three messages",
        Effect.sync(() => sent().length === 3),
      );
      expect(sent().map((event) => [event.data["id"], event.data["rev"]])).toEqual([
        ["m1", 1],
        ["m1", 3],
        ["m2", 4],
      ]);
      // A thread whose messages were all put there at once has each sent, changed or not.
      yield* Queue.offer(events, { type: "messages.replaced", threadId });
      yield* eventually(
        "the thread's messages again",
        Effect.sync(() => sent().length === 4),
      );
      expect(sent().at(-1)!.data).toMatchObject({ id: "m2", rev: 4 });

      // Five messages of 100 KB each go two to a request, not all in one.
      const large = yield* Queue.unbounded<OwnEvent>();
      rows.clear();
      for (let n = 1; n <= 5; n++) put(`m${n}`, n, "x".repeat(100_000));
      yield* sinkOver(counting.url, large);
      yield* Queue.offer(large, { type: "messages.replaced", threadId });
      yield* eventually(
        "every large message",
        Effect.sync(() => batches.reduce((sum, count) => sum + count, 0) === 5),
      );
      expect(Math.max(...batches)).toBeLessThanOrEqual(2);
    }),
  );

  it.live(
    "a server that starts sending messages sends the stored ones once, oldest thread first",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "gram-sink-"));
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
        const to = yield* receiver;
        const messages = () => to.held.filter((event) => event.type === "message");

        // Messages not asked for: two threads' turns are stored, and none of it is sent.
        const stored = yield* Effect.gen(function* () {
          const first = yield* streamedTurn("look around /tool");
          const second = yield* streamedTurn("say a little /stream{20}");
          const store = yield* ThreadStore;
          const all: Array<readonly [string, string, number]> = [];
          for (const thread of [first, second]) {
            for (const one of yield* store.storedMessages(thread.id, { afterSeq: 0, limit: 100 })) {
              all.push([thread.id, one.message.id, one.rev]);
            }
          }
          yield* settledAt(to);
          return all;
        }).pipe(Effect.provide(serverLayer(undefined, to.url, false, dir)));
        expect(stored.length).toBeGreaterThanOrEqual(5);
        expect(messages()).toEqual([]);
        const before = to.held.length;

        // The same data folder with messages asked for: every stored one, once, in order.
        yield* eventually(
          "every stored message",
          Effect.sync(() => messages().length >= stored.length),
        ).pipe(
          Effect.andThen(settledAt(to)),
          Effect.provide(serverLayer(undefined, to.url, true, dir)),
        );
        expect(
          messages().map((event) => [event.threadId, event.data["id"], event.data["rev"]]),
        ).toEqual(stored);
        // After the start that lists their threads.
        expect(to.held[before]).toMatchObject({ type: "sink.started", data: { restarted: true } });
        expect(to.held.findIndex((event) => event.type === "message")).toBeGreaterThan(before);

        // Started again: it was done for this receiver, and nothing is sent twice.
        yield* eventually(
          "the next start",
          Effect.sync(() => to.held.filter((event) => event.type === "sink.started").length === 3),
        ).pipe(
          Effect.andThen(Effect.sleep("700 millis")),
          Effect.andThen(settledAt(to)),
          Effect.provide(serverLayer(undefined, to.url, true, dir)),
        );
        expect(messages()).toHaveLength(stored.length);
        expect(to.sources.size).toBe(1);
      }),
  );

  /**
   * A receiver that keeps each source's events apart, lists every event it was posted (taken or
   * not), and takes no more once it holds `stopAt` messages.
   */
  const countingReceiver = Effect.gen(function* () {
    const bySource = new Map<string, Array<SinkEvent>>();
    const posted: Array<SinkEvent> = [];
    const state = { stopAt: Number.POSITIVE_INFINITY, down: false, refused: 0 };
    const held = () => [...bySource.values()].flat();
    const messages = () => held().filter((event) => event.type === "message");
    const server = yield* endpoint<SinkBatch>((batch) => {
      if (state.down || messages().length >= state.stopAt) {
        state.refused++;
        return { status: 503, json: {} };
      }
      posted.push(...batch.events);
      const mine = bySource.get(batch.source) ?? [];
      bySource.set(batch.source, mine);
      for (const event of batch.events) if (event.seq === mine.length + 1) mine.push(event);
      return { json: { ack: mine.length } };
    });
    return { bySource, posted, state, held, messages, url: server.url };
  });

  it.live(
    "stored messages are sent a page at a time, go on after a restart, and hold nothing up",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "gram-sink-"));
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
        const file = join(dir, "event-sink.db");
        const to = yield* countingReceiver;
        const { put, thread, read } = storedThreads();
        // Three threads of five messages, listed newest first.
        const threads = [thread("c", 300), thread("a", 100), thread("b", 200)];
        const expected: Array<string> = [];
        for (const id of ["a", "b", "c"]) for (let n = 1; n <= 5; n++) expected.push(put(id, n));
        const sinkOn = (events: Queue.Queue<OwnEvent>) =>
          makeEventSink({
            endpoint: { url: to.url, token: "sink-token" },
            file,
            on: Effect.succeed(true),
            threads: Effect.succeed(threads),
            events: Stream.fromQueue(events),
            messages: read,
            // Two of these messages to a page.
            batchBytes: 500,
            backfillPause: Duration.millis(30),
            retryBase: Duration.millis(5),
            retryMax: Duration.millis(20),
            recheck: Duration.millis(5),
          });

        // The receiver stops taking them after the first two pages.
        to.state.stopAt = 4;
        const first = yield* Scope.make();
        yield* sinkOn(yield* Queue.unbounded<OwnEvent>()).pipe(Scope.provide(first));
        yield* eventually(
          "a refused page",
          Effect.sync(() => to.state.refused >= 2),
        );
        // Nothing more was read while the receiver was owed a page: one waits, and no more.
        yield* Effect.sleep("100 millis");
        yield* Scope.close(first, { _tag: "Success", value: undefined } as never);
        expect(messageIds(to.held())).toEqual(expected.slice(0, 4));
        const kept = openOutbox(file);
        expect(kept.last() - kept.confirmed()).toBe(1);
        expect(kept.backfillNext()).toEqual({ threadId: "b", afterSeq: 0 });
        kept.close();
        const confirmed = to.held().length;
        const postedBefore = to.posted.length;

        // Started again on the same file, and a message settles in the last thread meanwhile.
        to.state.stopAt = Number.POSITIVE_INFINITY;
        const events = yield* Queue.unbounded<OwnEvent>();
        yield* sinkOn(events);
        const live = put("c", 6);
        yield* Queue.offer(events, {
          type: "message.settled",
          threadId: "c" as ThreadId,
          messageId: live,
        });
        yield* eventually(
          "every message",
          Effect.sync(() => to.messages().length >= expected.length + 1),
        );
        yield* Effect.sleep("150 millis");

        // Every stored message once, each thread's in order, the oldest thread first; the one
        // that settled meanwhile went when it settled, ahead of the pages still to come, and
        // was not sent again when its thread's turn came.
        const got = messageIds(to.held());
        expect(got.filter((id) => id !== live)).toEqual(expected);
        expect(got.filter((id) => id === live)).toHaveLength(1);
        expect(got.indexOf(live)).toBeLessThan(got.indexOf("b-m1"));
        // Nothing the receiver had confirmed was posted again.
        const again = to.posted.slice(postedBefore);
        expect(Math.min(...again.map((event) => event.seq))).toBe(confirmed + 1);
        expect(
          messageIds(again).filter((id) => expected.slice(0, 4).includes(id as string)),
        ).toEqual([]);
        expect(to.bySource.size).toBe(1);
        expect(to.held().map((event) => event.seq)).toEqual(to.held().map((_, i) => i + 1));
      }),
  );

  it.live("a backlog given up owes only the messages that were in it", () =>
    Effect.gen(function* () {
      const to = yield* countingReceiver;
      const { put, thread, read } = storedThreads();
      const threads = [thread("a", 100), thread("b", 200)];
      for (const id of ["a", "b"]) for (let n = 1; n <= 2; n++) put(id, n);
      const events = yield* Queue.unbounded<OwnEvent>();
      const sink = yield* makeEventSink({
        endpoint: { url: to.url, token: "sink-token" },
        file: ":memory:",
        on: Effect.succeed(true),
        threads: Effect.succeed(threads),
        events: Stream.fromQueue(events),
        messages: read,
        maxUnsent: 5,
        backfillPause: Duration.millis(10),
        retryBase: Duration.millis(5),
        retryMax: Duration.millis(20),
        recheck: Duration.millis(5),
      });
      yield* eventually(
        "the stored messages",
        Effect.sync(() => to.messages().length === 4),
      );
      // The receiver goes away; a message settles in one thread, and more than may wait follows.
      to.state.down = true;
      const late = put("b", 3);
      yield* Queue.offer(events, {
        type: "message.settled",
        threadId: "b" as ThreadId,
        messageId: late,
      });
      yield* eventually(
        "a refused send",
        Effect.sync(() => to.state.refused >= 1),
      );
      yield* recordStatuses(sink, 1, 6);
      to.state.down = false;
      yield* eventually(
        "the message that was given up",
        Effect.sync(() => to.bySource.size === 2 && to.messages().length === 5),
      );
      yield* Effect.sleep("100 millis");
      // The new source opens with the threads, and is sent the one message the receiver never
      // got: what it holds of the others is whole, and is not sent again.
      const [, second] = [...to.bySource.values()];
      expect(second![0]!.type).toBe("sink.started");
      expect(
        second!.filter((event) => event.type === "message").map((event) => event.data["id"]),
      ).toEqual([late]);
    }),
  );

  it.live("a receiver that fell back past what is kept is sent every stored message again", () =>
    Effect.gen(function* () {
      const { put, thread, read } = storedThreads();
      put("a", 1);
      put("a", 2);
      // It takes everything, then answers as if it held nothing of this source.
      const state = { lost: false };
      const sent: Array<readonly [string, string]> = [];
      const held = new Map<string, number>();
      const server = yield* endpoint<SinkBatch>((batch) => {
        if (state.lost) {
          state.lost = false;
          return { json: { ack: 0 } };
        }
        let ack = held.get(batch.source) ?? 0;
        for (const event of batch.events) {
          if (event.seq !== ack + 1) continue;
          ack++;
          if (event.type === "message") sent.push([batch.source, event.data["id"] as string]);
        }
        held.set(batch.source, ack);
        return { json: { ack } };
      });
      const sink = yield* makeEventSink({
        endpoint: { url: server.url, token: "sink-token" },
        file: ":memory:",
        on: Effect.succeed(true),
        threads: Effect.succeed([thread("a", 100)]),
        messages: read,
        backfillPause: Duration.millis(10),
        retryBase: Duration.millis(5),
        retryMax: Duration.millis(20),
        recheck: Duration.millis(5),
        keepsConfirmed: 2,
      });
      yield* eventually(
        "the stored messages",
        Effect.sync(() => sent.length === 2),
      );
      // Enough is confirmed after them that they are no longer kept, then the receiver falls back.
      yield* recordStatuses(sink, 1, 6);
      yield* eventually(
        "the statuses",
        Effect.sync(() => [...held.values()][0] === 9),
      );
      state.lost = true;
      yield* recordStatuses(sink, 7, 7);
      yield* eventually(
        "the messages again",
        Effect.sync(() => sent.length === 4),
      );
      expect(new Set(sent.map(([source]) => source)).size).toBe(2);
      expect(sent.map(([, id]) => id)).toEqual(["a-m1", "a-m2", "a-m1", "a-m2"]);
    }),
  );

  /** The same turn against a sink with and without messages; ids differ, so they are named. */
  const turnWith = (messages: boolean) =>
    Effect.gen(function* () {
      const to = yield* receiver;
      return yield* Effect.gen(function* () {
        const thread = yield* streamedTurn();
        const held = yield* settledAt(to);
        const turns = new Map<string, string>();
        const named = (value: unknown): unknown =>
          JSON.parse(
            JSON.stringify(value)
              .replaceAll(thread.id, "thread")
              .replaceAll(/"turnId":"([^"]+)"/g, (_, id: string) => {
                if (!turns.has(id)) turns.set(id, `turn-${turns.size + 1}`);
                return `"turnId":"${turns.get(id)}"`;
              }),
          );
        return held.map(({ at: _at, seq: _seq, ...event }) => named(event) as Partial<SinkEvent>);
      }).pipe(Effect.provide(serverLayer(undefined, to.url, messages)));
    });

  it.live("with messages not asked for, the sink sends what it did before there were any", () =>
    Effect.gen(function* () {
      const without = yield* turnWith(false);
      const withMessages = yield* turnWith(true);
      expect(without.length).toBeGreaterThan(3);
      expect(without.some((event) => event.type === "message")).toBe(false);
      expect(withMessages.some((event) => event.type === "message")).toBe(true);
      // Asking for messages adds them and changes nothing else; not asking sends none.
      expect(without).toEqual(withMessages.filter((event) => event.type !== "message"));
    }),
  );
});
