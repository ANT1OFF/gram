// Gram's notices are its own in the transcript however they reach the agent: sent at rest, steered
// into a turn, edited in the queue, or replayed after a restart. Only what the user typed is taken
// as the user's words (`attachUserWords`), which an orchestrator copies to a worker as theirs.
import { describe, expect, it } from "@effect/vitest";
import type { GramUIMessage, QueueItemId, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { attachUserWords } from "../orchestration/user-words.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentAdapter, FakeAgentControl } from "./fake-agent.ts";
import { CheckoutService, TurnHooks } from "./hooks.ts";
import { TEST_CONFIG, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

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

const textOf = (message: GramUIMessage) =>
  message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

/** Who the transcript says wrote each user-role message, by its text. */
const authors = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return Object.fromEntries(
      (yield* store.listMessages(threadId))
        .filter((message) => message.role === "user")
        .map((message) => [textOf(message), message.metadata?.author]),
    );
  });

describe("notice provenance", () => {
  it.effect("a notice is never the user's words: at rest, steered, edited or replayed", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-notice-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      const file = join(dir, "gram.db");

      const threadId = yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        const thread = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/repo" },
          role: "orchestrator",
          input: { text: "Set up the cart API." },
        });
        const session = yield* waitFor(
          "the user's first message",
          fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
        );
        yield* session.completeTurn();
        yield* waitFor(
          "the thread at rest",
          runtimes.snapshot.pipe(
            Effect.map((all) => all.find((s) => s.thread.id === thread.id)?.status === "idle"),
          ),
        );

        // At rest, a notice opens a turn of its own, as the audit's reproduction sent one.
        yield* runtimes.sendNotice(thread.id, "local-check:acme/web#1", {
          text: "fixture failed; printed text from check output",
        });
        yield* waitFor(
          "the notice sent",
          Effect.sync(() => session.sent.length === 2),
        );
        // Steered into that turn.
        expect(
          yield* runtimes.sendNotice(thread.id, "run:acme/web#2", { text: "run 2 finished" }),
        ).toMatchObject({ steered: true });
        // One the agent won't take mid-turn waits in the queue, where the user can edit it, and a
        // client can't make it theirs by saying so.
        yield* fake.setSteerFails(true);
        yield* runtimes.sendNotice(thread.id, "run:acme/web#3", { text: "run 3 finished" });
        const [summary] = yield* runtimes.snapshot;
        const queued = summary?.queue.find((item) => item.input.text === "run 3 finished");
        expect(queued?.input.author).toBe("server");
        yield* runtimes.editQueued(thread.id, queued!.id, {
          text: "run 3 finished, edited",
          author: "user",
        });
        return thread.id;
      }).pipe(Effect.provide(layerAt(file)));

      // After a restart the queued notice is replayed, still Gram's.
      yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        const store = yield* ThreadStore;
        yield* runtimes.sendQueuedAtBoot;
        yield* waitFor(
          "the replayed notice",
          fake
            .latest(threadId)
            .pipe(
              Effect.map((s) => s.sent.some((input) => input.text === "run 3 finished, edited")),
            ),
        );
        expect(yield* authors(threadId)).toEqual({
          "Set up the cart API.": "user",
          "fixture failed; printed text from check output": "server",
          "run 2 finished": "server",
          "run 3 finished, edited": "server",
        });
        const brief = yield* attachUserWords(store, "spawn_worker", threadId, "Brief.", 5);
        expect(brief).toContain(
          "Everything below this line is the user's:\n\nSet up the cart API.",
        );
        expect(brief).not.toContain("fixture failed");
        expect(brief).not.toContain("run 2 finished");
        expect(brief).not.toContain("run 3 finished");
      }).pipe(Effect.provide(layerAt(file)));
    }),
  );

  it.effect("a notice queued without an author is replayed as Gram's", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-notice-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      const file = join(dir, "gram.db");

      const threadId = yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const thread = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/repo" },
          role: "orchestrator",
          deferOpen: true,
        });
        // As a limit's "continue" is queued: the notice's key, and no author.
        yield* store.putQueue(thread.id, [
          {
            id: "11111111-1111-4111-8111-111111111111" as QueueItemId,
            input: { text: "keyed notice" },
            noticeKey: "run:acme/web#4",
          },
        ]);
        return thread.id;
      }).pipe(Effect.provide(layerAt(file)));

      yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        yield* runtimes.sendQueuedAtBoot;
        yield* waitFor(
          "the replayed notice",
          fake
            .latest(threadId)
            .pipe(Effect.map((s) => s.sent.some((input) => input.text === "keyed notice"))),
        );
        expect(yield* authors(threadId)).toEqual({ "keyed notice": "server" });
      }).pipe(Effect.provide(layerAt(file)));
    }),
  );
});
