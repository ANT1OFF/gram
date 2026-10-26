import { describe, expect, it } from "@effect/vitest";
import {
  RequestNotFound,
  type RequestId,
  type ServerEvent,
  type ThreadId,
  type TurnId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl, makeFakeAgentAdapter } from "./fake-agent.ts";
import { CheckoutService, TurnHooks } from "./hooks.ts";
import { RuntimeTestLayer, TEST_CONFIG, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

const echoLayerAt = (file: string) =>
  AppToolRegistry.layer.pipe(
    Layer.provideMerge(ThreadRuntimes.layer),
    Layer.provideMerge(EventHub.layer),
    Layer.provideMerge(ThreadStore.layerSqlite(file)),
    Layer.provideMerge(makeFakeAgentAdapter({ reply: "echo" })),
    Layer.provideMerge(TurnHooks.layerNoop),
    Layer.provideMerge(CheckoutService.layerNoGit),
    Layer.provideMerge(ServerConfig.layer(TEST_CONFIG)),
    Layer.orDie,
  );

const recordEvents = Effect.gen(function* () {
  const hub = yield* EventHub;
  const events: Array<ServerEvent> = [];
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
  return events;
});

const waitStatus = (threadId: ThreadId, status: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    yield* waitFor(
      `status ${status}`,
      runtimes.status(threadId).pipe(Effect.map((s) => s === status)),
    );
  });

describe("pending requests when a turn ends", () => {
  it.effect("Stop during /approve clears the request, tells clients, and stays cleared", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-requests-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      const file = join(dir, "gram.db");

      const threadId = yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const events = yield* recordEvents;
        const thread = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/repo" },
          input: { text: "run it /approve" },
        });
        yield* waitStatus(thread.id, "needsApproval");
        const [request] = yield* store.listRequests(thread.id);
        expect(request).toBeDefined();

        yield* runtimes.interrupt(thread.id);
        yield* waitStatus(thread.id, "idle");

        expect(yield* store.listRequests(thread.id)).toEqual([]);
        const [summary] = yield* runtimes.snapshot;
        expect(summary?.pendingRequests).toEqual([]);
        expect(events).toContainEqual({
          type: "thread.requestResolved",
          threadId: thread.id,
          requestId: request!.id,
        });

        // A late answer finds nothing to resume, so the interrupted turn stays over.
        const late = yield* runtimes
          .respond(thread.id, request!.id, { kind: "approval", decision: "allow", scope: "once" })
          .pipe(Effect.flip);
        expect(late).toBeInstanceOf(RequestNotFound);
        return thread.id;
      }).pipe(Effect.provide(echoLayerAt(file)));

      yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;
        expect(yield* store.listRequests(threadId)).toEqual([]);
        const [summary] = yield* runtimes.snapshot;
        expect(summary?.pendingRequests).toEqual([]);
      }).pipe(Effect.provide(echoLayerAt(file)));
    }),
  );

  it.effect("clears requests the agent never reported resolved when the turn ends", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const events = yield* recordEvents;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "one" },
      });
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      const requestId = "req-orphan" as RequestId;
      yield* session.emit({
        type: "request",
        request: {
          kind: "question",
          id: requestId,
          questions: [],
        },
      });
      yield* waitStatus(thread.id, "needsInput");

      // The agent ends the turn without ever sending `requestResolved`.
      yield* session.emit({ type: "turnEnd", reason: "error" }, { type: "status", status: "idle" });
      yield* waitStatus(thread.id, "idle");

      expect(yield* store.listRequests(thread.id)).toEqual([]);
      expect(events).toContainEqual({
        type: "thread.requestResolved",
        threadId: thread.id,
        requestId,
      });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});

describe("what a crash left behind", () => {
  it.effect("boot ends the open turn as interrupted and drops its request", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-crash-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      const file = join(dir, "gram.db");
      const layer = () =>
        AppToolRegistry.layer.pipe(
          Layer.provideMerge(ThreadRuntimes.layer),
          Layer.provideMerge(EventHub.layer),
          Layer.provideMerge(ThreadStore.layerSqlite(file)),
          Layer.provideMerge(makeFakeAgentAdapter()),
          Layer.provideMerge(
            Layer.succeed(
              TurnHooks,
              TurnHooks.of({
                onTurnStart: () => Effect.void,
                onTurnEnd: (threadId, turnId, cwd, reason) =>
                  Effect.sync(() => void ended.push({ threadId, turnId, cwd, reason })),
                onRemoteCommand: () => Effect.void,
                onFilesChanged: () => Effect.void,
                resolveCwd: () => Effect.succeed(undefined),
              }),
            ),
          ),
          Layer.provideMerge(CheckoutService.layerNoGit),
          Layer.provideMerge(ServerConfig.layer(TEST_CONFIG)),
          Layer.orDie,
        );
      const ended: Array<{ threadId: ThreadId; turnId: TurnId; cwd: string; reason: string }> = [];

      // What a crash mid-turn leaves: an open turn and a pending question, and no process to own
      // either. Tearing a runtime down would end its turn, so the rows are written as they'd be left.
      const threadId = yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const thread = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/repo" },
        });
        // The agent had followed a move into another worktree, which live turn hooks don't.
        yield* store.updateThread(thread.id, (t) => ({
          ...t,
          currentCheckout: { kind: "worktree", path: "/work/repo/.worktrees/moved" },
        }));
        yield* store.startTurn(thread.id, "turn-cut" as TurnId, 1);
        yield* store.putRequest(
          thread.id,
          { kind: "question", id: "req-cut" as RequestId, questions: [] },
          2,
        );
        return thread.id;
      }).pipe(Effect.provide(layer()));

      yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;
        const [turn] = yield* store.listTurns(threadId);
        expect(turn?.reason).toBe("interrupted");
        // The test clock reads 0, before the turn began, so the turn ends where it started.
        expect(turn?.endedAt).toBe(1);
        // It gets its end checkpoint, so its diff stops following the checkout, from the checkout
        // its start checkpoint came from.
        expect(ended).toEqual([
          { threadId, turnId: "turn-cut", cwd: "/work/repo", reason: "interrupted" },
        ]);
        expect(yield* store.listRequests(threadId)).toEqual([]);
        const [summary] = yield* runtimes.snapshot;
        expect(summary?.status).toBe("cold");
      }).pipe(Effect.provide(layer()));
    }),
  );
});
