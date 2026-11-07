import { mkdtempSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, layer } from "@effect/vitest";
import { GramRpcs } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../../config.ts";
import { gitPlatformTest } from "../../git/platform.ts";
import { removeDir } from "../../git/test-repo.ts";
import { LaunchToken, serverPort, ServerLayer } from "../../http/server.ts";
import { HttpServer, RpcClient, RpcSerialization, Socket } from "../../platform/unstable.ts";
import { FakeAgentAdapter, FakeAgentControl } from "../../runtime/fake-agent.ts";
import { TurnHooks } from "../../runtime/hooks.ts";
import { TEST_CONFIG, waitFor } from "../../runtime/test-harness.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";

const TestServer = ServerLayer.pipe(
  Layer.provideMerge(FakeAgentAdapter),
  Layer.provide(TurnHooks.layerNoop),
  Layer.provide(gitPlatformTest()),
  Layer.provide(ServerConfig.layer(TEST_CONFIG)),
  Layer.orDie,
);

/** Performs the boot navigation and returns the session cookie. */
const bootCookie = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const { token } = yield* LaunchToken;
  const port = serverPort(server);
  const setCookie = yield* Effect.promise(
    () =>
      new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port, path: `/?boot=${token}`, agent: false },
          (res) => {
            res.resume();
            resolve(res.headers["set-cookie"]?.[0] ?? "");
          },
        );
        req.on("error", reject);
        req.end();
      }),
  );
  return { port, cookie: setCookie.split(";")[0] ?? "" };
});

const makeClient = (dropTag?: string) =>
  Effect.gen(function* () {
    const { port, cookie } = yield* bootCookie;
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/ws`)),
        Layer.provide(
          Layer.succeed(Socket.WebSocketConstructor)((url) => {
            const ws = new (globalThis.WebSocket as unknown as new (
              url: string,
              init: { headers: Record<string, string> },
            ) => globalThis.WebSocket)(url, { headers: { cookie } });
            let dropId: string | undefined;
            const send = ws.send.bind(ws);
            ws.send = (data) => {
              if (typeof data === "string") {
                const frame = JSON.parse(data);
                if (frame._tag === "Request" && frame.tag === dropTag) dropId = String(frame.id);
              }
              send(data);
            };
            // Registered before Effect's listener: the server has completed the handler, but
            // the client never sees its acknowledgement. No sleeps decide this race.
            ws.addEventListener("message", (event) => {
              const frames = JSON.parse(String(event.data));
              if (
                (Array.isArray(frames) ? frames : [frames]).some(
                  (frame: { _tag: string; requestId?: string }) =>
                    frame._tag === "Exit" && String(frame.requestId) === dropId,
                )
              ) {
                dropId = undefined;
                event.stopImmediatePropagation();
                ws.close();
              }
            });
            return ws;
          }),
        ),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
    return yield* RpcClient.make(GramRpcs).pipe(Effect.provideContext(protocol));
  });

describe("message retry after a lost acknowledgement", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) removeDir(dir);
  });
  layer(TestServer, { excludeTestServices: true })("over a real socket", (it) => {
    for (const mode of ["send", "queue", "steer", "queueSteer"] as const) {
      it.effect(`does not dispatch ${mode} twice`, () =>
        Effect.gen(function* () {
          const folder = mkdtempSync(join(tmpdir(), "gram-message-retry-"));
          dirs.push(folder);
          const tag =
            mode === "queueSteer"
              ? "thread.queue.steer"
              : mode === "steer"
                ? "thread.steer"
                : "thread.send";
          const client = yield* makeClient(tag);
          const runtimes = yield* ThreadRuntimes;
          const control = yield* FakeAgentControl;
          const store = yield* ThreadStore;
          const thread = yield* runtimes.create({
            projectRoot: folder,
            checkout: { kind: "main", path: folder },
          });
          yield* waitFor(
            "the session",
            runtimes.session(thread.id).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            ),
          );
          if (mode !== "send") yield* runtimes.send(thread.id, { text: "hold the turn" });
          const input = { text: "exactly once" };
          const clientMessageId = `lost-${mode}`;
          if (mode === "queueSteer") yield* runtimes.send(thread.id, input);
          const queued = yield* store.listQueue(thread.id);
          const dispatch = (rpc: typeof client) =>
            mode === "queueSteer"
              ? rpc["thread.queue.steer"]({
                  threadId: thread.id,
                  itemId: queued[0]!.id,
                  clientMessageId,
                })
              : mode === "steer"
                ? rpc["thread.steer"]({ threadId: thread.id, input, clientMessageId })
                : rpc["thread.send"]({ threadId: thread.id, input, clientMessageId });
          const lost = yield* dispatch(client).pipe(Effect.exit);
          expect(lost._tag).toBe("Failure");
          const session = control.sessions.at(-1)!;
          if (mode === "send") {
            yield* session.completeTurn();
            yield* waitFor(
              "idle before retry",
              runtimes.status(thread.id).pipe(Effect.map((status) => status === "idle")),
            );
          }
          const retry = yield* makeClient();
          const result = yield* dispatch(retry);
          if (mode === "send" || mode === "queue")
            expect(result).toEqual({ queued: mode === "queue" });
          if (mode === "queue") {
            expect((yield* store.listQueue(thread.id)).map((item) => item.input.text)).toEqual([
              "exactly once",
            ]);
          } else {
            expect(
              (mode === "steer" || mode === "queueSteer" ? session.steered : session.sent).filter(
                (sent) => sent.text === "exactly once",
              ),
            ).toHaveLength(1);
            expect(yield* store.listQueue(thread.id)).toHaveLength(0);
          }
        }).pipe(Effect.scoped),
      );
    }
  });
});
