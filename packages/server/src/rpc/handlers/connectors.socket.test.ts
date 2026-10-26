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
import { FakeAgentAdapter } from "../../runtime/fake-agent.ts";
import { TurnHooks } from "../../runtime/hooks.ts";
import { TEST_CONFIG, waitFor } from "../../runtime/test-harness.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";

const TestServer = ServerLayer.pipe(
  Layer.provide(FakeAgentAdapter),
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

const makeClient = Effect.gen(function* () {
  const { port, cookie } = yield* bootCookie;
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/ws`)),
      Layer.provide(
        Layer.succeed(Socket.WebSocketConstructor)(
          (url) =>
            new (globalThis.WebSocket as unknown as new (
              url: string,
              init: { headers: Record<string, string> },
            ) => globalThis.WebSocket)(url, { headers: { cookie } }),
        ),
      ),
      Layer.provide(RpcSerialization.layerJson),
    ),
  );
  return yield* RpcClient.make(GramRpcs).pipe(Effect.provideContext(protocol));
});

describe("connectors RPCs", () => {
  // Removed after the server layer's teardown, like the other socket suites.
  const dirs: Array<string> = [];
  afterAll(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  layer(TestServer, { excludeTestServices: true })("over a real socket", (it) => {
    it.effect("list, reconnect and toggle the fake agent's connectors", () =>
      Effect.gen(function* () {
        const folder = mkdtempSync(join(tmpdir(), "gram-connectors-"));
        dirs.push(folder);
        const client = yield* makeClient;
        const runtimes = yield* ThreadRuntimes;
        const thread = yield* client["thread.create"]({
          projectRoot: folder,
          checkout: { kind: "current" },
        });
        yield* Effect.addFinalizer(() =>
          client["thread.close"]({ threadId: thread.id }).pipe(Effect.ignore),
        );
        yield* waitFor(
          "the session",
          runtimes.session(thread.id).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        );

        expect(yield* client["connectors.list"]({ threadId: thread.id })).toEqual({
          live: true,
          connectors: [
            { name: "github", status: "connected", scope: "user" },
            {
              name: "linear",
              status: "needs-auth",
              scope: "claudeai",
              url: "https://mcp.linear.app/mcp",
              claudeAi: { id: "mcpsrv_linear" },
            },
          ],
        });
        yield* client["connectors.reconnect"]({ threadId: thread.id, name: "linear" });
        yield* client["connectors.setEnabled"]({
          threadId: thread.id,
          name: "github",
          enabled: false,
        });
      }).pipe(Effect.scoped),
    );
  });
});
