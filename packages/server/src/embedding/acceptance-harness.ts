// The server the embedding acceptance tests run: the decision hook and event sink on loopback
// endpoints, a fake agent, and the steps those tests share.
import { applySettingsPatch, type ServerEvent, type ThreadId } from "@gram/contracts";
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

/** A JSON endpoint on loopback that answers each POST with what `answer` makes of its body. */
export const endpoint = <Body>(answer: (body: Body) => { status?: number; json: unknown }) =>
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
                const { status = 200, json } = answer(
                  JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body,
                );
                response.writeHead(status, { "content-type": "application/json" });
                response.end(JSON.stringify(json));
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
  /** A data folder for a server that is started again; absent, nothing outlives the layer. */
  dir?: string,
) =>
  AppToolRegistry.layer.pipe(
    Layer.provideMerge(ThreadRuntimes.layerOnLocalHost),
    Layer.provideMerge(UsageLimitReadings.layer),
    Layer.provideMerge(DecisionHook.layer.pipe(Layer.provideMerge(EventSink.layer))),
    Layer.provideMerge(EventHub.layer),
    Layer.provideMerge(
      ThreadStore.layerSqlite(dir === undefined ? ":memory:" : join(dir, "gram.db")),
    ),
    Layer.provideMerge(makeFakeAgentAdapter({ reply: "echo", toolStepDelay: "20 millis" })),
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
