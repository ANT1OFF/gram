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
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl, makeFakeAgentAdapter } from "../runtime/fake-agent.ts";
import { CheckoutService, TurnHooks } from "../runtime/hooks.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { UsageLimitReadings } from "../usage/limit-readings.ts";
import { DecisionHook } from "./decision-hook.ts";
import { EventSink, makeEventSink, type EventSinkShape } from "./event-sink.ts";
import { ActingPerson } from "./person.ts";
import { makeActionGuard } from "./guard.ts";

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

const serverLayer = (decisionUrl: string | undefined, sinkUrl?: string) =>
  AppToolRegistry.layer.pipe(
    Layer.provideMerge(ThreadRuntimes.layerOnLocalHost),
    Layer.provideMerge(UsageLimitReadings.layer),
    Layer.provideMerge(DecisionHook.layer.pipe(Layer.provideMerge(EventSink.layer))),
    Layer.provideMerge(EventHub.layer),
    Layer.provideMerge(ThreadStore.layerSqlite(":memory:")),
    Layer.provideMerge(makeFakeAgentAdapter({ reply: "echo" })),
    Layer.provideMerge(TurnHooks.layerNoop),
    Layer.provideMerge(CheckoutService.layerNoGit),
    Layer.provideMerge(
      ServerConfig.layer({
        ...TEST_CONFIG,
        ...(decisionUrl === undefined
          ? {}
          : {
              decisionHook:
                decisionUrl === "unusable"
                  ? ("unusable" as const)
                  : { url: decisionUrl, token: "hook-token" },
            }),
        ...(sinkUrl === undefined ? {} : { eventSink: { url: sinkUrl, token: "sink-token" } }),
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
        const thread = yield* startThread("ship it /approve{gh release create v1}");
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
        expect(to.held[0]!.type).toBe("sink.started");
        expect(to.held.some((event) => event.type === "thread.upsert")).toBe(true);
        expect(to.held.map((event) => event.seq)).toEqual(to.held.map((_, i) => i + 1));
      }).pipe(Effect.provide(serverLayer(hook.url, to.url)));
    }),
  );
});
