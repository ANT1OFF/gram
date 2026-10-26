import type { GramUIMessageChunk, TurnId, UserInput } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { UsageLimitReadings } from "../usage/limit-readings.ts";
import { EventHub } from "../events/event-hub.ts";
import { folderExists } from "../fs/folders.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import type { SqlClient } from "../platform/unstable.ts";
import { AgentHosts } from "./agent-hosts.ts";
import { FakeAgentAdapter, FakeAgentControl } from "./fake-agent.ts";
import { CheckoutService, TurnHooks } from "./hooks.ts";
import {
  ThreadRuntimes,
  type ObservedTurnEnd,
  type RuntimeObserver,
  type SystemDelivery,
} from "./thread-runtimes.ts";

export const TEST_CONFIG: ServerConfigShape = {
  dataDir: "/nonexistent/gram-test",
  databaseFile: ":memory:",
  port: 0,
  webRoot: undefined,
  extraOrigins: [],
  idleEvictAfter: Duration.minutes(15),
  interruptWatchdog: Duration.seconds(5),
};

/** The core services over an in-memory database and the fake agent, with no-op hooks. */
export const makeRuntimeTestLayer = (
  hooks: Layer.Layer<TurnHooks> = TurnHooks.layerNoop,
  checkouts: Layer.Layer<CheckoutService> = CheckoutService.layerNoGit,
  config: ServerConfigShape = TEST_CONFIG,
  agents: Layer.Layer<AgentHosts | FakeAgentControl> = FakeAgentAdapter,
  store: Layer.Layer<ThreadStore | SqlClient.SqlClient, unknown> = ThreadStore.layerSqlite(
    ":memory:",
  ),
) =>
  AppToolRegistry.layer.pipe(
    Layer.provideMerge(ThreadRuntimes.layer),
    Layer.provideMerge(UsageLimitReadings.layer),
    Layer.provideMerge(EventHub.layer),
    Layer.provideMerge(store),
    Layer.provideMerge(agents),
    Layer.provideMerge(hooks),
    Layer.provideMerge(checkouts),
    Layer.provideMerge(ServerConfig.layer(config)),
    Layer.orDie,
  );

export const RuntimeTestLayer = makeRuntimeTestLayer();

/** `CheckoutService.layerNoGit`, but a folder deleted from disk reads as gone. */
export const CheckoutsOnDisk: Layer.Layer<CheckoutService> = Layer.effect(
  CheckoutService,
  Effect.gen(function* () {
    const base = yield* CheckoutService;
    return CheckoutService.of({ ...base, present: folderExists });
  }),
).pipe(Layer.provide(CheckoutService.layerNoGit));

/** Polls `check` across scheduler yields; fibers make progress without advancing the clock. */
export const waitFor = <A, E, R>(
  label: string,
  check: Effect.Effect<A | undefined | false, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      const value = yield* check;
      if (value !== undefined && value !== false) return value;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

/**
 * The fake agent, except that `send` dies for an input whose text contains `marker`: an adapter
 * whose transport broke under it, which the fake has no switch for.
 */
export const fakeAgentWithFailingSend = (
  marker: string,
): Layer.Layer<AgentHosts | FakeAgentControl> =>
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
                open: (options) =>
                  host.open(options).pipe(
                    Effect.map((session) => ({
                      ...session,
                      send: (input, sendOptions) =>
                        input.text.includes(marker)
                          ? Effect.die(new Error("the transport is gone"))
                          : session.send(input, sendOptions),
                    })),
                  ),
              })),
            ),
        }),
      ).pipe(Context.add(FakeAgentControl, control));
    }),
  ).pipe(Layer.provide(FakeAgentAdapter));

/** A system delivery that writes down what it was asked and told, in order. */
export const recordingDelivery = (
  build: UserInput | ((turnId: TurnId) => UserInput | undefined),
): {
  readonly delivery: SystemDelivery;
  /** `build`, `accepted` or `failed:<reason>`, in the order they were called. */
  readonly calls: Array<string>;
  /** The turn ids `build`, then `accepted` or `failed`, were given. */
  readonly turnIds: Array<TurnId | undefined>;
} => {
  const calls: Array<string> = [];
  const turnIds: Array<TurnId | undefined> = [];
  const note = (call: string, turnId: TurnId | undefined) =>
    Effect.sync(() => {
      calls.push(call);
      turnIds.push(turnId);
    });
  return {
    calls,
    turnIds,
    delivery: {
      build: (turnId) =>
        note("build", turnId).pipe(
          Effect.map(() => (typeof build === "function" ? build(turnId) : build)),
        ),
      accepted: (turnId) => note("accepted", turnId),
      failed: (turnId, reason) => note(`failed:${reason}`, turnId),
    },
  };
};

/** One line per observer callback, e.g. `start`, `end:completed:adapter:empty`, `retrying:true`. */
export const recordingObserver = (): {
  readonly observer: RuntimeObserver;
  readonly seen: Array<string>;
  readonly ends: Array<ObservedTurnEnd>;
} => {
  const seen: Array<string> = [];
  const ends: Array<ObservedTurnEnd> = [];
  return {
    seen,
    ends,
    observer: {
      onTurnStart: () => Effect.sync(() => void seen.push("start")),
      onTurnEnd: (_thread, end) =>
        Effect.sync(() => {
          ends.push(end);
          seen.push(
            `end:${end.reason}:${end.synthesized ? "synthesized" : "adapter"}:${
              end.queueEmpty ? "empty" : "more"
            }`,
          );
        }),
      onRetrying: (_threadId, retrying) =>
        Effect.sync(() => void seen.push(`retrying:${retrying}`)),
      onUserInput: (_thread, input) => Effect.sync(() => void seen.push(`input:${input.text}`)),
    },
  };
};

/** The first chunk of an assistant reply, which is all a turn needs to show the agent has its input. */
export const replyStart = (messageId: string): GramUIMessageChunk => ({
  type: "start",
  messageId,
});
