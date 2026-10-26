import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { makeMapper, type ClaudeMapper } from "@gram/agents/claude";
import {
  GitError,
  ThreadNotFound,
  WorktreeDirty,
  type Checkout,
  type AgentEvent,
  MessageId,
  type ProfileId,
  type ServerEvent,
  type ThreadFeedEvent,
  type ThreadId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "./fake-agent.ts";
import { CheckoutService, TurnHooks, type ReleaseCheckoutOptions } from "./hooks.ts";
import { makeRateLimitGate } from "./rate-limits.ts";
import {
  CheckoutsOnDisk,
  makeRuntimeTestLayer,
  RuntimeTestLayer,
  waitFor,
} from "./test-harness.ts";
import { MessageAccumulator } from "./message-accumulator.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

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
  return { thread, session };
});

/** One report of the 5-hour window, as an agent sends it on a request. */
const limitReading = (status: "allowed" | "warning", utilization: number): AgentEvent => ({
  type: "rateLimit",
  status,
  window: "five_hour",
  utilization,
  resetsAt: 1_790_000_000_000,
});

const released: Array<unknown> = [];

const dirtyRelease = (options: ReleaseCheckoutOptions) =>
  options.removeWorktree?.force === false
    ? Effect.fail(new WorktreeDirty({ path: "/work/repo/.worktrees/b", changedFiles: 1 }))
    : Effect.void;

/**
 * Refuses a non-forced removal as dirty, at the check or (`afterCheck`) only once the release runs,
 * and records every release in `released`.
 */
const dirtyCheckouts = (refuses: "atCheck" | "afterCheck") =>
  Layer.effect(
    CheckoutService,
    Effect.gen(function* () {
      const base = yield* CheckoutService;
      return CheckoutService.of({
        ...base,
        checkRelease: (_thread, options) =>
          refuses === "atCheck" ? dirtyRelease(options) : Effect.void,
        release: (_thread, options) =>
          Effect.suspend(() => {
            released.push(options);
            return dirtyRelease(options);
          }),
      });
    }),
  ).pipe(Layer.provide(CheckoutService.layerNoGit));

const collect = <A, E, R>(stream: Stream.Stream<A, E, R>, first: (a: A) => boolean) =>
  Effect.gen(function* () {
    const items: Array<A> = [];
    yield* Effect.forkScoped(
      Stream.runForEach(stream, (a) => Effect.sync(() => void items.push(a))),
    );
    yield* waitFor(
      "the subscription",
      Effect.sync(() => items.some(first)),
    );
    return items;
  });

const serverEvents = Effect.gen(function* () {
  const hub = yield* EventHub;
  return yield* collect(
    hub.serverEvents(Effect.succeed<ServerEvent>({ type: "threads.snapshot", threads: [] })),
    (e) => e.type === "threads.snapshot",
  );
});

const threadFeed = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const hub = yield* EventHub;
    const runtimes = yield* ThreadRuntimes;
    return yield* collect(
      hub.threadFeed(threadId, runtimes.replay(threadId)),
      (e: ThreadFeedEvent) => e.type === "caughtUp",
    );
  });

/** A `five_hour` warning, as the rate-limit gate takes it. */
const fiveHourWarning = (utilization: number, resetsAt?: number) =>
  ({
    status: "warning",
    window: "five_hour",
    utilization,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  }) as const;

describe("ThreadRuntimes agent events", () => {
  it.effect("follows a reported cwd into another checkout and back", () => {
    const moved: Checkout = {
      kind: "worktree",
      path: "/work/repo/.worktrees/feat",
      branch: "feat",
      repoRoot: "/work/repo",
    };
    const hooks = Layer.succeed(
      TurnHooks,
      TurnHooks.of({
        onTurnStart: () => Effect.void,
        onTurnEnd: () => Effect.void,
        onRemoteCommand: () => Effect.void,
        onFilesChanged: () => Effect.void,
        resolveCwd: (_thread, cwd, follow) =>
          Effect.sync(() => {
            asked.push(follow);
            return !follow ? undefined : cwd === moved.path ? moved : null;
          }),
      }),
    );
    const asked: Array<boolean> = [];
    return Effect.gen(function* () {
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      const events = yield* serverEvents;
      const { thread, session } = yield* createRunning;

      yield* session.emit({ type: "cwd", cwd: moved.path });
      yield* waitFor(
        "the thread to follow",
        store.getThread(thread.id).pipe(Effect.map((t) => t.currentCheckout !== undefined)),
      );
      expect((yield* store.getThread(thread.id)).currentCheckout).toEqual(moved);
      expect(
        events.some(
          (e) => e.type === "thread.upsert" && e.thread.currentCheckout?.path === moved.path,
        ),
      ).toBe(true);

      yield* session.emit({ type: "cwd", cwd: "/work/repo" });
      yield* waitFor(
        "the thread to return",
        store.getThread(thread.id).pipe(Effect.map((t) => t.currentCheckout === undefined)),
      );

      // The shared seam app tools use: its own checkout clears the move.
      expect((yield* runtimes.setCurrentCheckout(thread.id, moved)).currentCheckout).toEqual(moved);
      const back = yield* runtimes.setCurrentCheckout(thread.id, thread.checkout);
      expect(back.currentCheckout).toBeUndefined();
      expect(back.checkout).toEqual(thread.checkout);

      // Relocating the session (`move_to_worktree`) supersedes a followed worktree.
      yield* runtimes.setCurrentCheckout(thread.id, moved);
      const relocated: Checkout = {
        kind: "worktree",
        path: "/work/repo/.worktrees/other",
        repoRoot: "/work/repo",
      };
      const afterMove = yield* runtimes.moveCheckout(thread.id, relocated);
      expect(afterMove.checkout).toEqual(relocated);
      expect(afterMove.currentCheckout).toBeUndefined();

      // An orchestrator or a worker isn't moved by where its agent `cd`s to.
      const fake = yield* FakeAgentControl;
      for (const marks of [
        { role: "orchestrator" as const },
        { spawnedBy: { threadId: thread.id, feature: "feat" } },
      ]) {
        const pinned = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/repo" },
          ...marks,
          input: { text: "one" },
        });
        const pinnedSession = yield* waitFor(
          "its first send",
          fake.latest(pinned.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
        );
        const before = asked.length;
        yield* pinnedSession.emit({ type: "cwd", cwd: moved.path });
        yield* waitFor(
          "the move to be weighed",
          Effect.sync(() => asked.length > before),
        );
        expect(asked.at(-1)).toBe(false);
        expect((yield* store.getThread(pinned.id)).currentCheckout).toBeUndefined();
      }
    }).pipe(Effect.provide(makeRuntimeTestLayer(hooks)));
  });

  it.effect("calls turn hooks with the checkout and survives a failing hook", () => {
    const calls: Array<string> = [];
    const hooks = Layer.succeed(
      TurnHooks,
      TurnHooks.of({
        onTurnStart: (_threadId, _turnId, cwd) =>
          Effect.sync(() => void calls.push(`start ${cwd}`)).pipe(
            Effect.andThen(Effect.die("checkpoint failed")),
          ),
        onTurnEnd: (_threadId, _turnId, cwd, reason) =>
          Effect.sync(() => void calls.push(`end ${cwd} ${reason}`)),
        onRemoteCommand: () => Effect.void,
        onFilesChanged: (_threadId, cwd) => Effect.sync(() => void calls.push(`files ${cwd}`)),
        resolveCwd: () => Effect.succeed(undefined),
      }),
    );
    return Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      yield* session.emit({ type: "files", changes: [{ path: "a.ts", kind: "modify" }] });
      yield* session.completeTurn();
      yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
      expect(calls).toEqual(["start /work/repo", "files /work/repo", "end /work/repo completed"]);
    }).pipe(Effect.provide(makeRuntimeTestLayer(hooks)));
  });

  it.effect("replays a thread whose turn-start checkpoint is still running", () => {
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const hooks = Layer.succeed(
      TurnHooks,
      TurnHooks.of({
        onTurnStart: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        onTurnEnd: () => Effect.void,
        onRemoteCommand: () => Effect.void,
        onFilesChanged: () => Effect.void,
        resolveCwd: () => Effect.succeed(undefined),
      }),
    );
    return Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
      });
      yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
      const sent = yield* Effect.forkScoped(runtimes.send(thread.id, { text: "go" }));
      yield* Deferred.await(entered);

      // The send holds the runtime lock across the hook; the feed doesn't wait for it.
      const feed = yield* threadFeed(thread.id);
      const head = feed.find((e) => e.type === "messages");
      expect(head?.type === "messages" ? head.messages.map((m) => m.role) : []).toEqual(["user"]);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(sent);
    }).pipe(Effect.scoped, Effect.provide(makeRuntimeTestLayer(hooks)));
  });

  it.effect("tells the hooks when a turn ran a command GitHub reacts to", () => {
    const calls: Array<string> = [];
    const hooks = Layer.succeed(
      TurnHooks,
      TurnHooks.of({
        onTurnStart: () => Effect.void,
        onTurnEnd: (_threadId, _turnId, _cwd, _reason, touchedRemote) =>
          Effect.sync(() => void calls.push(`end touchedRemote=${touchedRemote}`)),
        onRemoteCommand: (_threadId, cwd) => Effect.sync(() => void calls.push(`remote ${cwd}`)),
        onFilesChanged: () => Effect.void,
        resolveCwd: () => Effect.succeed(undefined),
      }),
    );
    const messageId = "m-push" as MessageId;
    const tool = (toolCallId: string, command: string): ReadonlyArray<AgentEvent> =>
      [
        {
          type: "chunk",
          messageId,
          chunk: { type: "tool-input-available", toolCallId, toolName: "Bash", input: { command } },
        },
        {
          type: "chunk",
          messageId,
          chunk: { type: "tool-output-available", toolCallId, output: "" },
        },
      ] as ReadonlyArray<AgentEvent>;
    return Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      const idle = waitFor(
        "idle",
        runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")),
      );

      yield* session.emit(
        { type: "chunk", messageId, chunk: { type: "start", messageId } },
        ...tool("c1", "pnpm check"),
        ...tool("c2", "git push -u origin feat/x"),
      );
      yield* session.completeTurn();
      yield* idle;
      // As the push finished, not at the end of the turn; and only the push.
      expect(calls).toEqual(["remote /work/repo", "end touchedRemote=true"]);
    }).pipe(Effect.provide(makeRuntimeTestLayer(hooks)));
  });

  it.effect("keeps requested speed separate from a provider fallback report", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const { thread, session } = yield* createRunning;
      yield* store.updateThread(thread.id, (t) => ({
        ...t,
        model: { ...t.model, speed: "fast", variant: "high" },
      }));
      yield* session.emit({
        type: "speed",
        state: { speed: "standard", detail: "Synthetic cooldown" },
      });
      const updated = yield* waitFor(
        "the fallback report",
        store
          .getThread(thread.id)
          .pipe(Effect.map((t) => t.speedState?.detail === "Synthetic cooldown" && t)),
      );
      expect(updated.model).toMatchObject({ speed: "fast", variant: "high" });
      expect(updated.speedState).toEqual({ speed: "standard", detail: "Synthetic cooldown" });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("rejects unadvertised Fast before mutating the saved selection", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      const saved = (yield* store.getThread(thread.id)).model;
      const failure = yield* runtimes
        .setModel(thread.id, { ...saved, speed: "fast" })
        .pipe(Effect.flip);
      expect(failure.message).toContain("not advertised");
      expect((yield* store.getThread(thread.id)).model).toEqual(saved);
      expect(session.models).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("disables an unsupported Fast preference after a CLI-side model switch", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const { thread, session } = yield* createRunning;
      yield* store.updateThread(thread.id, (t) => ({
        ...t,
        model: { ...t.model, speed: "fast" },
      }));
      yield* session.emit({ type: "model", model: "fake-haiku" });
      yield* waitFor(
        "the Standard control update",
        Effect.sync(() => session.models.some((m) => m.speed === "standard")),
      );
      expect((yield* store.getThread(thread.id)).model).toEqual({
        ...thread.model,
        model: "fake-haiku",
        speed: "standard",
      });
      expect(session.models).toEqual([{ ...thread.model, model: "fake-haiku", speed: "standard" }]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("follows a model the user switched to inside the session", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      const events = yield* serverEvents;
      const { thread, session } = yield* createRunning;
      yield* store.updateSettings((settings) => ({
        ...settings,
        agents: {
          ...settings.agents,
          customModels: [{ agent: thread.model.agent, id: "claude-preview[1m]" }],
        },
      }));
      yield* runtimes.setModel(thread.id, { ...thread.model, variant: "high" });
      const sets = session.models.length;
      const follow = (model: string) =>
        Effect.gen(function* () {
          yield* session.emit({ type: "model", model });
          yield* waitFor(
            `the thread on ${model}`,
            store.getThread(thread.id).pipe(Effect.map((t) => t.model.model === model)),
          );
          return (yield* store.getThread(thread.id)).model;
        });

      expect(yield* follow("claude-preview[1m]")).toEqual({
        ...thread.model,
        model: "claude-preview[1m]",
        variant: "high",
      });
      expect(
        events.some(
          (e) => e.type === "thread.upsert" && e.thread.model.model === "claude-preview[1m]",
        ),
      ).toBe(true);

      // `fake-haiku` takes no effort, so the one saved for the last model goes.
      expect(yield* follow("fake-haiku")).toEqual({ ...thread.model, model: "fake-haiku" });

      yield* runtimes.setModel(thread.id, { ...thread.model, variant: "high" });
      expect(yield* follow("typed-by-hand")).toEqual({ ...thread.model, model: "typed-by-hand" });
      expect(session.models.length).toBe(sets + 1);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("reopens instead of switching live on a model the session can't run as started", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const { thread, session } = yield* createRunning;
      yield* session.completeTurn();
      yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));

      yield* runtimes.setModel(thread.id, { ...thread.model, model: "reopen:eu" });
      const reopened = yield* waitFor(
        "a session opened on the new model",
        fake.latest(thread.id).pipe(Effect.map((s) => s !== session && s)),
      );
      expect(session.models).toEqual([]);
      yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));

      // A `/model` inside the session reopens too, once the record has moved.
      yield* reopened.emit({ type: "model", model: "reopen:us" });
      yield* waitFor(
        "another session",
        fake.latest(thread.id).pipe(Effect.map((s) => s !== reopened && s)),
      );
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("applies a model switch made while the session was still opening", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      yield* fake.setOpenDelay("300 millis");
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "one" },
      });
      // Recorded only: there is no session to tell yet.
      yield* runtimes.setModel(thread.id, { ...thread.model, model: "reopen:eu" });
      yield* fake.setOpenDelay(undefined);
      // Lets the open finish: `latest` dies while there is no session yet.
      yield* TestClock.adjust("400 millis");
      const reopened = yield* waitFor(
        "the session reopened on the switched model",
        fake.latest(thread.id).pipe(Effect.map((s) => s.options.model?.model === "reopen:eu" && s)),
      );
      // The queued message waited for the session that runs the thread's recorded model, rather
      // than draining into the one opened on the old model.
      yield* waitFor(
        "the first send",
        Effect.sync(() => reopened.sent.length === 1),
      );
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("reopens a session that was still opening when a reload was asked for", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      yield* fake.setOpenDelay("300 millis");
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
      });
      // The open read the thread's policy already, so it reopens rather than answer `noSession`.
      expect(yield* runtimes.reloadSession(thread.id)).toBe("reopening");
      yield* fake.setOpenDelay(undefined);
      yield* TestClock.adjust("400 millis");
      yield* waitFor(
        "a second session",
        Effect.sync(
          () =>
            fake.sessions.filter((session) => session.options.threadId === thread.id).length === 2,
        ),
      );
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("applies mode changes, publishes notices, and records plans as a data part", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const events = yield* serverEvents;
      const { thread, session } = yield* createRunning;
      const feed = yield* threadFeed(thread.id);

      yield* session.emit(
        { type: "mode", mode: "plan" },
        { type: "notice", level: "warning", message: "claude 2.1.270 is older than the SDK" },
        {
          type: "notice",
          level: "warning",
          message: "Synthetic startup diagnostic",
          startupDiagnostic: { key: "a".repeat(64), source: "Codex configuration" },
        },
        {
          type: "notice",
          level: "error",
          message: "Synthetic important error",
          startupDiagnostic: { key: "a".repeat(64), source: "Codex configuration" },
        },
        { type: "plan", items: [{ content: "write tests", status: "inProgress" }] },
      );
      yield* waitFor(
        "the plan message",
        Effect.sync(() =>
          feed.some((e) => e.type === "message" && e.message.id.startsWith("app-")),
        ),
      );

      expect((yield* store.getThread(thread.id)).mode).toBe("plan");
      expect(events).toContainEqual({
        type: "notify",
        kind: "info",
        title: "claude 2.1.270 is older than the SDK",
        threadId: thread.id,
      });
      expect(events).toContainEqual({
        type: "notify",
        kind: "info",
        title: "Synthetic startup diagnostic",
        threadId: thread.id,
        startupDiagnostic: { key: "a".repeat(64), source: "Codex configuration" },
      });
      expect(events).toContainEqual({
        type: "notify",
        kind: "error",
        title: "Synthetic important error",
        threadId: thread.id,
      });
      const planMessage = (yield* store.listMessages(thread.id)).find((m) =>
        m.id.startsWith("app-"),
      );
      expect(planMessage?.parts).toEqual([
        {
          type: "data-plan",
          id: "plan",
          data: { items: [{ content: "write tests", status: "inProgress" }] },
        },
      ]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps a session's lapsed connectors on the summary until it ends", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const events = yield* serverEvents;
      const { thread, session } = yield* createRunning;
      const lapsed = () =>
        events.flatMap((e) => (e.type === "thread.lapsedConnectors" ? [e.names] : []));
      const summary = runtimes.snapshot.pipe(
        Effect.map((all) => all.find((s) => s.thread.id === thread.id)),
      );

      yield* session.emit({ type: "connectorsLapsed", names: ["claude.ai Atlassian"] });
      yield* waitFor(
        "the lapsed connector",
        Effect.sync(() => lapsed().length === 1),
      );
      expect((yield* summary)?.lapsedConnectors).toEqual(["claude.ai Atlassian"]);

      yield* session.end({ type: "ended", reason: "exited" });
      yield* waitFor(
        "the cleared list",
        Effect.sync(() => lapsed().length === 2),
      );
      expect(lapsed()[1]).toEqual([]);
      expect((yield* summary)?.lapsedConnectors).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("shows a rate limit once per window and level, across threads", () =>
    Effect.gen(function* () {
      const events = yield* serverEvents;
      const a = yield* createRunning;
      const b = yield* createRunning;
      const resets = 1_790_000_000_000;
      const warning = (window: string, utilization: number, resetsAt = resets): AgentEvent => ({
        type: "rateLimit",
        status: "warning",
        window,
        utilization,
        resetsAt,
      });
      const rejected: AgentEvent = { type: "rateLimit", status: "rejected", window: "five_hour" };
      let marks = 0;
      /** Emits `limits` on `session`, then waits until the runtime has handled them. */
      const step = (session: typeof a.session, ...limits: ReadonlyArray<AgentEvent>) =>
        Effect.gen(function* () {
          const mark = `mark ${++marks}`;
          yield* session.emit(...limits, { type: "notice", level: "info", message: mark });
          yield* waitFor(
            mark,
            Effect.sync(() => events.some((e) => e.type === "notify" && e.title === mark)),
          );
        });

      yield* step(a.session, warning("five_hour", 0.5), warning("five_hour", 0.6));
      yield* step(b.session, warning("five_hour", 0.7));
      yield* step(a.session, warning("five_hour", 0.82));
      yield* step(b.session, warning("five_hour", 0.9), warning("five_hour", 0.96));
      yield* step(a.session, warning("five_hour", 0.97), warning("overage", 0.97));
      yield* step(b.session, warning("five_hour", 0.3, resets + 18_000_000));
      yield* step(a.session, rejected, rejected);
      yield* step(b.session, rejected);

      expect(
        events.flatMap((e) =>
          e.type === "rateLimit"
            ? [`${e.threadId === a.thread.id ? "a" : "b"} ${e.status} ${e.window} ${e.utilization}`]
            : [],
        ),
      ).toEqual([
        "a warning five_hour 0.5",
        "a warning five_hour 0.82",
        "b warning five_hour 0.96",
        "a warning overage 0.97",
        "a rejected five_hour undefined",
      ]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it("forgets a rate-limit window at its reset or after six hours without a report", () => {
    const gate = makeRateLimitGate();
    const shown = (limit: Parameters<typeof gate>[1], at: number) => gate("claude/", limit, at);
    const now = 1_790_000_000_000;
    const hour = 60 * 60 * 1000;
    const rejected = { status: "rejected", window: "five_hour" } as const;

    // A reset learnt late, or one already past, is the same window.
    expect([
      shown(fiveHourWarning(0.5), now),
      shown(fiveHourWarning(0.6, now + 2 * hour), now + 1),
      shown(fiveHourWarning(0.7, now - hour), now + 2),
      shown(fiveHourWarning(0.8, now + 2 * hour), now + 3),
      shown(rejected, now + 4),
      shown(rejected, now + 5),
    ]).toEqual([true, false, false, true, true, false]);
    // Its known reset passes.
    expect(shown(fiveHourWarning(0.5), now + 2 * hour)).toBe(true);
    // Reports with no reset, or a stale one, until six hours pass without one.
    expect([
      shown(fiveHourWarning(0.5), now + 8 * hour),
      shown(fiveHourWarning(0.5, now), now + 12 * hour),
      shown(fiveHourWarning(0.5), now + 19 * hour),
    ]).toEqual([true, false, true]);
    // Hourly reports with no reset show again six hours after the first was shown.
    const hourly = [30, 31, 32, 33, 34, 35, 36].map((h) =>
      shown(fiveHourWarning(0.5), now + h * hour),
    );
    expect(hourly).toEqual([true, false, false, false, false, false, true]);
    // A gateway profile's window is its own quota.
    expect(gate("claude/gw", rejected, now + 37 * hour)).toBe(true);
    expect(shown(rejected, now + 37 * hour)).toBe(true);
  });

  it.effect("sends every limit reading to the meter, and only gated warnings as notices", () =>
    Effect.gen(function* () {
      const events = yield* serverEvents;
      const { thread, session } = yield* createRunning;
      yield* session.emit(
        limitReading("allowed", 0.4),
        limitReading("warning", 0.82),
        limitReading("warning", 0.84),
        { type: "notice", level: "info", message: "read" },
      );
      yield* waitFor(
        "the readings",
        Effect.sync(() => events.some((e) => e.type === "notify" && e.title === "read")),
      );

      expect(
        events.flatMap((e) =>
          e.type === "usageLimit"
            ? [`${e.threadId === thread.id} ${e.agent} ${e.gateway} ${e.status} ${e.utilization}`]
            : [],
        ),
      ).toEqual([
        `true ${thread.model.agent} undefined allowed 0.4`,
        `true ${thread.model.agent} undefined warning 0.82`,
        `true ${thread.model.agent} undefined warning 0.84`,
      ]);
      // A plain reading never notifies; the second warning at the same level is held back.
      expect(
        events.flatMap((e) => (e.type === "rateLimit" ? [`${e.status} ${e.utilization}`] : [])),
      ).toEqual(["warning 0.82"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("counts a session's rate limits against the profile it opened with", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const events = yield* serverEvents;
      const a = yield* createRunning;
      const b = yield* createRunning;
      const limit: AgentEvent = { type: "rateLimit", status: "rejected", window: "five_hour" };
      yield* runtimes.setModel(b.thread.id, { ...b.thread.model, profileId: "gw" as ProfileId });

      yield* a.session.emit(limit);
      yield* b.session.emit(limit, { type: "notice", level: "info", message: "b done" });
      yield* waitFor(
        "b's reports",
        Effect.sync(() => events.some((e) => e.type === "notify" && e.title === "b done")),
      );

      // b's session still runs on the subscription, so its rejection is the one already shown.
      expect(events.filter((e) => e.type === "rateLimit")).toHaveLength(1);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("shows one notice when Claude reports allowed between warnings", () =>
    Effect.gen(function* () {
      const events = yield* serverEvents;
      const { session } = yield* createRunning;
      let n = 0;
      const mapper = makeMapper({ newMessageId: () => MessageId.make(`m${++n}`) });
      const report = (status: string, utilization: number) =>
        mapper.map({
          type: "rate_limit_event",
          rate_limit_info: {
            status,
            rateLimitType: "overage",
            utilization,
            resetsAt: 1_790_000_000,
          },
          uuid: `u${++n}`,
          session_id: "s",
        } as unknown as Parameters<ClaudeMapper["map"]>[0]);

      const statuses = ["allowed", "allowed_warning", "allowed", "allowed_warning"];
      for (const [i, status] of statuses.entries()) {
        yield* session.emit(...report(status, 0.9), {
          type: "notice",
          level: "info",
          message: `mark ${i}`,
        });
        yield* waitFor(
          `mark ${i}`,
          Effect.sync(() => events.some((e) => e.type === "notify" && e.title === `mark ${i}`)),
        );
        yield* TestClock.adjust("2 minutes");
      }

      expect(events.filter((e) => e.type === "rateLimit")).toMatchObject([
        { status: "warning", window: "overage", utilization: 0.9 },
      ]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("reports usage mid-turn on the hub alone, never as a chunk of the reply", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const events = yield* serverEvents;
      const { thread, session } = yield* createRunning;
      const messageId = "reply" as MessageId;
      yield* session.emit(
        { type: "chunk", messageId, chunk: { type: "text-start", id: "t" } },
        { type: "usage", tokens: { inputTokens: 10, outputTokens: 2 }, costUsd: 0.01 },
        { type: "usage", tokens: { inputTokens: 40, outputTokens: 9 }, costUsd: 0.05 },
      );
      yield* waitFor(
        "both usage reports",
        Effect.sync(
          () => events.filter((e) => e.type === "thread.usage" && e.threadId === thread.id).length,
        ).pipe(Effect.map((n) => n === 2)),
      );

      const replay = yield* runtimes.replay(thread.id);
      expect(replay.inFlight).toHaveLength(1);
      expect(
        events.flatMap((e) =>
          e.type === "thread.usage" && e.threadId === thread.id ? [e.usage.tokens] : [],
        ),
      ).toEqual([
        { inputTokens: 10, outputTokens: 2 },
        { inputTokens: 40, outputTokens: 9 },
      ]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("replays a streaming part's deltas as one, whatever the run's length", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, session } = yield* createRunning;
      const messageId = "reply" as MessageId;
      const words = Array.from({ length: 200 }, (_, i) => `w${i} `);
      yield* session.emit(
        { type: "chunk", messageId, chunk: { type: "start", messageId } },
        { type: "chunk", messageId, chunk: { type: "text-start", id: "t" } },
        ...words.map((delta) => ({
          type: "chunk" as const,
          messageId,
          chunk: { type: "text-delta" as const, id: "t", delta },
        })),
        { type: "chunk", messageId, chunk: { type: "reasoning-start", id: "r" } },
        { type: "chunk", messageId, chunk: { type: "reasoning-delta", id: "r", delta: "hm" } },
        { type: "chunk", messageId, chunk: { type: "reasoning-delta", id: "r", delta: "m" } },
        { type: "chunk", messageId, chunk: { type: "text-delta", id: "t", delta: "end" } },
      );
      const replay = yield* waitFor(
        "the whole run in the replay",
        runtimes.replay(thread.id).pipe(
          Effect.map((r) => {
            const last = r.inFlight.at(-1)?.event;
            return (
              last?.type === "chunk" &&
              last.chunk.type === "text-delta" &&
              last.chunk.delta === "end" &&
              r
            );
          }),
        ),
      );
      // start, text-start, the 200 deltas as one, reasoning-start, its two as one, and the delta
      // after it, which follows another part and so stays its own.
      const chunks = replay.inFlight.flatMap(({ event }) =>
        event.type === "chunk" ? [event.chunk] : [],
      );
      expect(chunks.map((chunk) => chunk.type)).toEqual([
        "start",
        "text-start",
        "text-delta",
        "reasoning-start",
        "reasoning-delta",
        "text-delta",
      ]);
      const folded = new MessageAccumulator(messageId);
      for (const chunk of chunks) folded.apply(chunk);
      const parts = folded
        .snapshot()
        .parts.flatMap((part) =>
          part.type === "text" || part.type === "reasoning" ? [part.text] : [],
        );
      expect(parts).toEqual([`${words.join("")}end`, "hmm"]);
      // Still in the order they were published, with the seq of the newest delta each holds.
      const seqs = replay.inFlight.map((item) => item.seq);
      expect(seqs).toEqual(seqs.toSorted((a, b) => a - b));
      expect(replay.lastSeq).toBe(seqs.at(-1));
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("doesn't publish a usage reading that reads the same as the last", () =>
    Effect.gen(function* () {
      const events = yield* serverEvents;
      const { thread, session } = yield* createRunning;
      const reading = { type: "usage", tokens: { inputTokens: 10, outputTokens: 2 } } as const;
      yield* session.emit(
        reading,
        reading,
        { ...reading, contextTokens: 12 },
        { ...reading, contextTokens: 12 },
        { type: "notice", level: "info", message: "after the readings" },
      );
      yield* waitFor(
        "the readings",
        Effect.sync(() =>
          events.some((e) => e.type === "notify" && e.title === "after the readings"),
        ),
      );
      expect(
        events.flatMap((e) =>
          e.type === "thread.usage" && e.threadId === thread.id ? [e.usage.contextTokens] : [],
        ),
      ).toEqual([undefined, 12]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("publishes user messages and finished-message upserts on the thread feed", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
      });
      yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
      const feed = yield* threadFeed(thread.id);

      yield* runtimes.send(thread.id, { text: "hello" });
      yield* TestClock.adjust("1 minute");
      const offeredAt = yield* Clock.currentTimeMillis;
      const chipId = yield* runtimes.emitChunk(thread.id, {
        type: "data-task-chip",
        id: "k",
        data: { id: "k", title: "docs", prompt: "update docs", status: "offered" },
      } as never);
      yield* TestClock.adjust("1 minute");
      yield* runtimes.updateDataPart(thread.id, chipId, {
        type: "data-task-chip",
        id: "k",
        data: { id: "k", title: "docs", prompt: "update docs", status: "dismissed" },
      } as never);

      // The user message, then the standalone chip message when offered and again when dismissed.
      const upserts = feed.flatMap((e) => (e.type === "message" ? [e.message] : []));
      expect(upserts.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
      expect(upserts[2]?.id).toBe(chipId);
      expect(upserts[2]?.parts).toMatchObject([
        { type: "data-task-chip", data: { status: "dismissed" } },
      ]);
      // Dated when it was offered, and the dismissal doesn't move that.
      expect(upserts[1]?.metadata?.createdAt).toBe(offeredAt);
      expect(upserts[2]?.metadata?.createdAt).toBe(offeredAt);
      const stored = yield* store.getMessage(thread.id, chipId);
      expect(stored?.parts).toMatchObject([
        { type: "data-task-chip", data: { status: "dismissed" } },
      ]);
      expect(stored?.metadata?.createdAt).toBe(offeredAt);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "dates a reply when it starts streaming, for live subscribers and the store alike",
    () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const { thread, session } = yield* createRunning;
        const feed = yield* threadFeed(thread.id);
        const messageId = "reply" as MessageId;
        yield* TestClock.adjust("1 minute");
        const startedAt = yield* Clock.currentTimeMillis;
        yield* session.emit({
          type: "chunk",
          messageId,
          chunk: { type: "start", messageId, messageMetadata: { agentMessageIds: ["a"] } },
        });
        // A later chunk, or the agent's own metadata, leaves the reply's time where it began.
        yield* TestClock.adjust("1 minute");
        yield* session.emit(
          {
            type: "chunk",
            messageId,
            chunk: { type: "message-metadata", messageMetadata: { model: "opus" } },
          },
          { type: "chunk", messageId, chunk: { type: "finish" } },
        );
        const stored = yield* waitFor(
          "the finished reply",
          store
            .getMessage(thread.id, messageId)
            .pipe(Effect.map((m) => (m?.metadata?.model === undefined ? undefined : m))),
        );
        expect(stored.metadata).toMatchObject({ createdAt: startedAt, agentMessageIds: ["a"] });
        const start = feed.find((e) => e.type === "chunk" && e.chunk.type === "start");
        expect(start).toMatchObject({
          chunk: { messageMetadata: { createdAt: startedAt, agentMessageIds: ["a"] } },
        });
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("stops an agent whose folder was deleted mid-turn, at its next tool call", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const events = yield* serverEvents;
      const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "gram-gone-"));
      const thread = yield* runtimes.create({
        projectRoot: dir,
        checkout: { kind: "main", path: dir },
        input: { text: "one" },
      });
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      const messageId = "m-gone" as MessageId;
      yield* session.emit({ type: "chunk", messageId, chunk: { type: "start", messageId } });
      yield* waitFor(
        "running",
        runtimes.status(thread.id).pipe(Effect.map((s) => s === "running")),
      );

      fs.rmSync(dir, { recursive: true, force: true });
      yield* session.emit({
        type: "chunk",
        messageId,
        chunk: { type: "tool-input-available", toolCallId: "c1", toolName: "Bash", input: {} },
      });
      yield* waitFor(
        "the session stopped",
        runtimes.status(thread.id).pipe(Effect.map((s) => s === "cold" && session.closed)),
      );
      const message = `This thread's folder no longer exists: ${dir}`;
      expect(events).toContainEqual({
        type: "notify",
        kind: "error",
        title: `The agent was stopped. ${message}`,
        threadId: thread.id,
      });
      // Nothing reopens in it: the next send is refused with the folder to restore.
      const refused = yield* runtimes.send(thread.id, { text: "two" }).pipe(Effect.flip);
      expect(refused).toMatchObject({ message, folderMissing: { path: dir } });
      expect((yield* fake.latest(thread.id)) === session).toBe(true);
    }).pipe(Effect.provide(makeRuntimeTestLayer(TurnHooks.layerNoop, CheckoutsOnDisk))),
  );

  it.effect("stops a session whose old folder goes after a move, though the new one is there", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const from = fs.mkdtempSync(nodePath.join(os.tmpdir(), "gram-from-"));
      const to = fs.mkdtempSync(nodePath.join(os.tmpdir(), "gram-to-"));
      const thread = yield* runtimes.create({
        projectRoot: from,
        checkout: { kind: "main", path: from },
        input: { text: "one" },
      });
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      const messageId = "m-moved" as MessageId;
      yield* session.emit({ type: "chunk", messageId, chunk: { type: "start", messageId } });
      // Recorded at once; the session runs on in `from` until its turn ends.
      yield* runtimes.moveCheckout(thread.id, { kind: "worktree", path: to });
      fs.rmSync(from, { recursive: true, force: true });
      yield* session.emit({
        type: "chunk",
        messageId,
        chunk: { type: "tool-input-available", toolCallId: "c1", toolName: "Bash", input: {} },
      });
      yield* waitFor(
        "the session stopped",
        runtimes.status(thread.id).pipe(Effect.map((s) => s === "cold" && session.closed)),
      );
      fs.rmSync(to, { recursive: true, force: true });
    }).pipe(Effect.provide(makeRuntimeTestLayer(TurnHooks.layerNoop, CheckoutsOnDisk))),
  );

  it.effect("keeps the thread and its session when the checkout can't be released", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread, session } = yield* createRunning;

      const error = yield* runtimes
        .close(thread.id, { removeWorktree: { force: false } })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(GitError);
      expect(session.closed).toBe(false);
      expect((yield* store.getThread(thread.id)).id).toBe(thread.id);

      yield* runtimes.close(thread.id);
      expect(session.closed).toBe(true);
      const missing = yield* store.getThread(thread.id).pipe(Effect.flip);
      expect(missing).toBeInstanceOf(ThreadNotFound);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("refuses to close a dirty worktree before stopping, and Delete anyway closes", () =>
    Effect.gen(function* () {
      released.length = 0;
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const { thread, session } = yield* createRunning;

      const error = yield* runtimes
        .close(thread.id, { removeWorktree: { force: false } })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(WorktreeDirty);
      expect(released).toEqual([]);
      expect(session.closed).toBe(false);
      expect(yield* runtimes.status(thread.id)).toBe("running");

      yield* runtimes.close(thread.id, { removeWorktree: { force: true } });
      expect(released).toEqual([{ removeWorktree: { force: true } }]);
      expect(session.closed).toBe(true);
      const missing = yield* store.getThread(thread.id).pipe(Effect.flip);
      expect(missing).toBeInstanceOf(ThreadNotFound);
    }).pipe(Effect.provide(makeRuntimeTestLayer(TurnHooks.layerNoop, dirtyCheckouts("atCheck")))),
  );

  it.effect("leaves a thread cold, not ended, when its release is refused after the check", () =>
    Effect.gen(function* () {
      released.length = 0;
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "gram-close-"));
      const thread = yield* runtimes.create({
        projectRoot: dir,
        checkout: { kind: "main", path: dir },
        input: { text: "one" },
      });
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );

      const error = yield* runtimes
        .close(thread.id, { removeWorktree: { force: false } })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(WorktreeDirty);
      expect(released).toHaveLength(1);
      expect(yield* runtimes.status(thread.id)).toBe("cold");

      yield* runtimes.send(thread.id, { text: "two" });
      const reopened = yield* waitFor(
        "a new session",
        fake.latest(thread.id).pipe(Effect.map((s) => s !== session && s.sent.length === 1 && s)),
      );
      expect(reopened.sent[0]).toMatchObject({ text: "two" });

      // With its own checkout gone it isn't left closing for good: it stays cold, and the next
      // close goes through.
      fs.rmSync(dir, { recursive: true, force: true });
      yield* runtimes.close(thread.id, { removeWorktree: { force: false } }).pipe(Effect.flip);
      expect(yield* runtimes.status(thread.id)).toBe("cold");
      yield* runtimes.close(thread.id);
      expect(yield* store.getThread(thread.id).pipe(Effect.flip)).toBeInstanceOf(ThreadNotFound);
    }).pipe(
      Effect.provide(makeRuntimeTestLayer(TurnHooks.layerNoop, dirtyCheckouts("afterCheck"))),
    ),
  );

  it.effect("recovers a hung interrupt on a thread whose close failed after the check", () =>
    Effect.gen(function* () {
      released.length = 0;
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "gram-close-"));
      const thread = yield* runtimes.create({
        projectRoot: dir,
        checkout: { kind: "main", path: dir },
        input: { text: "one" },
      });
      yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1)),
      );
      yield* runtimes.close(thread.id, { removeWorktree: { force: false } }).pipe(Effect.flip);
      expect(yield* runtimes.status(thread.id)).toBe("cold");

      yield* fake.setInterruptBehavior("hang");
      yield* runtimes.send(thread.id, { text: "two" });
      const reopened = yield* waitFor(
        "a new session",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      yield* waitFor(
        "status running",
        runtimes.status(thread.id).pipe(Effect.map((s) => s === "running")),
      );
      const interrupting = yield* Effect.forkScoped(runtimes.interrupt(thread.id));
      yield* waitFor(
        "the interrupt call",
        Effect.sync(() => reopened.interrupts === 1),
      );
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(interrupting);
      const resumed = yield* waitFor(
        "the resumed session",
        fake.latest(thread.id).pipe(Effect.map((s) => s !== reopened && s)),
      );
      yield* waitFor(
        "status idle",
        runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")),
      );
      yield* runtimes.send(thread.id, { text: "three" });
      yield* waitFor(
        "the send after recovery",
        Effect.sync(() => resumed.sent.length === 1),
      );
      fs.rmSync(dir, { recursive: true, force: true });
    }).pipe(
      Effect.provide(makeRuntimeTestLayer(TurnHooks.layerNoop, dirtyCheckouts("afterCheck"))),
    ),
  );
});
