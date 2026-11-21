// A stop claimed for a turn (an interrupt past a card, or Stop) holds the queue and Gram's
// deliveries until it has settled: the session's interrupt can arrive late, and must never reach
// the turn a queued message would start. Each case intercepts only the session's asynchronous
// interrupt; the runtime's queue and lifecycle are the production code. Several come from an
// independent review of #702.

import { describe, expect, it } from "@effect/vitest";
import type { RequestId } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "./agent-hosts.ts";
import { FakeAgentAdapter, FakeAgentControl } from "./fake-agent.ts";
import { makeRuntimeTestLayer, RuntimeTestLayer, waitFor, respondAsShown } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

/** A thread whose first turn waits on the agent's approval card. */
const atCard = Effect.gen(function* () {
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
  yield* session.emit({
    type: "request",
    request: {
      kind: "approval",
      id: "agent-card" as RequestId,
      toolName: "Bash",
      displayName: "Bash",
      input: { command: "git push" },
      suggestions: [],
    },
  });
  yield* waitFor(
    "the card",
    runtimes.status(thread.id).pipe(Effect.map((s) => s === "needsApproval")),
  );
  return { runtimes, thread, session };
});

/**
 * Then a card of Gram's own in its place: a stop withdraws it fail-closed, so the tool call it held
 * is answered at once and the turn can end on its own while the session's interrupt is on its way.
 */
const atServerCard = Effect.gen(function* () {
  const state = yield* atCard;
  yield* respondAsShown(state.runtimes, state.thread.id, "agent-card" as RequestId, {
    kind: "approval",
    decision: "deny",
    scope: "once",
  });
  const asking = yield* Effect.forkScoped(
    state.runtimes.requestApproval(state.thread.id, {
      toolName: "mcp__gram__probe",
      displayName: "probe",
      input: {},
      suggestions: [],
    }),
  );
  yield* waitFor(
    "the server's card",
    state.runtimes.status(state.thread.id).pipe(Effect.map((s) => s === "needsApproval")),
  );
  return { ...state, asking };
});

/**
 * The fake agent with its session's interrupt passed through `interrupt`, and `onSend` told of each
 * send. Nothing else is touched.
 */
const interceptedAgents = (
  interrupt: (native: Effect.Effect<void, unknown>) => Effect.Effect<void, unknown>,
  onSend: () => void = () => {},
) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const hosts = yield* AgentHosts;
      const control = yield* FakeAgentControl;
      return Context.make(
        AgentHosts,
        AgentHosts.of({
          get: (kind) =>
            hosts.get(kind).pipe(
              Effect.map((host) => ({
                ...host,
                open: (options: Parameters<typeof host.open>[0]) =>
                  host.open(options).pipe(
                    Effect.map((session) => ({
                      ...session,
                      send: (...args: Parameters<typeof session.send>) =>
                        session.send(...args).pipe(Effect.tap(() => Effect.sync(onSend))),
                      interrupt: Effect.suspend(() =>
                        interrupt(session.interrupt),
                      ) as typeof session.interrupt,
                    })),
                  ),
              })),
            ),
        }),
      ).pipe(Context.add(FakeAgentControl, control));
    }),
  ).pipe(Layer.provide(FakeAgentAdapter));

/**
 * A late interrupt: it waits on `during`, and then reaches the agent only while a turn is open
 * there, as a real adapter's does (Codex's interrupts its own current turn, and has none after it
 * ended); the fake's would end one regardless.
 */
const lateInterrupt = () => {
  const state = { during: Effect.void as Effect.Effect<void, unknown>, turnOpen: true };
  const agents = interceptedAgents(
    (native) =>
      state.during.pipe(
        Effect.andThen(Effect.suspend(() => (state.turnOpen ? native : Effect.void))),
      ),
    () => {
      state.turnOpen = true;
    },
  );
  return { state, agents };
};

const settle = Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, {
  discard: true,
});

describe("A stop under way holds what would start the next turn", () => {
  it.effect("an interrupt's message waits for the late session interrupt, then runs on", () => {
    const { state, agents } = lateInterrupt();
    return Effect.gen(function* () {
      const { runtimes, thread, session, asking } = yield* atServerCard;
      let sentDuringStop: number | undefined;
      state.during = Fiber.join(asking).pipe(
        Effect.andThen(Effect.sync(() => (state.turnOpen = false))),
        Effect.andThen(session.completeTurn()),
        Effect.andThen(settle),
        Effect.tap(() => Effect.sync(() => (sentDuringStop = session.sent.length))),
        Effect.asVoid,
      );
      yield* runtimes.steer(
        thread.id,
        { text: "Keep this correction running" },
        { pastCard: true, interrupt: true },
      );
      expect(sentDuringStop).toBe(1);
      yield* waitFor(
        "the message",
        Effect.sync(() => session.sent.length === 2),
      );
      expect(session.sent.map((i) => i.text)).toEqual(["one", "Keep this correction running"]);
      const store = yield* ThreadStore;
      const turns = yield* waitFor(
        "both turns recorded",
        store.listTurns(thread.id).pipe(Effect.map((t) => t.length === 2 && t)),
      );
      expect(turns[0]!.endedAt).toBeDefined();
      expect(turns[1]!.endedAt).toBeUndefined();
      yield* settle;
      expect(yield* runtimes.status(thread.id)).toBe("running");
    }).pipe(Effect.provide(makeRuntimeTestLayer(undefined, undefined, undefined, agents)));
  });

  it.effect("a send to the idle thread and a queued Steer wait for it too", () => {
    const { state, agents } = lateInterrupt();
    return Effect.gen(function* () {
      const { runtimes, thread, session, asking } = yield* atServerCard;
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      state.during = Fiber.join(asking).pipe(
        Effect.andThen(Effect.sync(() => (state.turnOpen = false))),
        Effect.andThen(session.completeTurn()),
        Effect.andThen(
          waitFor(
            "idle while the stop is under way",
            runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")),
          ),
        ),
        Effect.andThen(Deferred.succeed(reached, undefined)),
        Effect.andThen(Deferred.await(release)),
        Effect.asVoid,
      );
      const stopping = yield* Effect.forkScoped(runtimes.interrupt(thread.id));
      yield* Deferred.await(reached);
      expect(
        yield* runtimes.send(thread.id, { text: "Typed while the stop is under way" }),
      ).toEqual({ queued: true });
      const [summary] = yield* runtimes.snapshot;
      yield* runtimes.steerQueued(thread.id, summary!.queue[0]!.id);
      expect(session.sent).toHaveLength(1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(stopping);
      yield* waitFor(
        "the held message",
        Effect.sync(() => session.sent.length === 2),
      );
      expect(session.sent[1]!.text).toBe("Typed while the stop is under way");
      expect(yield* runtimes.status(thread.id)).toBe("running");
    }).pipe(Effect.provide(makeRuntimeTestLayer(undefined, undefined, undefined, agents)));
  });

  it.effect("one settled stop doesn't let the queue go while another is still under way", () => {
    // Two stops of the same turn: the interrupt past the card, held at the session, and a Stop
    // after it, which reaches the agent first. The first settling later must still find the
    // queue held until then; only the last to settle sends.
    let calls = 0;
    let first: Effect.Effect<void> = Effect.void;
    let turnOpen = true;
    const agents = interceptedAgents(
      (native) => {
        calls++;
        return (calls === 1 ? first : Effect.void).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              turnOpen
                ? native.pipe(Effect.tap(() => Effect.sync(() => (turnOpen = false))))
                : Effect.void,
            ),
          ),
        );
      },
      () => {
        turnOpen = true;
      },
    );
    return Effect.gen(function* () {
      const { runtimes, thread, session } = yield* atCard;
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      first = Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)));
      const stopping = yield* Effect.forkScoped(
        runtimes.steer(
          thread.id,
          { text: "Correction behind two stops" },
          { pastCard: true, interrupt: true },
        ),
      );
      yield* Deferred.await(reached);
      yield* runtimes.interrupt(thread.id);
      yield* settle;
      const startedWhileFirstStopPending = session.sent.length > 1;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(stopping);
      yield* settle;
      const turns = yield* (yield* ThreadStore).listTurns(thread.id);
      expect({
        startedWhileFirstStopPending,
        sent: session.sent.map((i) => i.text),
        status: yield* runtimes.status(thread.id),
        reasons: turns.map((t) => t.reason),
      }).toEqual({
        startedWhileFirstStopPending: false,
        sent: ["one", "Correction behind two stops"],
        status: "running",
        reasons: ["interrupted", undefined],
      });
    }).pipe(Effect.provide(makeRuntimeTestLayer(undefined, undefined, undefined, agents)));
  });

  it.effect("Gram's own delivery waits for the stop as well", () => {
    const { state, agents } = lateInterrupt();
    return Effect.gen(function* () {
      const { runtimes, thread, session, asking } = yield* atServerCard;
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      state.during = Fiber.join(asking).pipe(
        Effect.andThen(Effect.sync(() => (state.turnOpen = false))),
        Effect.andThen(session.completeTurn()),
        Effect.andThen(
          waitFor(
            "idle before the delivery",
            runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")),
          ),
        ),
        Effect.andThen(Deferred.succeed(reached, undefined)),
        Effect.andThen(Deferred.await(release)),
        Effect.asVoid,
      );
      const stopping = yield* Effect.forkScoped(runtimes.interrupt(thread.id));
      yield* Deferred.await(reached);
      yield* runtimes.requestSystemDelivery(thread.id, "synthetic-digest", {
        build: () => Effect.succeed({ text: "Automatic digest" }),
        accepted: () => Effect.void,
        failed: () => Effect.void,
      });
      yield* settle;
      const startedWhileStopPending = session.sent.length > 1;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(stopping);
      yield* settle;
      const turns = yield* (yield* ThreadStore).listTurns(thread.id);
      expect({
        startedWhileStopPending,
        sent: session.sent.map((i) => i.text),
        status: yield* runtimes.status(thread.id),
        reasons: turns.map((t) => t.reason),
      }).toEqual({
        startedWhileStopPending: false,
        sent: ["one", "Automatic digest"],
        status: "running",
        reasons: ["completed", undefined],
      });
    }).pipe(Effect.provide(makeRuntimeTestLayer(undefined, undefined, undefined, agents)));
  });
});

describe("A stop under way never wedges the queue", () => {
  for (const behavior of ["hang", "fail"] as const) {
    it.effect(`an interrupt that ${behavior}s recovers, then sends the message and the rest`, () =>
      Effect.gen(function* () {
        const { runtimes, thread, session } = yield* atCard;
        const fake = yield* FakeAgentControl;
        yield* fake.setInterruptBehavior(behavior);
        yield* runtimes.send(thread.id, { text: "Older queued input" });
        const stopping = yield* Effect.forkScoped(
          runtimes.steer(thread.id, { text: "Correction" }, { pastCard: true, interrupt: true }),
        );
        yield* waitFor(
          "the session's interrupt",
          Effect.sync(() => session.interrupts === 1),
        );
        if (behavior === "hang") {
          yield* TestClock.adjust("4 seconds");
          expect(session.sent).toHaveLength(1);
          yield* TestClock.adjust("1 second");
        }
        yield* Fiber.join(stopping);
        const resumed = yield* waitFor(
          "the message, after recovery",
          Effect.sync(() => fake.sessions.find((s) => s !== session && s.sent.length === 1)),
        );
        expect(resumed.sent[0]!.text).toBe("Correction");
        yield* resumed.completeTurn();
        yield* waitFor(
          "the older queued input",
          Effect.sync(() => resumed.sent.length === 2),
        );
        expect(resumed.sent[1]!.text).toBe("Older queued input");
      }).pipe(Effect.provide(RuntimeTestLayer)),
    );
  }

  it.effect("a session that exits during a hung stop keeps the message, and sends it", () =>
    Effect.gen(function* () {
      const { runtimes, thread, session } = yield* atCard;
      const fake = yield* FakeAgentControl;
      yield* fake.setInterruptBehavior("hang");
      const stopping = yield* Effect.forkScoped(
        runtimes.steer(
          thread.id,
          { text: "Correction after exit" },
          { pastCard: true, interrupt: true },
        ),
      );
      yield* waitFor(
        "the session's interrupt",
        Effect.sync(() => session.interrupts === 1),
      );
      yield* session.end({ type: "ended", reason: "exited" });
      yield* waitFor(
        "the old session gone",
        runtimes
          .status(thread.id)
          .pipe(Effect.map((s) => s === "cold" || s === "error" || s === "idle")),
      );
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(stopping);
      const resumed = yield* waitFor(
        "the message, after the exit",
        Effect.sync(() => fake.sessions.find((s) => s !== session && s.sent.length > 0)),
      );
      expect(resumed.sent[0]!.text).toBe("Correction after exit");
      expect((yield* runtimes.snapshot)[0]!.queue).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("an interrupt that dies lets the hold go, and the turn's end sends the message", () => {
    const agents = interceptedAgents(() => Effect.die(new Error("synthetic interrupt defect")));
    return Effect.gen(function* () {
      const { runtimes, thread, session } = yield* atCard;
      const result = yield* Effect.exit(
        runtimes.steer(
          thread.id,
          { text: "Correction after defect" },
          { pastCard: true, interrupt: true },
        ),
      );
      expect(result._tag).toBe("Failure");
      yield* session.completeTurn();
      yield* waitFor(
        "the message",
        Effect.sync(() => session.sent.length === 2),
      );
      expect(session.sent[1]!.text).toBe("Correction after defect");
    }).pipe(Effect.provide(makeRuntimeTestLayer(undefined, undefined, undefined, agents)));
  });

  it.effect("the watchdog lets the hold go when the turn ended but the interrupt hangs", () => {
    let during: Effect.Effect<void, unknown> = Effect.void;
    const agents = interceptedAgents(() => during.pipe(Effect.andThen(Effect.never)));
    return Effect.gen(function* () {
      const { runtimes, thread, session, asking } = yield* atServerCard;
      const reached = yield* Deferred.make<void>();
      during = Fiber.join(asking).pipe(
        Effect.andThen(session.completeTurn()),
        Effect.andThen(
          waitFor(
            "the old turn over",
            runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")),
          ),
        ),
        Effect.andThen(Deferred.succeed(reached, undefined)),
        Effect.asVoid,
      );
      const stopping = yield* Effect.forkScoped(
        runtimes.steer(
          thread.id,
          { text: "Correction after the watchdog" },
          { pastCard: true, interrupt: true },
        ),
      );
      yield* Deferred.await(reached);
      expect(session.sent).toHaveLength(1);
      yield* TestClock.adjust("4 seconds");
      expect(session.sent).toHaveLength(1);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(stopping);
      yield* waitFor(
        "the message",
        Effect.sync(() => session.sent.length === 2),
      );
      expect(session.sent[1]!.text).toBe("Correction after the watchdog");
      expect(yield* runtimes.status(thread.id)).toBe("running");
    }).pipe(Effect.provide(makeRuntimeTestLayer(undefined, undefined, undefined, agents)));
  });
});
