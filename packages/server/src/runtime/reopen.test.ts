import { describe, expect, it } from "@effect/vitest";
import { ThreadNotFound, WorktreeDirty, type ServerEvent, type ThreadId } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadPlans } from "../plans/service.ts";
import { FakeAgentControl } from "./fake-agent.ts";
import { CheckoutService } from "./hooks.ts";
import { makeRuntimeTestLayer, RuntimeTestLayer, waitFor } from "./test-harness.ts";
import {
  BACKGROUND_SETTLE,
  mcpChangeReaches,
  restartReady,
  ThreadRuntimes,
  type RestartReadiness,
} from "./thread-runtimes.ts";

const idle = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    yield* waitFor("idle", runtimes.status(threadId).pipe(Effect.map((s) => s === "idle")));
  });

/** An idle thread with one exchange in it. */
const answered = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;
  const fake = yield* FakeAgentControl;
  const thread = yield* runtimes.create({
    projectRoot: "/work/repo",
    checkout: { kind: "main", path: "/work/repo" },
    input: { text: "keep this" },
  });
  const session = yield* waitFor(
    "the first send",
    fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
  );
  yield* session.completeTurn("and this");
  yield* idle(thread.id);
  return { thread, session };
});

/**
 * Checkout releases, counted with whether each removed the worktree, that wait for `open` before
 * they finish. With `refuseFirst`, the first check waits for `refuse` and then refuses.
 */
const heldRelease = (refuseFirst = false) => {
  const open = Deferred.makeUnsafe<void>();
  const refuse = Deferred.makeUnsafe<void>();
  const released = { count: 0, removing: [] as Array<boolean> };
  let checks = 0;
  const layer = Layer.succeed(
    CheckoutService,
    CheckoutService.of({
      prepare: () => Effect.die("unused"),
      checkRelease: () =>
        Effect.suspend(() =>
          refuseFirst && checks++ === 0
            ? Deferred.await(refuse).pipe(
                Effect.andThen(
                  Effect.fail(new WorktreeDirty({ path: "/work/repo", changedFiles: 1 })),
                ),
              )
            : Effect.void,
        ),
      release: (_thread, { removeWorktree }) =>
        Effect.suspend(() => {
          released.count++;
          released.removing.push(removeWorktree !== undefined);
          return Deferred.await(open);
        }),
      discard: () => Effect.void,
      present: () => Effect.succeed(true),
      restore: () => Effect.die("not restored here"),
    }),
  );
  return { open, refuse, released, layer: makeRuntimeTestLayer(undefined, layer) };
};

describe("reopening a closed thread", () => {
  it.effect("brings back its conversation and turns under the same id, ready to rewind", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const checkout = { kind: "main", path: "/work/repo" } as const;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout,
        input: { text: "fix the flake" },
      });
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      yield* session.completeTurn("fixed");
      const items = [{ content: "Fix the flake", status: "completed" as const }];
      yield* (yield* ThreadPlans).setTurnPlan(thread.id, items);
      yield* idle(thread.id);
      const before = yield* store.listMessages(thread.id);
      expect(before.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(yield* store.listTurns(thread.id)).toHaveLength(1);

      yield* runtimes.close(thread.id);
      expect(yield* store.getThread(thread.id).pipe(Effect.flip)).toBeInstanceOf(ThreadNotFound);
      const [closed] = yield* store.listClosed;
      const resumeId = closed?.thread.agentSessionId;
      const events: Array<ServerEvent> = [];
      const hub = yield* EventHub;
      yield* Effect.forkScoped(
        Stream.runForEach(
          hub.serverEvents(Effect.succeed<ServerEvent>({ type: "threads.snapshot", threads: [] })),
          (e) => Effect.sync(() => void events.push(e)),
        ),
      );
      yield* waitFor(
        "the subscription",
        Effect.sync(() => events.length > 0),
      );

      const reopened = yield* runtimes.create({
        id: thread.id,
        projectRoot: "/work/repo",
        checkout,
        restoreClosedHistory: true,
        ...(resumeId === undefined ? {} : { resumeSessionId: resumeId }),
      });
      expect(reopened.id).toBe(thread.id);
      // Clients forgot the plan when the thread closed, so the reopen tells them again.
      yield* waitFor(
        "the plan",
        Effect.sync(() => events.some((e) => e.type === "thread.plan")),
      );
      expect(events.filter((e) => e.type !== "threads.snapshot").map((e) => e.type)).toEqual([
        "thread.upsert",
        "thread.plan",
      ]);
      expect(events.at(-1)).toEqual({ type: "thread.plan", threadId: thread.id, items });
      expect((yield* runtimes.replay(thread.id)).messages.map((m) => m.id)).toEqual(
        before.map((m) => m.id),
      );
      expect(yield* store.listTurns(thread.id)).toHaveLength(1);
      expect(yield* runtimes.rewindTarget(thread.id, before[1]!.id)).toMatchObject({
        messageId: before[1]!.id,
        role: "assistant",
      });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "keeps the conversation when two closes come at once, and releases the checkout once",
    () => {
      const held = heldRelease();
      return Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const { thread } = yield* answered;
        const first = yield* Effect.forkScoped(runtimes.close(thread.id));
        yield* waitFor(
          "the first release",
          Effect.sync(() => held.released.count === 1),
        );
        // Two windows, or a close racing its workspace's removal: the second arrives mid-close.
        const second = yield* Effect.forkScoped(runtimes.close(thread.id), {
          startImmediately: true,
        });
        yield* Deferred.succeed(held.open, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(held.released.count).toBe(1);
        expect((yield* store.listClosedMessages(thread.id)).map((m) => m.role)).toEqual([
          "user",
          "assistant",
        ]);
        expect((yield* store.listClosed).map((c) => c.thread.id)).toEqual([thread.id]);
      }).pipe(Effect.provide(held.layer));
    },
  );

  it.effect("fails a close that asked for the worktree to go when another kept it", () => {
    const held = heldRelease();
    return Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread } = yield* answered;
      const plain = yield* Effect.forkScoped(runtimes.close(thread.id));
      yield* waitFor(
        "the first release",
        Effect.sync(() => held.released.count === 1),
      );
      const removing = yield* Effect.forkScoped(
        runtimes.close(thread.id, { removeWorktree: { force: false } }).pipe(Effect.flip),
        { startImmediately: true },
      );
      yield* Deferred.succeed(held.open, undefined);
      yield* Fiber.join(plain);
      expect(yield* Fiber.join(removing)).toMatchObject({
        _tag: "InvalidState",
        message: "another close of the thread finished first and kept its worktree",
      });
      expect(held.released.count).toBe(1);
    }).pipe(Effect.provide(held.layer));
  });

  it.effect(
    "fails a removal that retried into another caller's close, which kept the worktree",
    () => {
      const held = heldRelease(true);
      return Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const { thread } = yield* answered;
        const removal = { removeWorktree: { force: true } };
        const refused = yield* Effect.forkScoped(
          runtimes.close(thread.id, removal).pipe(Effect.flip),
          {
            startImmediately: true,
          },
        );
        const plain = yield* Effect.forkScoped(runtimes.close(thread.id), {
          startImmediately: true,
        });
        const removing = yield* Effect.forkScoped(
          runtimes.close(thread.id, removal).pipe(Effect.flip),
          { startImmediately: true },
        );
        // Both joined a close that refuses; the plain one claims the next close first.
        yield* Deferred.succeed(held.refuse, undefined);
        expect(yield* Fiber.join(refused)).toBeInstanceOf(WorktreeDirty);
        yield* waitFor(
          "the plain close's release",
          Effect.sync(() => held.released.count === 1),
        );
        yield* Deferred.succeed(held.open, undefined);
        yield* Fiber.join(plain);
        expect(held.released.removing).toEqual([false]);
        expect(yield* Fiber.join(removing)).toMatchObject({ _tag: "InvalidState" });
      }).pipe(Effect.provide(held.layer));
    },
  );

  it.effect("refuses a send to a cold thread while it closes, so no session outlives it", () => {
    const held = heldRelease();
    return Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      // No runtime yet, as after a restart: the close has to claim one itself.
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        deferOpen: true,
      });
      const closing = yield* Effect.forkScoped(runtimes.close(thread.id));
      yield* waitFor(
        "the release",
        Effect.sync(() => held.released.count === 1),
      );
      const refused = yield* runtimes.send(thread.id, { text: "new work" }).pipe(Effect.flip);
      expect(refused.message).toBe("the thread is closing");
      // Nor does a server-authored delivery, an orchestrator's wake say, open one.
      const delivered: Array<string> = [];
      yield* runtimes.requestSystemDelivery(thread.id, "wake", {
        build: () => Effect.succeed({ text: "wake up" }),
        accepted: () => Effect.sync(() => void delivered.push("accepted")),
        failed: (_turn, reason) => Effect.sync(() => void delivered.push(reason)),
      });
      yield* waitFor(
        "the delivery refused",
        Effect.sync(() => delivered.length === 1),
      );
      expect(delivered).toEqual(["ended"]);
      // Nor a fresh session.
      expect((yield* runtimes.freshSession(thread.id).pipe(Effect.flip)).message).toBe(
        "the thread is closing",
      );
      yield* Deferred.succeed(held.open, undefined);
      yield* Fiber.join(closing);
      expect(fake.sessions).toEqual([]);
      expect(yield* store.getThread(thread.id).pipe(Effect.flip)).toBeInstanceOf(ThreadNotFound);
      expect(yield* runtimes.working).toEqual([]);
      // Nor does one arriving after it: there is no thread left to make a runtime for.
      expect(yield* runtimes.send(thread.id, { text: "late" }).pipe(Effect.flip)).toBeInstanceOf(
        ThreadNotFound,
      );
      expect(fake.sessions).toEqual([]);
    }).pipe(Effect.provide(held.layer));
  });

  it.effect("finishes a close whose caller was interrupted while the session stopped", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      yield* fake.setCloseDelay(1000);
      const { thread, session } = yield* answered;
      const closing = yield* Effect.forkScoped(runtimes.close(thread.id));
      yield* waitFor(
        "the session closing",
        Effect.sync(() => session.closing),
      );
      yield* Fiber.interrupt(closing);
      // What the caller held around the close, a git watcher say, is let go once it's over.
      const released: Array<string> = [];
      yield* runtimes.releaseAfterClose(
        thread.id,
        Effect.sync(() => void released.push("watch")),
      );
      // Refused while the close runs on without its caller, so nothing starts the session again.
      const refused = yield* runtimes.send(thread.id, { text: "again" }).pipe(Effect.flip);
      expect(refused.message).toBe("the thread is closing");
      expect(released).toEqual([]);
      yield* TestClock.adjust(1000);
      yield* waitFor(
        "the close",
        store.getThread(thread.id).pipe(
          Effect.flip,
          Effect.map((e) => e instanceof ThreadNotFound),
          Effect.orElseSucceed(() => false),
        ),
      );
      expect(yield* store.listClosedMessages(thread.id)).toHaveLength(2);
      yield* waitFor(
        "the release",
        Effect.sync(() => released.length === 1),
      );
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});

describe("moving a thread's checkout", () => {
  it.effect("reopens an idle session in the new folder, and a busy one once its turn ends", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
      });
      yield* idle(thread.id);
      const first = fake.sessions[0]!;

      const moved = yield* runtimes.moveCheckout(thread.id, {
        kind: "worktree",
        path: "/work/one",
      });
      expect(moved.checkout.path).toBe("/work/one");
      const reopened = yield* waitFor(
        "the reopened session",
        Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]),
      );
      expect(first.closed).toBe(true);
      // No turn yet, so no transcript: it opens fresh under the same id.
      expect(reopened.options).toMatchObject({ cwd: "/work/one", sessionId: first.agentSessionId });
      expect(reopened.options.resumeId).toBeUndefined();
      yield* idle(thread.id);

      yield* runtimes.send(thread.id, { text: "work" });
      yield* waitFor(
        "the send",
        Effect.sync(() => reopened.sent.length === 1),
      );
      yield* runtimes.moveCheckout(thread.id, { kind: "worktree", path: "/work/two" });
      expect(fake.sessions).toHaveLength(2);

      yield* reopened.completeTurn();
      const third = yield* waitFor(
        "the reopen after the turn",
        Effect.sync(() => fake.sessions.length === 3 && fake.sessions[2]),
      );
      expect(third.options).toMatchObject({ cwd: "/work/two", resumeId: first.agentSessionId });
      yield* idle(thread.id);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("queues a send made while the session reopens", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
      });
      yield* idle(thread.id);
      yield* runtimes.moveCheckout(thread.id, { kind: "worktree", path: "/work/one" });
      expect(yield* runtimes.send(thread.id, { text: "after the move" })).toEqual({
        queued: false,
      });
      const reopened = yield* waitFor(
        "the reopened session",
        Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]),
      );
      yield* waitFor(
        "the queued send",
        Effect.sync(() => reopened.sent.length === 1),
      );
      expect(fake.sessions[0]!.sent).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("starts a fresh agent session under the same thread, and only when it is free", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const checkout = { kind: "main", path: "/work/repo" } as const;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout,
        input: { text: "fix the flake" },
      });
      const first = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      // Mid-turn it would cut the agent off, so it waits to be asked again.
      const busy = yield* runtimes.freshSession(thread.id).pipe(Effect.flip);
      expect(busy).toMatchObject({ _tag: "InvalidState" });
      expect(first.closed).toBe(false);
      yield* first.completeTurn("fixed");
      yield* idle(thread.id);
      const [, reply] = yield* store.listMessages(thread.id);

      expect(yield* runtimes.freshSession(thread.id)).toBe(first.agentSessionId);
      // A send made while it opens waits for the new session, as with any reopen.
      yield* runtimes.send(thread.id, { text: "and now the other one" });
      const second = yield* waitFor(
        "the fresh session",
        Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]),
      );
      yield* waitFor(
        "the queued send",
        Effect.sync(() => second.sent.length === 1),
      );
      expect(first.closed).toBe(true);
      expect(second.options.resumeId).toBeUndefined();
      expect(second.agentSessionId).not.toBe(first.agentSessionId);
      expect((yield* store.getThread(thread.id)).agentSessionId).toBe(second.agentSessionId);
      // The conversation is still the thread's, and the old session's part can still be rewound
      // to here: only a handoff part marks messages the new session doesn't hold.
      expect((yield* runtimes.replay(thread.id)).messages.map((m) => m.id)).toContain(reply!.id);
      yield* second.completeTurn("done");
      yield* idle(thread.id);

      // A fork reopens by forking its source, so there is no fresh start for it to make.
      const plan = yield* runtimes.forkTarget(thread.id, undefined);
      const fork = yield* runtimes.fork(plan, {
        checkout: { kind: "worktree", path: "/work/fork" },
      });
      const forked = yield* runtimes.freshSession(fork.id).pipe(Effect.flip);
      expect(forked.message).toContain("fork");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});

/** The transcript's `session-restart` markers. */
/** A shell the agent left running after its turn. */
const SHELL = {
  taskId: "b1",
  kind: "shell",
  description: "Run the checks",
  command: "pnpm check",
  toolCallId: "t-bash",
  startedAt: 1_758_800_000_000,
} as const;

const restartMarkers = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return (yield* store.listMessages(threadId)).flatMap((m) =>
      m.parts.filter((p) => p.type === "data-session-restart"),
    );
  });

describe("restarting a thread's session", () => {
  it.effect(
    "reopens an idle session on the same conversation, after the host drops its cache",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        const { thread, session: first } = yield* answered;
        const before = (yield* store.listMessages(thread.id)).map((m) => m.id);

        expect(yield* runtimes.restartSession(thread.id)).toBe("restarting");
        const second = yield* waitFor(
          "the restarted session",
          Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]),
        );
        expect(first.closed).toBe(true);
        expect(second.options.resumeId).toBe(first.agentSessionId);
        expect(fake.configReloads).toEqual([`${thread.model.agent}:`]);
        yield* idle(thread.id);
        expect(yield* restartMarkers(thread.id)).toHaveLength(1);
        // The conversation is as it was, with the marker after it.
        const after = (yield* store.listMessages(thread.id)).map((m) => m.id);
        expect(after.slice(0, before.length)).toEqual(before);
        expect(after).toHaveLength(before.length + 1);

        // The divider is no place to resume from: forking the thread and editing the next message
        // both resume at the reply before it.
        const [, reply] = yield* store.listMessages(thread.id);
        const resumeAt = reply!.metadata?.agentMessageIds?.at(-1);
        expect((yield* runtimes.forkTarget(thread.id, undefined)).resumeAt).toBe(resumeAt);

        yield* runtimes.send(thread.id, { text: "carry on" });
        yield* waitFor(
          "the send to the new session",
          Effect.sync(() => second.sent.length === 1),
        );
        expect(first.sent).toHaveLength(1);
        yield* second.completeTurn("carried on");
        yield* idle(thread.id);
        const asked = (yield* store.listMessages(thread.id)).findLast((m) => m.role === "user")!;
        expect((yield* runtimes.rewindTarget(thread.id, asked.id)).resumeAt).toBe(resumeAt);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("waits for a running turn to end, or interrupts it when asked", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const { thread, session: first } = yield* answered;

      yield* runtimes.send(thread.id, { text: "a long one" });
      yield* waitFor(
        "the second send",
        Effect.sync(() => first.sent.length === 2),
      );
      expect(yield* runtimes.restartSession(thread.id)).toBe("afterTurn");
      expect(first.closed).toBe(false);
      yield* first.completeTurn("done");
      const second = yield* waitFor(
        "the restart after the turn",
        Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]),
      );
      expect(second.options.resumeId).toBe(first.agentSessionId);
      yield* idle(thread.id);
      expect((yield* store.listTurns(thread.id)).map((t) => t.reason)).toEqual([
        "completed",
        "completed",
      ]);

      yield* runtimes.send(thread.id, { text: "another long one" });
      yield* waitFor(
        "the third send",
        Effect.sync(() => second.sent.length === 1),
      );
      expect(yield* runtimes.restartSession(thread.id, "interrupt")).toBe("restarting");
      const third = yield* waitFor(
        "the restart that interrupted",
        Effect.sync(() => fake.sessions.length === 3 && fake.sessions[2]),
      );
      expect(second.interrupts).toBe(1);
      expect(third.options.resumeId).toBe(first.agentSessionId);
      yield* idle(thread.id);
      expect((yield* store.listTurns(thread.id)).at(-1)?.reason).toBe("interrupted");
      expect(yield* restartMarkers(thread.id)).toHaveLength(2);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("restarts after a turn that fails with no idle after it, as Codex ends one", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const { thread, session: first } = yield* answered;
      yield* runtimes.send(thread.id, { text: "deploy it" });
      yield* waitFor(
        "the second send",
        Effect.sync(() => first.sent.length === 2),
      );
      expect(yield* runtimes.restartSession(thread.id)).toBe("afterTurn");
      yield* first.emit({ type: "turnEnd", reason: "error", error: "no deployments" });
      const second = yield* waitFor(
        "the restart after the failed turn",
        Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]),
      );
      expect(first.closed).toBe(true);
      expect(second.options.resumeId).toBe(first.agentSessionId);
      yield* idle(thread.id);
      expect(yield* restartMarkers(thread.id)).toHaveLength(1);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("opens a cold thread's session, and has nothing to restart in a new one", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const { thread, session: first } = yield* answered;
      // Archiving an idle thread stops its session as an eviction does.
      yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: true }));
      yield* waitFor("cold", runtimes.status(thread.id).pipe(Effect.map((s) => s === "cold")));

      expect(yield* runtimes.restartSession(thread.id)).toBe("restarting");
      const second = yield* waitFor(
        "the opened session",
        Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]),
      );
      expect(second.options.resumeId).toBe(first.agentSessionId);
      yield* idle(thread.id);
      expect(yield* restartMarkers(thread.id)).toHaveLength(1);

      const draft = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "worktree", path: "/work/draft" },
      });
      yield* idle(draft.id);
      yield* runtimes.updateThread(draft.id, (t) => ({ ...t, parked: true }));
      yield* waitFor(
        "the draft cold",
        runtimes.status(draft.id).pipe(Effect.map((s) => s === "cold")),
      );
      expect(yield* runtimes.restartSession(draft.id)).toBe("noSession");
      expect(fake.sessions.filter((s) => s.options.threadId === draft.id)).toHaveLength(1);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("shows a restart that failed and loses nothing, and the retry restarts it", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const { thread, session: first } = yield* answered;
      const before = (yield* store.listMessages(thread.id)).map((m) => m.id);

      yield* fake.setUnavailable("claude: command not found");
      expect(yield* runtimes.restartSession(thread.id)).toBe("restarting");
      yield* waitFor(
        "the error",
        runtimes.status(thread.id).pipe(Effect.map((s) => s === "error")),
      );
      expect(first.closed).toBe(true);
      expect((yield* store.getThread(thread.id)).lastError).toBeDefined();
      expect((yield* store.listMessages(thread.id)).map((m) => m.id)).toEqual(before);

      yield* fake.setUnavailable(undefined);
      expect(yield* runtimes.restartSession(thread.id)).toBe("restarting");
      const retried = yield* waitFor(
        "the retried session",
        Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]),
      );
      expect(retried.options.resumeId).toBe(first.agentSessionId);
      yield* idle(thread.id);
      expect(yield* restartMarkers(thread.id)).toHaveLength(1);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("refuses a thread whose folder is gone, and one whose session is starting", () => {
    const removed = new Set<string>();
    return Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const gone = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "worktree", path: "/work/gone" },
        input: { text: "hello" },
      });
      yield* waitFor(
        "the first send",
        fake.latest(gone.id).pipe(Effect.map((s) => s.sent.length === 1)),
      );
      removed.add("/work/gone");
      const refused = yield* runtimes.restartSession(gone.id).pipe(Effect.flip);
      expect(refused).toMatchObject({ _tag: "InvalidState" });
      expect(refused.message).toContain("/work/gone");
      expect(fake.configReloads).toEqual([]);

      yield* fake.setOpenDelay("1 minute");
      const slow = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
      });
      const starting = yield* runtimes.restartSession(slow.id).pipe(Effect.flip);
      expect(starting.message).toContain("starting");
      expect(fake.configReloads).toEqual([]);
    }).pipe(
      Effect.provide(
        makeRuntimeTestLayer(
          undefined,
          Layer.effect(
            CheckoutService,
            Effect.gen(function* () {
              const base = yield* CheckoutService;
              return CheckoutService.of({
                ...base,
                present: (path) => Effect.succeed(!removed.has(path)),
              });
            }),
          ).pipe(Layer.provide(CheckoutService.layerNoGit)),
        ),
      ),
    );
  });
});

describe("starting a cold thread's session", () => {
  it.effect(
    "opens it on its conversation with no turn, once, and refuses what mustn't start",
    () => {
      const removed = new Set<string>();
      return Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        const { thread, session: first } = yield* answered;
        // Archiving stops the session as an eviction does; unarchiving leaves it cold.
        yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: true }));
        yield* waitFor("cold", runtimes.status(thread.id).pipe(Effect.map((s) => s === "cold")));
        const archived = yield* runtimes.startSession(thread.id).pipe(Effect.flip);
        expect(archived.message).toContain("archived");
        yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: false }));
        expect(yield* runtimes.status(thread.id)).toBe("cold");

        expect(yield* runtimes.startSession(thread.id)).toBe("starting");
        expect(yield* runtimes.startSession(thread.id)).toBe("open");
        const second = yield* waitFor(
          "the opened session",
          Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]),
        );
        expect(second.options.resumeId).toBe(first.agentSessionId);
        yield* idle(thread.id);
        expect(second.sent).toEqual([]);
        expect(yield* restartMarkers(thread.id)).toEqual([]);
        expect(fake.configReloads).toEqual([]);
        expect(yield* runtimes.startSession(thread.id)).toBe("open");
        expect(fake.sessions).toHaveLength(2);

        const dream = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/repo" },
          role: "dream",
          deferOpen: true,
        });
        expect((yield* runtimes.startSession(dream.id).pipe(Effect.flip)).message).toContain(
          "dream",
        );

        // What waits in a cold thread's queue would go out as the session opened.
        const waiting = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/repo" },
          deferOpen: true,
        });
        yield* store.putQueue(waiting.id, [{ id: "q1" as never, input: { text: "later" } }]);
        expect((yield* runtimes.startSession(waiting.id).pipe(Effect.flip)).message).toContain(
          "waits to be sent",
        );
        expect(yield* store.listQueue(waiting.id)).toHaveLength(1);

        const gone = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "worktree", path: "/work/gone" },
          deferOpen: true,
        });
        removed.add("/work/gone");
        expect((yield* runtimes.startSession(gone.id).pipe(Effect.flip)).message).toContain(
          "/work/gone",
        );
        expect(fake.sessions.filter((s) => s.options.threadId !== thread.id)).toEqual([]);
      }).pipe(
        Effect.provide(
          makeRuntimeTestLayer(
            undefined,
            Layer.effect(
              CheckoutService,
              Effect.gen(function* () {
                const base = yield* CheckoutService;
                return CheckoutService.of({
                  ...base,
                  present: (path) => Effect.succeed(!removed.has(path)),
                });
              }),
            ).pipe(Layer.provide(CheckoutService.layerNoGit)),
          ),
        ),
      );
    },
  );
});

/** The thread's summary's `pendingRestart`. */
const pending = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    return (yield* runtimes.snapshot).find((s) => s.thread.id === threadId)?.pendingRestart;
  });

describe("restarting sessions after an MCP change", () => {
  const ready: RestartReadiness = {
    status: "idle",
    hasSession: true,
    busyElsewhere: false,
    turnOpen: false,
    waiting: 0,
    backgroundTasks: 0,
    subagentsRunning: false,
    openRequests: 0,
  };

  it("goes only at rest, with nothing left to run or to send", () => {
    expect(restartReady(ready)).toBe(true);
    expect(restartReady({ ...ready, status: "error" })).toBe(true);
    for (const busy of [
      { status: "running" },
      { status: "needsApproval" },
      { status: "cold" },
      { hasSession: false },
      { busyElsewhere: true },
      { turnOpen: true },
      { waiting: 1 },
      { backgroundTasks: 1 },
      { subagentsRunning: true },
      { openRequests: 1 },
    ] as const) {
      expect(restartReady({ ...ready, ...busy })).toBe(false);
    }
  });

  it("reaches the agent's sessions, in the folder for a project's config", () => {
    const threadId = "t1" as ThreadId;
    const session = { threadId, agent: "codex", folder: "/work/repo" };
    expect(mcpChangeReaches({ agent: "codex" }, session)).toBe(true);
    expect(mcpChangeReaches({ agent: "claude" }, session)).toBe(false);
    expect(mcpChangeReaches({ agent: "codex", folder: "/work/repo/" }, session)).toBe(true);
    expect(mcpChangeReaches({ agent: "codex", folder: "/work/other" }, session)).toBe(false);
    expect(mcpChangeReaches({ agent: "codex", threads: [threadId] }, session)).toBe(true);
    expect(mcpChangeReaches({ agent: "codex", threads: [] }, session)).toBe(false);
    expect(mcpChangeReaches({ agent: "codex", except: [threadId] }, session)).toBe(false);
    expect(mcpChangeReaches({ agent: "codex", except: [] }, session)).toBe(true);
    expect(mcpChangeReaches({ agent: "claude" }, { ...session, agent: "grok" })).toBe(false);
  });

  it.effect("restarts an idle session at once, under a divider that says why", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const { thread, session: first } = yield* answered;

      expect(yield* runtimes.mcpConfigChanged({ agent: "claude" })).toEqual([thread.id]);
      const second = yield* waitFor(
        "the restarted session",
        Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]),
      );
      expect(first.closed).toBe(true);
      expect(second.options.resumeId).toBe(first.agentSessionId);
      expect(fake.configReloads).toEqual(["claude:"]);
      yield* idle(thread.id);
      expect((yield* restartMarkers(thread.id)).map((p) => p.data)).toEqual([
        { at: expect.any(Number), reason: "mcpConfig" },
      ]);
      expect(yield* pending(thread.id)).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("waits for the turn, the queue and the background tasks, in that order", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const { thread, session: first } = yield* answered;
      yield* runtimes.send(thread.id, { text: "a long one" });
      yield* waitFor(
        "the second send",
        Effect.sync(() => first.sent.length === 2),
      );
      yield* runtimes.send(thread.id, { text: "and then this" });

      expect(yield* runtimes.mcpConfigChanged({ agent: "claude" })).toEqual([thread.id]);
      expect(yield* pending(thread.id)).toBe("mcpConfig");
      expect(fake.configReloads).toEqual(["claude:"]);

      // The turn ends, and the queued message goes to the same session.
      yield* first.completeTurn("done");
      yield* waitFor(
        "the queued send",
        Effect.sync(() => first.sent.length === 3),
      );
      // That turn leaves a shell running, which a restart would kill.
      yield* first.emit(
        { type: "backgroundTasks", tasks: [SHELL] },
        { type: "turnEnd", reason: "completed" },
        { type: "status", status: "idle" },
      );
      yield* idle(thread.id);
      expect(first.closed).toBe(false);
      expect(yield* pending(thread.id)).toBe("mcpConfig");

      // Claude starts a turn to report on the shell just after it leaves the list.
      yield* first.emit({ type: "backgroundTasks", tasks: [] });
      yield* first.emit({ type: "status", status: "running" });
      yield* TestClock.adjust(BACKGROUND_SETTLE);
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      expect(first.closed).toBe(false);
      yield* first.emit(
        { type: "turnEnd", reason: "completed" },
        { type: "status", status: "idle" },
      );
      const second = yield* waitFor(
        "the restart once the report-back turn ended",
        Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]),
      );
      expect(first.closed).toBe(true);
      expect(second.options.resumeId).toBe(first.agentSessionId);
      yield* idle(thread.id);
      expect(yield* restartMarkers(thread.id)).toHaveLength(1);
      expect(yield* pending(thread.id)).toBeUndefined();
      expect(fake.configReloads).toEqual(["claude:"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("goes once background tasks end and the agent starts nothing for a while", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const { thread, session: first } = yield* answered;
      yield* first.emit({ type: "backgroundTasks", tasks: [SHELL] });
      yield* waitFor(
        "the shell",
        runtimes.snapshot.pipe(
          Effect.map((all) => all.some((s) => s.thread.id === thread.id && s.background)),
        ),
      );
      yield* runtimes.mcpConfigChanged({ agent: "claude" });
      yield* first.emit({ type: "backgroundTasks", tasks: [] });
      yield* TestClock.adjust("4 seconds");
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      expect(first.closed).toBe(false);
      yield* TestClock.adjust("1 second");
      yield* waitFor(
        "the restart",
        Effect.sync(() => fake.sessions.length === 2),
      );
      yield* idle(thread.id);
      expect(yield* restartMarkers(thread.id)).toHaveLength(1);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("leaves cold threads, other agents and other folders alone, and can be off", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const { thread } = yield* answered;
      const other = yield* runtimes.create({
        projectRoot: "/work/other",
        checkout: { kind: "main", path: "/work/other" },
        model: { agent: "codex", model: "default" },
        input: { text: "hello" },
      });
      const otherSession = yield* waitFor(
        "the other's send",
        fake.latest(other.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      yield* otherSession.completeTurn("hi");
      yield* idle(other.id);
      const cold = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "worktree", path: "/work/cold" },
      });
      yield* idle(cold.id);
      yield* runtimes.updateThread(cold.id, (t) => ({ ...t, parked: true }));
      yield* waitFor("cold", runtimes.status(cold.id).pipe(Effect.map((s) => s === "cold")));
      const opened = fake.sessions.length;

      expect(yield* runtimes.mcpConfigChanged({ agent: "claude", folder: "/work/other" })).toEqual(
        [],
      );
      expect(yield* runtimes.mcpConfigChanged({ agent: "claude", folder: "/work/repo" })).toEqual([
        thread.id,
      ]);
      yield* waitFor(
        "the one restart",
        Effect.sync(() => fake.sessions.length === opened + 1),
      );
      yield* idle(thread.id);
      // Reload Codex's config without restarting sessions that already received it.
      expect(
        yield* runtimes.mcpConfigChanged({
          agent: "codex",
          threads: [],
        }),
      ).toEqual([]);
      expect(fake.configReloads).toEqual(["claude:", "codex:*"]);

      yield* store.updateSettings((s) => ({
        ...s,
        agents: { ...s.agents, restartOnMcpChange: false },
      }));
      expect(yield* runtimes.mcpConfigChanged({ agent: "codex" })).toEqual([]);
      expect(fake.sessions).toHaveLength(opened + 1);
      expect(fake.configReloads).toEqual(["claude:", "codex:*"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("drops the mark of a session that ends before it is at rest", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const { thread, session: first } = yield* answered;
      yield* runtimes.send(thread.id, { text: "a long one" });
      yield* waitFor(
        "the second send",
        Effect.sync(() => first.sent.length === 2),
      );
      yield* runtimes.mcpConfigChanged({ agent: "claude" });
      expect(yield* pending(thread.id)).toBe("mcpConfig");
      yield* first.end({ type: "turnEnd", reason: "completed" });
      yield* waitFor(
        "the session gone",
        runtimes.status(thread.id).pipe(Effect.map((s) => s !== "running")),
      );
      expect(yield* pending(thread.id)).toBeUndefined();
      expect(fake.sessions).toHaveLength(1);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
