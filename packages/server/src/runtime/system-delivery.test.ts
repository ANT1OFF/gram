import { describe, expect, it } from "@effect/vitest";
import {
  fenceThreadMessage,
  ThreadNotFound,
  type MessageId,
  type OrchestrationDigest,
  type ServerEvent,
  type ThreadId,
  type UserInput,
  type WorkspaceId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl, type FakeSession } from "./fake-agent.ts";
import { CheckoutService, TurnHooks } from "./hooks.ts";
import {
  fakeAgentWithFailingSend,
  makeRuntimeTestLayer,
  recordingDelivery,
  recordingObserver,
  replyStart,
  RuntimeTestLayer,
  TEST_CONFIG,
  waitFor,
} from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

const DIGEST: OrchestrationDigest = {
  kind: "orchestration",
  variant: "digest",
  generation: 3,
  workspaceId: "w1" as WorkspaceId,
  workspaceName: "Shop",
  reasons: ["a worker finished"],
  changes: [],
  reports: [],
  features: [],
  budget: {
    liveWorkers: 1,
    maxConcurrentWorkers: 4,
    costUsdToday: 0.5,
  },
  notes: [],
};

const digest = (text: string): UserInput => ({ text, notice: DIGEST });

const waitStatus = (threadId: ThreadId, status: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    return yield* waitFor(
      `status ${status}`,
      runtimes.status(threadId).pipe(Effect.map((s) => s === status)),
    );
  });

/** A thread whose session is open and idle, with no turn yet. */
const createIdle = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;
  const fake = yield* FakeAgentControl;
  const thread = yield* runtimes.create({
    projectRoot: "/work/repo",
    checkout: { kind: "main", path: "/work/repo" },
  });
  yield* waitStatus(thread.id, "idle");
  return { thread, session: yield* fake.latest(thread.id) };
});

/** A thread in the middle of the user's first turn. */
const createRunning = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;
  const fake = yield* FakeAgentControl;
  const thread = yield* runtimes.create({
    projectRoot: "/work/repo",
    checkout: { kind: "main", path: "/work/repo" },
    input: { text: "one" },
  });
  const session = yield* waitFor(
    "the first send",
    fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
  );
  yield* waitStatus(thread.id, "running");
  return { thread, session };
});

const sentTexts = (session: FakeSession) => session.sent.map((input) => input.text);

const waitSent = (session: FakeSession, count: number) =>
  waitFor(
    `send ${count}`,
    Effect.sync(() => session.sent.length === count),
  );

const waitCalls = (calls: ReadonlyArray<string>, count: number) =>
  waitFor(
    `${count} delivery callbacks`,
    Effect.sync(() => calls.length === count),
  );

/** Lets every fiber that can run do so, so "nothing more happened" means something. */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
});

const startChunk = (session: FakeSession, id: string) =>
  session.emit({ type: "chunk", messageId: id as MessageId, chunk: replyStart(id) });

describe("system delivery", () => {
  it.effect("sends to an idle thread as its own turn, and is accepted on the first chunk", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread, session } = yield* createIdle;
      const { delivery, calls, turnIds } = recordingDelivery(digest("digest #3"));

      yield* runtimes.requestSystemDelivery(thread.id, "digest", delivery);
      expect(sentTexts(session)).toEqual(["digest #3"]);
      expect(yield* runtimes.status(thread.id)).toBe("running");
      yield* settle;
      expect(calls).toEqual(["build"]);

      const [turn] = yield* store.listTurns(thread.id);
      expect(turn?.id).toBe(turnIds[0]);
      const [message] = yield* store.listMessages(thread.id);
      expect(message?.metadata?.turnId).toBe(turnIds[0]);
      expect(message?.parts).toEqual([
        { type: "text", text: "digest #3" },
        { type: "data-orchestration-digest", id: message?.id, data: DIGEST },
      ]);

      yield* startChunk(session, "reply-a");
      yield* waitCalls(calls, 2);
      yield* session.completeTurn();
      yield* waitStatus(thread.id, "idle");
      yield* settle;
      expect(calls).toEqual(["build", "accepted"]);
      expect(turnIds).toEqual([turnIds[0], turnIds[0]]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("starts no turn once the server stops accepting them for its shutdown", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createIdle;
      const { delivery, calls } = recordingDelivery(digest("digest #4"));
      yield* runtimes.stopAccepting;
      yield* runtimes.requestSystemDelivery(thread.id, "digest", delivery);
      yield* settle;
      expect(sentTexts(session)).toEqual([]);
      expect(calls).toEqual([]);
      expect(yield* runtimes.status(thread.id)).toBe("idle");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("is accepted by an adapter turn end that streamed nothing", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createIdle;
      for (const reason of ["completed", "interrupted", "maxTurns"] as const) {
        const { delivery, calls } = recordingDelivery(digest(reason));
        yield* runtimes.requestSystemDelivery(thread.id, "digest", delivery);
        yield* session.emit({ type: "turnEnd", reason }, { type: "status", status: "idle" });
        yield* waitCalls(calls, 2);
        expect(calls).toEqual(["build", "accepted"]);
        yield* waitStatus(thread.id, "idle");
      }
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "fails on an adapter error before any chunk, and an errored thread takes the next",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const { thread, session } = yield* createIdle;
        const first = recordingDelivery(digest("first"));
        yield* runtimes.requestSystemDelivery(thread.id, "digest", first.delivery);
        yield* session.emit({ type: "turnEnd", reason: "error", error: "rate limited" });
        yield* waitCalls(first.calls, 2);
        expect(first.calls).toEqual(["build", "failed:turnError"]);
        expect(first.turnIds[1]).toBe(first.turnIds[0]);
        yield* waitStatus(thread.id, "error");

        // The session is still open, and takes it as it would the user's message.
        const second = recordingDelivery(digest("second"));
        yield* runtimes.requestSystemDelivery(thread.id, "digest", second.delivery);
        expect(sentTexts(session)).toEqual(["first", "second"]);
        yield* startChunk(session, "reply-b");
        yield* waitCalls(second.calls, 2);
        expect(second.calls).toEqual(["build", "accepted"]);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps what waits behind a turn that fails, and sends it once the thread settles", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      const { delivery, calls } = recordingDelivery(digest("waiting"));
      yield* runtimes.requestSystemDelivery(thread.id, "digest", delivery);
      yield* session.emit({ type: "turnEnd", reason: "error", error: "overloaded" });
      yield* waitStatus(thread.id, "error");
      yield* settle;
      expect(calls).toEqual([]);
      yield* session.emit({ type: "status", status: "idle" });
      yield* waitSent(session, 2);
      expect(sentTexts(session)).toEqual(["one", "waiting"]);
      expect(calls).toEqual(["build"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  // `codex/session.ts::send` resolves after a rejection too,
  // and say so with exactly these three events. None of them is the agent taking the message.
  it.effect("fails when the adapter reports it didn't accept the message, as Codex does", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createIdle;
      const { delivery, calls, turnIds } = recordingDelivery(digest("digest"));
      yield* runtimes.requestSystemDelivery(thread.id, "digest", delivery);
      yield* session.emit(
        { type: "notice", level: "error", message: "Codex didn't accept the message: 401" },
        { type: "turnEnd", reason: "error", error: "401" },
        { type: "status", status: "idle" },
      );
      yield* waitCalls(calls, 2);
      yield* settle;
      expect(calls).toEqual(["build", "failed:turnError"]);
      expect(turnIds[1]).toBe(turnIds[0]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("an error end after the reply started doesn't undo the acceptance", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createIdle;
      const { delivery, calls } = recordingDelivery(digest("digest"));
      yield* runtimes.requestSystemDelivery(thread.id, "digest", delivery);
      yield* startChunk(session, "reply-a");
      yield* session.emit({ type: "turnEnd", reason: "error", error: "overloaded" });
      yield* waitStatus(thread.id, "error");
      yield* settle;
      expect(calls).toEqual(["build", "accepted"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("waits for the running turn and for the user's queue, and never joins it", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const hub = yield* EventHub;
      const queues: Array<ReadonlyArray<string>> = [];
      yield* Effect.forkScoped(
        Stream.runForEach(
          hub.serverEvents(Effect.succeed<ServerEvent>({ type: "threads.snapshot", threads: [] })),
          (event) =>
            Effect.sync(() => {
              if (event.type === "thread.queue") queues.push(event.queue.map((q) => q.input.text));
            }),
        ),
      );
      const { thread, session } = yield* createRunning;
      const { delivery, calls } = recordingDelivery(digest("digest"));

      yield* runtimes.requestSystemDelivery(thread.id, "digest", delivery);
      yield* runtimes.send(thread.id, { text: "two" });
      const [summary] = yield* runtimes.snapshot;
      expect(summary?.queue.map((q) => q.input.text)).toEqual(["two"]);
      expect((yield* store.listQueue(thread.id)).map((q) => q.input.text)).toEqual(["two"]);
      // The whole queue, as the queue RPCs see it, is the user's one item.
      yield* runtimes.reorderQueue(thread.id, [summary!.queue[0]!.id]);
      yield* settle;
      expect(calls).toEqual([]);

      yield* session.completeTurn();
      yield* waitSent(session, 2);
      yield* settle;
      expect(sentTexts(session)).toEqual(["one", "two"]);
      expect(calls).toEqual([]);

      yield* session.completeTurn();
      yield* waitSent(session, 3);
      expect(sentTexts(session)).toEqual(["one", "two", "digest"]);
      yield* session.completeTurn();
      yield* waitCalls(calls, 2);
      expect(calls).toEqual(["build", "accepted"]);
      expect(queues.flat()).not.toContain("digest");
      expect(yield* store.listQueue(thread.id)).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("a request racing the end of a turn is sent exactly once", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      const { delivery, calls } = recordingDelivery(digest("digest"));
      yield* Effect.all(
        [session.completeTurn(), runtimes.requestSystemDelivery(thread.id, "digest", delivery)],
        { concurrency: "unbounded" },
      );
      yield* waitSent(session, 2);
      yield* settle;
      expect(sentTexts(session)).toEqual(["one", "digest"]);
      yield* session.completeTurn();
      yield* waitStatus(thread.id, "idle");
      yield* settle;
      expect(sentTexts(session)).toEqual(["one", "digest"]);
      expect(calls).toEqual(["build", "accepted"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("folds by key: a repeat replaces the unsent one, another key waits its turn", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      const stale = recordingDelivery(digest("stale"));
      const fresh = recordingDelivery(digest("fresh"));
      const other = recordingDelivery(digest("other"));
      const dropped = recordingDelivery(digest("dropped"));
      yield* runtimes.requestSystemDelivery(thread.id, "digest", stale.delivery);
      yield* runtimes.requestSystemDelivery(thread.id, "other", other.delivery);
      yield* runtimes.requestSystemDelivery(thread.id, "dropped", dropped.delivery);
      yield* runtimes.requestSystemDelivery(thread.id, "digest", fresh.delivery);
      yield* runtimes.cancelSystemDelivery(thread.id, "dropped");

      yield* session.completeTurn();
      yield* waitSent(session, 2);
      yield* session.completeTurn();
      yield* waitSent(session, 3);
      yield* session.completeTurn();
      yield* waitStatus(thread.id, "idle");
      yield* settle;
      expect(sentTexts(session)).toEqual(["one", "fresh", "other"]);
      expect(stale.calls).toEqual([]);
      expect(dropped.calls).toEqual([]);
      expect(fresh.calls).toEqual(["build", "accepted"]);
      expect(other.calls).toEqual(["build", "accepted"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("opens no turn for a build that has nothing to say, and moves on to the next", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread, session } = yield* createIdle;
      const nothing = recordingDelivery(() => undefined);
      yield* runtimes.requestSystemDelivery(thread.id, "digest", nothing.delivery);
      yield* settle;
      expect(nothing.calls).toEqual(["build"]);
      expect(session.sent).toEqual([]);
      expect(yield* store.listTurns(thread.id)).toEqual([]);
      expect(yield* runtimes.status(thread.id)).toBe("idle");

      yield* runtimes.send(thread.id, { text: "one" });
      const again = recordingDelivery(() => undefined);
      const broken = recordingDelivery(() => {
        throw new Error("no ledger");
      });
      const next = recordingDelivery(digest("next"));
      yield* runtimes.requestSystemDelivery(thread.id, "a", again.delivery);
      yield* runtimes.requestSystemDelivery(thread.id, "b", broken.delivery);
      yield* runtimes.requestSystemDelivery(thread.id, "c", next.delivery);
      yield* session.completeTurn();
      yield* waitSent(session, 2);
      yield* waitCalls(broken.calls, 2);
      expect(sentTexts(session)).toEqual(["one", "next"]);
      expect(again.calls).toEqual(["build"]);
      expect(broken.calls).toEqual(["build", "failed:buildFailed"]);
      expect(broken.turnIds[1]).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("opens a cold thread's session to deliver", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const { thread, session } = yield* createRunning;
      yield* session.completeTurn();
      yield* waitStatus(thread.id, "idle");
      yield* TestClock.adjust("15 minutes");
      yield* waitStatus(thread.id, "cold");

      const { delivery, calls } = recordingDelivery(digest("while you were away"));
      yield* runtimes.requestSystemDelivery(thread.id, "digest", delivery);
      const resumed = yield* waitFor(
        "the reopened session",
        Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]),
      );
      expect(resumed.options.resumeId).toBe(session.agentSessionId);
      yield* waitSent(resumed, 1);
      expect(sentTexts(resumed)).toEqual(["while you were away"]);
      yield* resumed.completeTurn();
      yield* waitCalls(calls, 2);
      expect(calls).toEqual(["build", "accepted"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("fails a cold thread's delivery when its agent can't start", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const { thread, session } = yield* createRunning;
      yield* session.completeTurn();
      yield* waitStatus(thread.id, "idle");
      yield* TestClock.adjust("15 minutes");
      yield* waitStatus(thread.id, "cold");
      yield* fake.setUnavailable("claude isn't installed");

      const { delivery, calls } = recordingDelivery(digest("digest"));
      yield* runtimes.requestSystemDelivery(thread.id, "digest", delivery);
      yield* waitCalls(calls, 1);
      expect(calls).toEqual(["failed:error"]);
      expect(yield* runtimes.status(thread.id)).toBe("error");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("fails when the interrupt watchdog ends the turn, once", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      yield* fake.setInterruptBehavior("hang");
      const { thread, session } = yield* createIdle;
      const { delivery, calls, turnIds } = recordingDelivery(digest("digest"));
      const watched = recordingObserver();
      yield* runtimes.observe(watched.observer);
      yield* runtimes.requestSystemDelivery(thread.id, "digest", delivery);

      const interrupting = yield* Effect.forkScoped(runtimes.interrupt(thread.id));
      yield* waitFor(
        "the interrupt call",
        Effect.sync(() => session.interrupts === 1),
      );
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(interrupting);
      yield* waitFor(
        "the resumed session",
        Effect.sync(() => fake.sessions.length === 2),
      );
      yield* waitStatus(thread.id, "idle");
      yield* settle;
      expect(calls).toEqual(["build", "failed:recovered"]);
      expect(turnIds[1]).toBe(turnIds[0]);
      expect(watched.seen).toEqual(["start", "end:interrupted:synthesized:empty"]);
      // Gone after a failure: the resumed session is sent nothing until it is asked again.
      expect(fake.sessions[1]?.sent).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("fails what a turn carries and what is waiting when the thread closes", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread } = yield* createIdle;
      const carried = recordingDelivery(digest("carried"));
      const waiting = recordingDelivery(digest("waiting"));
      const watched = recordingObserver();
      yield* runtimes.observe(watched.observer);
      yield* runtimes.requestSystemDelivery(thread.id, "digest", carried.delivery);
      yield* runtimes.requestSystemDelivery(thread.id, "other", waiting.delivery);

      yield* runtimes.close(thread.id);
      yield* waitCalls(carried.calls, 2);
      yield* waitCalls(waiting.calls, 1);
      expect(carried.calls).toEqual(["build", "failed:sessionExit"]);
      expect(waiting.calls).toEqual(["failed:ended"]);
      expect(watched.seen).toEqual(["start", "end:interrupted:synthesized:more"]);
      const gone = yield* runtimes
        .requestSystemDelivery(thread.id, "digest", carried.delivery)
        .pipe(Effect.flip);
      expect(gone).toBeInstanceOf(ThreadNotFound);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("fails when the send dies, closes the turn, and leaves the session usable", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread, session } = yield* createRunning;
      const watched = recordingObserver();
      yield* runtimes.observe(watched.observer);
      const { delivery, calls, turnIds } = recordingDelivery(digest("boom"));
      yield* runtimes.requestSystemDelivery(thread.id, "digest", delivery);
      // Without the adapter's trailing `idle`, which settles an errored thread like any other.
      yield* session.emit({ type: "turnEnd", reason: "completed" });
      yield* waitCalls(calls, 2);
      expect(calls).toEqual(["build", "failed:sendFailed"]);
      expect(turnIds[1]).toBe(turnIds[0]);
      expect(yield* runtimes.status(thread.id)).toBe("error");
      expect((yield* store.listTurns(thread.id)).map((t) => t.reason)).toEqual([
        "completed",
        "error",
      ]);
      yield* waitFor(
        "the synthesized turn end",
        Effect.sync(() => watched.seen.length === 3),
      );
      expect(watched.seen).toEqual([
        "end:completed:adapter:more",
        "start",
        "end:error:synthesized:empty",
      ]);

      expect(yield* runtimes.send(thread.id, { text: "carry on" })).toEqual({ queued: false });
      expect(sentTexts(session)).toEqual(["one", "carry on"]);
    }).pipe(
      Effect.provide(
        makeRuntimeTestLayer(
          TurnHooks.layerNoop,
          CheckoutService.layerNoGit,
          TEST_CONFIG,
          fakeAgentWithFailingSend("boom"),
        ),
      ),
    ),
  );

  it.effect("gets to a delivery that arrived while a server-raised card was up", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread, session } = yield* createIdle;
      const asking = yield* Effect.forkScoped(
        runtimes.requestApproval(thread.id, {
          toolName: "mcp__gram__probe",
          displayName: "probe",
          input: {},
          suggestions: [],
        }),
      );
      const card = yield* waitFor(
        "the card",
        store.listRequests(thread.id).pipe(Effect.map((requests) => requests[0])),
      );
      const { delivery } = recordingDelivery(digest("digest"));
      yield* runtimes.requestSystemDelivery(thread.id, "digest", delivery);
      yield* settle;
      expect(session.sent).toEqual([]);

      yield* runtimes.respond(thread.id, card.id, {
        kind: "approval",
        decision: "allow",
        scope: "once",
      });
      yield* Fiber.join(asking);
      yield* waitSent(session, 1);
      expect(sentTexts(session)).toEqual(["digest"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("sends what was queued while a server-raised card was up on an idle thread", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread, session } = yield* createIdle;
      const asking = yield* Effect.forkScoped(
        runtimes.requestApproval(thread.id, {
          toolName: "mcp__gram__probe",
          displayName: "probe",
          input: {},
          suggestions: [],
        }),
      );
      const card = yield* waitFor(
        "the card",
        store.listRequests(thread.id).pipe(Effect.map((requests) => requests[0])),
      );
      expect(yield* runtimes.sendNotice(thread.id, "ci:7", { text: "CI passed on #7" })).toEqual({
        queued: true,
        steered: false,
        replaced: false,
      });

      yield* runtimes.respond(thread.id, card.id, {
        kind: "approval",
        decision: "allow",
        scope: "once",
      });
      yield* Fiber.join(asking);
      yield* waitSent(session, 1);
      expect(sentTexts(session)).toEqual(["CI passed on #7"]);
      const [summary] = yield* runtimes.snapshot;
      expect(summary?.queue).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("a callback may call back into the runtime", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createIdle;
      const base = recordingDelivery(digest("digest"));
      const self = { threadId: thread.id, title: "Self", depth: 1 };
      yield* runtimes.requestSystemDelivery(thread.id, "digest", {
        ...base.delivery,
        accepted: () =>
          runtimes
            .send(thread.id, { text: "from the callback", origin: self })
            .pipe(Effect.asVoid, Effect.orDie),
      });
      yield* startChunk(session, "reply-a");
      yield* session.completeTurn();
      yield* waitSent(session, 2);
      expect(sentTexts(session)).toEqual(["digest", fenceThreadMessage(self, "from the callback")]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});

describe("runtime observer", () => {
  it.effect("hears turns, whether more is queued, retries, and what the user typed", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const hub = yield* EventHub;
      const statuses: Array<string> = [];
      yield* Effect.forkScoped(
        Stream.runForEach(
          hub.serverEvents(Effect.succeed<ServerEvent>({ type: "threads.snapshot", threads: [] })),
          (event) =>
            Effect.sync(() => {
              if (event.type === "thread.status") statuses.push(event.status);
            }),
        ),
      );
      const { thread, session } = yield* createIdle;
      const watched = recordingObserver();
      yield* runtimes.observe(watched.observer);

      yield* runtimes.send(thread.id, { text: "one" });
      yield* runtimes.send(thread.id, { text: "two" });
      yield* runtimes.send(thread.id, {
        text: "relayed",
        origin: { threadId: thread.id, title: "Self", depth: 1 },
      });
      yield* runtimes.send(thread.id, digest("a notice"));
      yield* runtimes.steer(thread.id, { text: "steered" });
      yield* waitStatus(thread.id, "running");
      const before = statuses.length;
      yield* session.emit({ type: "status", status: "retrying" });
      yield* session.emit({ type: "status", status: "retrying" });
      yield* session.emit({ type: "status", status: "running" });
      yield* session.emit({ type: "status", status: "retrying" });
      yield* session.completeTurn();
      yield* waitSent(session, 2);
      yield* waitFor(
        "the second turn's start",
        Effect.sync(() => watched.seen.filter((line) => line === "start").length === 2),
      );
      expect(watched.seen).toEqual([
        "start",
        "input:one",
        "input:two",
        "input:steered",
        "retrying:true",
        "retrying:false",
        "retrying:true",
        "retrying:false",
        "end:completed:adapter:more",
        "start",
      ]);
      expect(watched.ends[0]?.turnId).toBeDefined();
      yield* waitFor(
        "the second turn's status",
        Effect.sync(() => statuses.length === before + 2),
      );
      // Retrying stays folded into `running` for clients: the turn end is the next thing they hear.
      expect(statuses.slice(before)).toEqual(["idle", "running"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("stops hearing once its scope closes", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createIdle;
      const watched = recordingObserver();
      yield* Effect.scoped(runtimes.observe(watched.observer));
      yield* runtimes.send(thread.id, { text: "one" });
      yield* session.completeTurn();
      yield* waitStatus(thread.id, "idle");
      yield* settle;
      expect(watched.seen).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
