import { describe, expect, it } from "@effect/vitest";
import type { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl, type FakeSession } from "./fake-agent.ts";
import { CheckoutService, TurnHooks } from "./hooks.ts";
import {
  fakeAgentWithFailingSend,
  makeRuntimeTestLayer,
  TEST_CONFIG,
  waitFor,
} from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";
import { InputUndelivered } from "./undelivered.ts";

/** A session whose host lost "lost": a joined machine that didn't come back in time. */
const layer = makeRuntimeTestLayer(
  TurnHooks.layerNoop,
  CheckoutService.layerNoGit,
  TEST_CONFIG,
  fakeAgentWithFailingSend(
    "lost",
    () => new InputUndelivered({ message: "The agent's machine didn't take it." }),
  ),
);

const statusOf = (threadId: ThreadId, status: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    return yield* waitFor(
      `status ${status}`,
      runtimes.status(threadId).pipe(Effect.map((s) => s === status)),
    );
  });

const userTexts = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return (yield* store.listMessages(threadId))
      .filter((m) => m.role === "user")
      .flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])));
  });

const sentTexts = (session: FakeSession) => session.sent.map((input) => input.text);

const queued = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const thread = (yield* runtimes.snapshot).find((t) => t.thread.id === threadId);
    return (thread?.queue ?? []).map((item) => item.input.text);
  });

describe("input the agent's host didn't take", () => {
  it.effect("waits at the queue's head, out of the feed, the thread saying why", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
      });
      yield* statusOf(thread.id, "idle");
      const session = yield* fake.latest(thread.id);

      // Before this change the host's proxy reported it sent: the turn ran with nothing to answer.
      expect(yield* runtimes.send(thread.id, { text: "lost on the way" })).toEqual({
        queued: true,
      });
      expect(yield* queued(thread.id)).toEqual(["lost on the way"]);
      expect(yield* userTexts(thread.id)).toEqual([]);
      expect(yield* runtimes.status(thread.id)).toBe("error");
      expect((yield* store.listTurns(thread.id)).map((turn) => turn.reason)).toEqual([
        "interrupted",
      ]);
      // Not sent into the session again at once.
      expect(session.sent).toEqual([]);
      // The next message waits behind it, never overtaking it: the kept one is tried first, and
      // the host still not taking it, both wait.
      expect(yield* runtimes.send(thread.id, { text: "then this" })).toMatchObject({
        queued: true,
      });
      expect(sentTexts(session)).toEqual([]);
      expect(yield* queued(thread.id)).toEqual(["lost on the way", "then this"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps a launch the same way", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "lost at launch" },
      });
      yield* statusOf(thread.id, "error");
      expect(yield* queued(thread.id)).toEqual(["lost at launch"]);
      expect(yield* userTexts(thread.id)).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
});
