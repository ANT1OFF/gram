import { describe, expect, it } from "@effect/vitest";
import { LOCAL_HOST_ID, type ThreadId } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RoutedFor } from "../host/ownership.ts";
import { MachineOwnersForTests } from "../host/worker-host.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "./agent-hosts.ts";
import { FakeAgentAdapter, FakeAgentControl, type FakeSession } from "./fake-agent.ts";
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

/** The host doesn't take the first "flaky" input, then takes everything: a healthy retry. */
let refusedOnce = false;
const flakyOnce = Layer.effectContext(
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
              open: (options) =>
                host.open(options).pipe(
                  Effect.map((session) => ({
                    ...session,
                    send: (input, sendOptions) => {
                      if (!input.text.includes("flaky") || refusedOnce)
                        return session.send(input, sendOptions);
                      refusedOnce = true;
                      return Effect.die(
                        new InputUndelivered({ message: "The agent's machine didn't take it." }),
                      );
                    },
                  })),
                ),
            })),
          ),
      }),
    ).pipe(Context.add(FakeAgentControl, control));
  }),
).pipe(Layer.provide(FakeAgentAdapter));

/** This machine started for Grace (`host/ownership.ts`), with a host that drops one input. */
const ownedLayer = makeRuntimeTestLayer(
  TurnHooks.layerNoop,
  CheckoutService.layerNoGit,
  TEST_CONFIG,
  flakyOnce,
).pipe(
  Layer.provide(
    Layer.succeed(MachineOwnersForTests)({
      ownerOf: (id) => (id === LOCAL_HOST_ID ? "grace" : undefined),
    }),
  ),
);

const asGrace = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, RoutedFor, { person: "grace" });

describe("input put back on a person's own machine", () => {
  // A send straight to an idle session that the host didn't take is kept as its sender's: the
  // retry is admitted as them and goes, rather than being dropped as no one's.
  it.effect("is sent again as its owner's when the host takes it", () =>
    Effect.gen(function* () {
      refusedOnce = false;
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const thread = yield* asGrace(
        runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/repo" },
        }),
      );
      yield* statusOf(thread.id, "idle");
      const session = yield* fake.latest(thread.id);
      yield* asGrace(runtimes.send(thread.id, { text: "flaky on the way" }));
      expect(yield* queued(thread.id)).toEqual(["flaky on the way"]);
      expect((yield* store.listQueue(thread.id))[0]?.actor).toEqual({ person: "grace" });
      // Her next message tries the kept one first; the host takes both now.
      yield* asGrace(runtimes.send(thread.id, { text: "then this" }));
      yield* waitFor(
        "the kept input sent",
        Effect.sync(() => sentTexts(session).some((text) => text.includes("flaky on the way"))),
      );
      expect(sentTexts(session)[0]).toContain("flaky on the way");
    }).pipe(Effect.provide(ownedLayer)),
  );
});
