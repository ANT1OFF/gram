import {
  applySettingsPatch,
  type GramUIMessage,
  type ServerEvent,
  type SinkEvent,
  type ThreadId,
} from "@gram/contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl, makeFakeAgentAdapter } from "../runtime/fake-agent.ts";
import { CheckoutService, TurnHooks } from "../runtime/hooks.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { UsageLimitReadings } from "../usage/limit-readings.ts";
import { DecisionHook } from "./decision-hook.ts";
import { EventSink } from "./event-sink.ts";

type Answer = { status?: number; json: unknown };

export const endpoint = <Body>(answer: (body: Body) => Answer | Promise<Answer>) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ server: Server; url: string; tokens: Array<string | undefined> }>(
          (resolve) => {
            const tokens: Array<string | undefined> = [];
            const server = createServer((request, response) => {
              const chunks: Array<Buffer> = [];
              request.on("data", (chunk: Buffer) => chunks.push(chunk));
              request.on("end", () => {
                tokens.push(request.headers.authorization);
                void Promise.resolve(
                  answer(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body),
                ).then(({ status = 200, json }) => {
                  response.writeHead(status, { "content-type": "application/json" });
                  response.end(JSON.stringify(json));
                });
              });
            });
            server.listen(0, "127.0.0.1", () =>
              resolve({
                server,
                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
                tokens,
              }),
            );
          },
        ),
    ),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );

/** Polls in real time: the endpoints answer over real sockets. */
export const eventually = <A, E, R>(
  label: string,
  check: Effect.Effect<A | undefined | false, E, R>,
) =>
  Effect.gen(function* () {
    for (let i = 0; i < 1000; i++) {
      const value = yield* check;
      if (value !== undefined && value !== false) return value;
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

export const serverLayer = (
  decisionUrl: string | undefined,
  sinkUrl?: string,
  sinkMessages = false,
  dir?: string,
  toolStepDelay: Duration.Input = "20 millis",
) =>
  AppToolRegistry.layer.pipe(
    Layer.provideMerge(ThreadRuntimes.layerOnLocalHost),
    Layer.provideMerge(UsageLimitReadings.layer),
    Layer.provideMerge(DecisionHook.layer.pipe(Layer.provideMerge(EventSink.layer))),
    Layer.provideMerge(EventHub.layer),
    Layer.provideMerge(
      ThreadStore.layerSqlite(dir === undefined ? ":memory:" : join(dir, "gram.db")),
    ),
    Layer.provideMerge(makeFakeAgentAdapter({ reply: "echo", toolStepDelay })),
    Layer.provideMerge(TurnHooks.layerNoop),
    Layer.provideMerge(CheckoutService.layerNoGit),
    Layer.provideMerge(
      ServerConfig.layer({
        ...TEST_CONFIG,
        ...(dir === undefined ? {} : { dataDir: dir, databaseFile: join(dir, "gram.db") }),
        ...(decisionUrl === undefined
          ? {}
          : {
              decisionHook:
                decisionUrl === "unusable"
                  ? ("unusable" as const)
                  : { url: decisionUrl, token: "hook-token" },
            }),
        ...(sinkUrl === undefined ? {} : { eventSink: { url: sinkUrl, token: "sink-token" } }),
        ...(sinkMessages ? { eventSinkMessages: true } : {}),
      }),
    ),
    Layer.orDie,
  );

export const setHosted = (on: boolean) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    yield* store.updateSettings(
      (settings) => applySettingsPatch(settings, { experimental: { embedding: on } }),
      [["experimental", "embedding"]],
    );
  });

export const collectEvents = Effect.gen(function* () {
  const hub = yield* EventHub;
  const events: Array<ServerEvent> = [];
  yield* Effect.forkScoped(
    Stream.runForEach(
      hub.internalEvents(() => true),
      (event) => Effect.sync(() => void events.push(event)),
    ),
  );
  return events;
});

export const startThread = (text: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    return yield* runtimes.create({
      projectRoot: "/work/repo",
      checkout: { kind: "main", path: "/work/repo" },
      input: { text },
    });
  });

export const sessionOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const control = yield* FakeAgentControl;
    return yield* control.latest(threadId);
  });

/** Waits for the receiver to hold the message `messageId` with its turn's end stamped on it. */
export const sentTurnEnd = (to: { readonly held: ReadonlyArray<SinkEvent> }, messageId: string) =>
  eventually(
    "the reply with its turn's end",
    Effect.sync(() =>
      to.held.some(
        (event) =>
          event.type === "message" &&
          event.data["id"] === messageId &&
          (event.data["message"] as GramUIMessage).metadata?.turnEnd !== undefined,
      ),
    ),
  );

/** What the receiver holds once the sink has nothing more to send it. */
export const settledAt = (to: { readonly held: ReadonlyArray<SinkEvent> }) =>
  Effect.gen(function* () {
    let before = -1;
    yield* eventually(
      "the sink to go quiet",
      Effect.sleep("150 millis").pipe(
        Effect.map(() => {
          const quiet = to.held.length === before;
          before = to.held.length;
          return quiet;
        }),
      ),
    );
    return [...to.held];
  });
