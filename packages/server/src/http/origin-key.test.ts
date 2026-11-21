// What the launch cookie, which every port of this host is sent, opens without the origin key
// only Gram's own page holds (`auth.ts`): the web app's own files, and no boot, socket or route.

import { afterAll, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureLogs } from "@gram/agents/testing/logs";
import { ServerConfig } from "../config.ts";
import { gitPlatformTest } from "../git/platform.ts";
import { FakeAgentAdapter } from "../runtime/fake-agent.ts";
import { TurnHooks } from "../runtime/hooks.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { ORIGIN_KEY_PROTOCOL } from "./auth.ts";
import { ServerLayer } from "./server.ts";
import { bootCookie, raw, serverInfo, upgradeStatus } from "./server.testing.ts";

const dataDir = mkdtempSync(join(tmpdir(), "gram-origin-key-"));
const webRoot = mkdtempSync(join(tmpdir(), "gram-origin-key-web-"));
writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>Gram</title>");
writeFileSync(join(webRoot, "app.js"), "console.log('app')");
afterAll(() => {
  for (const dir of [dataDir, webRoot])
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const TestServer = ServerLayer.pipe(
  Layer.provide(FakeAgentAdapter),
  Layer.provide(TurnHooks.layerNoop),
  Layer.provide(gitPlatformTest()),
  Layer.provide(ServerConfig.layer({ ...TEST_CONFIG, dataDir, webRoot })),
  Layer.orDie,
  Layer.provideMerge(captureLogs({ printWarnings: true }).layer),
);

layer(TestServer, { excludeTestServices: true })("the cookie another port is sent", (it) => {
  // Every port of this host is sent the cookie, and a boot answers with the key: the cookie's
  // value replayed as the boot token, the way such a server would, must get neither.
  it.effect("refuses the cookie's value replayed as the boot token, and hands it no key", () =>
    Effect.gen(function* () {
      const { port } = yield* serverInfo;
      const cookie = yield* bootCookie;
      const value = cookie.slice(cookie.indexOf("=") + 1);
      for (const headers of [{}, { cookie }]) {
        const replay = yield* raw(port, { path: `/?boot=${value}`, headers, noKey: true });
        expect(replay.status).toBe(401);
        expect(replay.headers.location).toBeUndefined();
      }
    }),
  );

  // A server on another loopback port the browser visits is sent the cookie, and replays it.
  it.effect(
    "refuses the socket and every route to the cookie alone, which another port is sent",
    () =>
      Effect.gen(function* () {
        const { port } = yield* serverInfo;
        const cookie = yield* bootCookie;
        expect(yield* upgradeStatus(port, { cookie }, "/ws", true)).toBe(401);
        for (const [method, path] of [
          ["POST", "/workspace/export"],
          ["POST", "/machines/join"],
          ["GET", "/?boot=0"],
        ] as const)
          expect(
            (yield* raw(port, { method, path, headers: { cookie }, noKey: true })).status,
          ).toBe(401);
        // The web app's own files it still gets, to load the page that holds the key.
        expect(
          (yield* raw(port, { path: "/app.js", headers: { cookie }, noKey: true })).status,
        ).toBe(200);
        const shell = yield* raw(port, {
          path: "/settings/machines",
          headers: { cookie, accept: "text/html" },
          noKey: true,
        });
        expect(shell.body).toContain("<title>Gram</title>");
      }),
  );

  it.effect("opens the socket with the key as its subprotocol, as a browser sends it", () =>
    Effect.gen(function* () {
      const { port, originKey } = yield* serverInfo;
      const cookie = yield* bootCookie;
      const protocol = `${ORIGIN_KEY_PROTOCOL}${originKey}`;
      const socket = new (globalThis.WebSocket as unknown as new (
        url: string,
        init: { headers: Record<string, string>; protocols: Array<string> },
      ) => globalThis.WebSocket)(`ws://127.0.0.1:${port}/ws`, {
        headers: { cookie },
        protocols: [protocol],
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()));
      const opened = yield* Effect.promise(
        () =>
          new Promise<string>((resolve, reject) => {
            socket.addEventListener("open", () => resolve(socket.protocol), { once: true });
            socket.addEventListener("error", () => reject(new Error("refused")), { once: true });
          }),
      );
      // The server answers with the protocol the browser asked for, or the browser drops it.
      expect(opened).toBe(protocol);
      expect(
        yield* upgradeStatus(
          port,
          { cookie, "sec-websocket-protocol": `${ORIGIN_KEY_PROTOCOL}${"0".repeat(64)}` },
          "/ws",
          true,
        ),
      ).toBe(401);
    }),
  );
});
