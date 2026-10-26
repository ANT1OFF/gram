import { describe, expect, it } from "@effect/vitest";
import { fenceThreadMessage, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentAdapter, FakeAgentControl } from "./fake-agent.ts";
import { CheckoutService, TurnHooks } from "./hooks.ts";
import { TEST_CONFIG, waitFor } from "./test-harness.ts";
import { ThreadRuntimes, type JoinQueued } from "./thread-runtimes.ts";

const layerAt = (file: string) =>
  AppToolRegistry.layer.pipe(
    Layer.provideMerge(ThreadRuntimes.layer),
    Layer.provideMerge(EventHub.layer),
    Layer.provideMerge(ThreadStore.layerSqlite(file)),
    Layer.provideMerge(FakeAgentAdapter),
    Layer.provideMerge(TurnHooks.layerNoop),
    Layer.provideMerge(CheckoutService.layerNoGit),
    Layer.provideMerge(ServerConfig.layer(TEST_CONFIG)),
    Layer.orDie,
  );

const origin = { threadId: "orchestrator" as ThreadId, title: "Orchestrator", depth: 1 };

/** Joins with how many messages the item held, to check the runtime's count. */
const counted: JoinQueued = (queued, next) => ({
  ...queued.input,
  text: `${queued.input.text}+${next.text}@${queued.messages}`,
});

/**
 * What a crash leaves: the database as it stands at this moment, copied while the server that
 * wrote it is still mid-send, for a server booted from the copy.
 */
const crashCopy = (file: string, to: string) =>
  Effect.sync(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(file + suffix)) copyFileSync(file + suffix, to + suffix);
    }
  });

/** The user-role rows of `threadId` with `text`, and what the newest session was sent. */
const delivered = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const fake = yield* FakeAgentControl;
    const rows = (yield* store.listMessages(threadId)).filter(
      (m) => m.role === "user" && m.parts.some((p) => p.type === "text" && p.text === text),
    );
    const sent = (yield* fake.latest(threadId)).sent.filter((input) => input.text === text);
    return { rows: rows.length, sent: sent.length };
  });

describe("queue persistence", () => {
  it.effect("records no turn failure when a restart interrupts a running session", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-queue-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      const file = join(dir, "gram.db");

      const threadId = yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        const thread = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/repo" },
          input: { text: "one" },
        });
        yield* waitFor(
          "the first send",
          fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1)),
        );
        return thread.id;
      }).pipe(Effect.provide(layerAt(file)));

      yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        expect((yield* store.getThread(threadId)).lastError).toBeUndefined();
        const parts = (yield* store.listMessages(threadId)).flatMap((m) => m.parts);
        expect(parts.some((p) => p.type === "data-agent-error")).toBe(false);
      }).pipe(Effect.provide(layerAt(file)));
    }),
  );

  it.effect("keeps queued inputs across a server restart and sends them once idle", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-queue-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      const file = join(dir, "gram.db");

      const threadId = yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        const thread = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/repo" },
          input: { text: "one" },
        });
        yield* waitFor(
          "the first send",
          fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1)),
        );
        yield* runtimes.send(thread.id, { text: "two" });
        yield* runtimes.send(thread.id, { text: "three", origin });
        return thread.id;
      }).pipe(Effect.provide(layerAt(file)));

      yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        const [summary] = yield* runtimes.snapshot;
        expect(summary?.queue.map((q) => q.input.text)).toEqual(["two", "three"]);

        // A restored item is one message of unknown age, and counts on from there.
        expect(yield* runtimes.sendOrJoin(threadId, { text: "3b", origin }, counted)).toMatchObject(
          { joined: { queuedAt: undefined } },
        );
        yield* runtimes.sendOrJoin(threadId, { text: "3c", origin }, counted);

        // The restored queue drains ahead of a new send once the resumed session is idle.
        yield* runtimes.send(threadId, { text: "four" });
        const session = yield* waitFor(
          "the resumed session's first send",
          fake.latest(threadId).pipe(Effect.map((s) => s.sent.length === 1 && s)),
        );
        expect(session.sent.map((i) => i.text)).toEqual(["two"]);
        const [after] = yield* runtimes.snapshot;
        expect(after?.queue.map((q) => q.input.text)).toEqual(["three+3b@1+3c@2", "four"]);
      }).pipe(Effect.provide(layerAt(file)));
    }),
  );

  it.effect("sends at boot what a restart left queued, but not an archived thread's", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-queue-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      const file = join(dir, "gram.db");

      const [cut, archived] = yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        const queued = (text: string) =>
          Effect.gen(function* () {
            const thread = yield* runtimes.create({
              projectRoot: "/work/repo",
              checkout: { kind: "main", path: "/work/repo" },
              input: { text },
            });
            yield* waitFor(
              "the first send",
              fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1)),
            );
            yield* runtimes.send(thread.id, { text: `${text} queued`, origin });
            return thread.id;
          });
        const first = yield* queued("cut");
        const second = yield* queued("archived");
        yield* runtimes.updateThread(second, (t) => ({ ...t, parked: true }));
        return [first, second] as const;
      }).pipe(Effect.provide(layerAt(file)));

      yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        yield* runtimes.sendQueuedAtBoot;
        const session = yield* waitFor(
          "the resumed session's send",
          fake.latest(cut).pipe(Effect.map((s) => s.sent.length === 1 && s)),
        );
        expect(session.sent.map((i) => i.text)).toEqual([fenceThreadMessage(origin, "cut queued")]);
        const byId = new Map((yield* runtimes.snapshot).map((s) => [s.thread.id, s]));
        expect(byId.get(cut)?.queue).toEqual([]);
        expect(byId.get(archived)?.queue.map((q) => q.input.text)).toEqual(["archived queued"]);
        expect(byId.get(archived)?.status).toBe("cold");
      }).pipe(Effect.provide(layerAt(file)));
    }),
  );

  it.effect("sends a queued item at once when it is steered with nothing running", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-queue-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      const file = join(dir, "gram.db");

      const threadId = yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        const thread = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/repo" },
          input: { text: "one" },
        });
        yield* waitFor(
          "the first send",
          fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1)),
        );
        yield* runtimes.send(thread.id, { text: "two" });
        yield* runtimes.send(thread.id, { text: "three" });
        return thread.id;
      }).pipe(Effect.provide(layerAt(file)));

      yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        const [summary] = yield* runtimes.snapshot;
        expect(summary?.status).toBe("cold");
        const three = summary?.queue.find((q) => q.input.text === "three");
        yield* runtimes.steerQueued(threadId, three!.id);
        const session = yield* waitFor(
          "the steered item's send",
          fake.latest(threadId).pipe(Effect.map((s) => s.sent.length === 1 && s)),
        );
        expect(session.sent.map((i) => i.text)).toEqual(["three"]);
        const [after] = yield* runtimes.snapshot;
        expect(after?.queue.map((q) => q.input.text)).toEqual(["two"]);
      }).pipe(Effect.provide(layerAt(file)));
    }),
  );

  it.effect("sends at boot a send whose session a restart cut off, as one message", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-queue-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      const file = join(dir, "gram.db");

      const threadId = yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        // The test clock never reaches it, so the server stops with the session still opening.
        yield* fake.setOpenDelay("1 hour");
        const thread = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/repo" },
          input: { text: "one" },
        });
        expect(yield* runtimes.status(thread.id)).toBe("starting");
        return thread.id;
      }).pipe(Effect.provide(layerAt(file)));

      yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        // Withdrawn at boot, the message waits in the queue as what it is: unsent.
        expect((yield* store.listMessages(threadId)).filter((m) => m.role === "user")).toEqual([]);
        expect((yield* runtimes.snapshot)[0]?.queue.map((q) => q.input.text)).toEqual(["one"]);
        yield* runtimes.sendQueuedAtBoot;
        const session = yield* waitFor(
          "the resumed send",
          fake.latest(threadId).pipe(Effect.map((s) => s.sent.length === 1 && s)),
        );
        expect(session.sent.map((i) => i.text)).toEqual(["one"]);
        const users = (yield* store.listMessages(threadId)).filter((m) => m.role === "user");
        expect(users).toHaveLength(1);
        expect((yield* runtimes.snapshot)[0]?.queue).toEqual([]);
      }).pipe(Effect.provide(layerAt(file)));
    }),
  );

  it.effect("a crash before the agent takes the queue's next message replays it, once", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-queue-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      const file = join(dir, "gram.db");
      const crashed = join(dir, "crashed.db");

      const threadId = yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
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
        yield* runtimes.send(thread.id, { text: "two" });
        // The turn ends, so "two" leaves the queue for the agent, which dies before taking it.
        yield* fake.setSendHangs(true);
        yield* session.completeTurn();
        yield* waitFor(
          "the next message in the feed, on its way to the agent",
          store
            .listMessages(thread.id)
            .pipe(
              Effect.map((messages) =>
                messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "two")),
              ),
            ),
        );
        yield* crashCopy(file, crashed);
        return thread.id;
      }).pipe(Effect.provide(layerAt(file)));

      yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        const store = yield* ThreadStore;
        // What the crash left still holds it, on its way to the agent.
        expect((yield* store.listQueue(threadId)).map((item) => item.input.text)).toEqual(["two"]);
        yield* runtimes.sendQueuedAtBoot;
        yield* waitFor(
          "the replayed message",
          fake
            .latest(threadId)
            .pipe(Effect.map((s) => s.sent.some((input) => input.text === "two"))),
        );
        // Sent once, and its row in the feed is the same one, not a second.
        expect(yield* delivered(threadId, "two")).toEqual({ rows: 1, sent: 1 });
        const [summary] = yield* runtimes.snapshot;
        expect(summary?.queue).toEqual([]);
      }).pipe(Effect.provide(layerAt(crashed)));
    }),
  );

  it.effect("a crash before the agent takes a launch replays it, once", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-queue-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      const file = join(dir, "gram.db");
      const crashed = join(dir, "crashed.db");

      const threadId = yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        yield* fake.setSendHangs(true);
        const thread = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/repo" },
          input: { text: "one" },
        });
        // Open, and its first send on its way to the agent, which dies before taking it.
        yield* waitFor(
          "the session open",
          fake.latest(thread.id).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        );
        yield* waitFor(
          "the launch's turn",
          store.listTurns(thread.id).pipe(Effect.map((turns) => turns.length === 1)),
        );
        yield* crashCopy(file, crashed);
        return thread.id;
      }).pipe(Effect.provide(layerAt(file)));

      yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        const store = yield* ThreadStore;
        // What the crash left still holds it, on its way to the agent.
        expect((yield* store.listQueue(threadId)).map((item) => item.input.text)).toEqual(["one"]);
        yield* runtimes.sendQueuedAtBoot;
        yield* waitFor(
          "the replayed launch",
          fake.latest(threadId).pipe(
            Effect.map((s) => s.sent.some((input) => input.text === "one")),
            Effect.orElseSucceed(() => false),
          ),
        );
        expect(yield* delivered(threadId, "one")).toEqual({ rows: 1, sent: 1 });
      }).pipe(Effect.provide(layerAt(crashed)));
    }),
  );
});
