import * as nodePath from "node:path";
import { request as httpRequest } from "node:http";
import { afterAll, describe, expect, layer } from "@effect/vitest";
import { GramRpcs, type TurnId } from "@gram/contracts";
import { ProcLive, snapshotCheckpoint } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../../config.ts";
import { gitPlatformTest } from "../../git/platform.ts";
import { hasGit, makeRepo, removeDir, tempDir, write } from "../../git/test-repo.ts";
import { LaunchToken, serverPort, ServerLayer } from "../../http/server.ts";
import { HttpServer, RpcClient, RpcSerialization, Socket } from "../../platform/unstable.ts";
import { FakeAgentAdapter } from "../../runtime/fake-agent.ts";
import { TurnHooks } from "../../runtime/hooks.ts";
import { TEST_CONFIG } from "../../runtime/test-harness.ts";

const TestServer = ServerLayer.pipe(
  Layer.provide(FakeAgentAdapter),
  Layer.provide(TurnHooks.layerNoop),
  Layer.provide(gitPlatformTest()),
  Layer.provide(ServerConfig.layer(TEST_CONFIG)),
  Layer.orDie,
);

const makeClient = Effect.gen(function* () {
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
  const cookie = setCookie.split(";")[0] ?? "";
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

describe.skipIf(!hasGit)("git.diff turn scope", () => {
  const dirs: Array<string> = [];
  afterAll(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  layer(TestServer, { excludeTestServices: true })("over a real socket", (it) => {
    it.effect("diffs one turn at a time from its checkpoints", () =>
      Effect.gen(function* () {
        const dir = tempDir();
        dirs.push(dir);
        const repo = makeRepo(dir);
        const client = yield* makeClient;
        const thread = yield* client["thread.create"]({
          projectRoot: repo,
          checkout: { kind: "current" },
        });
        yield* Effect.addFinalizer(() =>
          client["thread.close"]({ threadId: thread.id }).pipe(Effect.ignore),
        );
        const snapshot = (id: string) =>
          snapshotCheckpoint(repo, thread.id, id).pipe(Effect.provide(ProcLive));
        const paths = (turnId: string) =>
          client["git.diff"]({
            threadId: thread.id,
            scope: { kind: "turn", turnId: turnId as TurnId },
          }).pipe(Effect.map((diff) => (diff.files ?? []).map((f) => f.path).toSorted()));

        yield* snapshot("turn-1");
        write(nodePath.join(repo, "tracked.txt"), "edited in turn 1\n");
        yield* snapshot("turn-1.end");
        yield* snapshot("turn-2");
        write(nodePath.join(repo, "notes", "two.md"), "added in turn 2\n");
        yield* snapshot("turn-2.end");
        yield* snapshot("turn-3");
        write(nodePath.join(repo, "live.txt"), "still running\n");

        expect(yield* paths("turn-1")).toEqual(["tracked.txt"]);
        expect(yield* paths("turn-2")).toEqual(["notes/two.md"]);
        expect(yield* paths("turn-3")).toEqual(["live.txt"]);
        expect(yield* paths("turn-missing").pipe(Effect.flip)).toMatchObject({
          _tag: "NotFound",
          entity: "checkpoint",
          id: "turn-missing",
        });
      }).pipe(Effect.scoped),
    );
  });
});
