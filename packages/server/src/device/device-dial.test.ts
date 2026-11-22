// A lent device's dial into a whole server over a real socket, behind a synthetic proxy: only the
// front's device statement reaches the device's path and nothing else, only with the decision hook
// on, and a dial signed for that statement connects the device, which the event sink records. Its
// tools are listed to every session but a worker's.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, layer } from "@effect/vitest";
import {
  DEVICE_ID_HEADER,
  DEVICE_NONCE_HEADER,
  DEVICE_PROTOCOL_VERSION,
  DEVICE_SIGNATURE_HEADER,
  DEVICE_TIME_HEADER,
  DeviceId,
  DeviceRpcs,
  deviceDialBytes,
  ThreadId,
} from "@gram/contracts";
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as SocketServer from "effect/socket/SocketServer";
import * as Stream from "effect/Stream";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { gitPlatformTest } from "../git/platform.ts";
import { DEVICE_TYP, IDENTITY_HEADER } from "../http/fronted-identity.ts";
import { makeTestProxy } from "../http/fronted-identity.testing.ts";
import { serverPort, ServerLayer } from "../http/server.ts";
import { HttpServer, Socket } from "../platform/unstable.ts";
import { waitReal } from "../orchestration/test-harness.ts";
import { makeFakeAgentAdapter } from "../runtime/fake-agent.ts";
import { TurnHooks } from "../runtime/hooks.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { DEVICE_CONNECT_PATH } from "./devices.ts";

const proxy = makeTestProxy();
const ORIGIN = proxy.config.origin;
const PUBLIC_PATH = "/desktop/device";
const WORKSPACE = "w1";

const sunk: Array<{ type: string; data: Record<string, unknown> }> = [];
const sinkPort = await new Promise<number>((resolve) => {
  const receiver = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    req.on("end", () => {
      const batch = JSON.parse(text) as { events: Array<{ seq: number } & (typeof sunk)[number]> };
      for (const event of batch.events) if (event.seq === sunk.length + 1) sunk.push(event);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ack: sunk.length }));
    });
  });
  receiver.unref();
  receiver.listen(0, "127.0.0.1", () => resolve((receiver.address() as { port: number }).port));
});

const dataDirs: string[] = [];
afterAll(() => {
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
});

const server = (hook: boolean) => {
  const dataDir = mkdtempSync(join(tmpdir(), "gram-device-dial-"));
  dataDirs.push(dataDir);
  return ServerLayer.pipe(
    Layer.provideMerge(makeFakeAgentAdapter({ reply: "echo" })),
    Layer.provide(TurnHooks.layerNoop),
    Layer.provide(gitPlatformTest()),
    Layer.provide(
      ServerConfig.layer({
        ...TEST_CONFIG,
        dataDir,
        frontedIdentity: proxy.config,
        embedding: true,
        eventSink: { url: `http://127.0.0.1:${sinkPort}/events` },
        // Asked about actions only; a dial never calls it, so nothing need answer here.
        ...(hook ? { decisionHook: { url: "http://127.0.0.1:9/decide" } } : {}),
      }),
    ),
    Layer.orDie,
  );
};

const deviceKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x as string;
  const id = DeviceId.make(
    `d-${createHash("sha256").update(Buffer.from(x, "base64url")).digest("hex").slice(0, 24)}`,
  );
  return { privateKey, publicKey: x, id };
};

/** What the front sends on: its device statement, and the device's own signed headers. */
const forwarded = (key: ReturnType<typeof deviceKey>) => {
  const token = randomBytes(32).toString("base64url");
  const time = Date.now();
  const nonce = randomBytes(16).toString("base64url");
  const signature = sign(
    null,
    deviceDialBytes({
      origin: ORIGIN,
      path: PUBLIC_PATH,
      workspace: WORKSPACE,
      subject: "user-ada",
      deviceId: key.id,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      time,
      nonce,
    }),
    key.privateKey,
  ).toString("base64url");
  return {
    [IDENTITY_HEADER]: proxy.statement(
      { device_key: key.publicKey, workspace: WORKSPACE, path: PUBLIC_PATH },
      { header: { typ: DEVICE_TYP } },
    ),
    authorization: `DPoP ${token}`,
    [DEVICE_ID_HEADER]: key.id,
    [DEVICE_TIME_HEADER]: String(time),
    [DEVICE_NONCE_HEADER]: nonce,
    [DEVICE_SIGNATURE_HEADER]: signature,
  };
};

/** The status an upgrade of `path` gets: 101 when accepted. */
const upgrade = (port: number, path: string, headers: Record<string, string>) =>
  Effect.promise(
    () =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest({
          host: "127.0.0.1",
          port,
          path,
          agent: false,
          headers: {
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": randomBytes(16).toString("base64"),
            ...headers,
          },
        });
        req.on("upgrade", (_res, socket) => {
          socket.destroy();
          resolve(101);
        });
        req.on("response", (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      }),
  );

/** A fake device: dials with `headers` and serves its hello, in the caller's scope. */
const dialAsDevice = (port: number, path: string, headers: Record<string, string>, id: DeviceId) =>
  Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers,
    } as never).pipe(Effect.provide(NodeWS.layerWebSocketConstructor));
    yield* Layer.launch(
      RpcServer.layer(DeviceRpcs).pipe(
        Layer.provide(
          DeviceRpcs.toLayer(
            DeviceRpcs.of({
              "device.hello": () =>
                Effect.succeed({
                  protocol: DEVICE_PROTOCOL_VERSION,
                  deviceId: id,
                  platform: "darwin" as const,
                  capabilities: ["read" as const],
                  folders: [],
                }),
              "device.exec": () => Stream.empty,
              "device.files.list": () => Effect.die("not in this test"),
              "device.files.read": () => Effect.die("not in this test"),
              "device.cancel": () => Effect.void,
              "device.token": () => Effect.die("not in this test"),
            }),
          ),
        ),
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(
          Layer.succeed(SocketServer.SocketServer, {
            address: NetAddress.unixPathAddress("fake-device"),
            run: (handler) => handler(socket).pipe(Effect.ignore, Effect.andThen(Effect.never)),
          }),
        ),
        Layer.provide(RpcSerialization.layerNdjson),
      ),
    ).pipe(Effect.forkScoped);
  });

const portOf = Effect.map(HttpServer.HttpServer, serverPort);

describe("a device's dial", () => {
  layer(server(true), { excludeTestServices: true })("with the decision hook on", (it) => {
    it.effect("takes no person's own statement on the device's path", () =>
      Effect.gen(function* () {
        const port = yield* portOf;
        expect(
          yield* upgrade(port, DEVICE_CONNECT_PATH, { [IDENTITY_HEADER]: proxy.statement() }),
        ).toBe(403);
      }),
    );

    it.effect("takes a device's statement nowhere but the device's path", () =>
      Effect.gen(function* () {
        const port = yield* portOf;
        expect(yield* upgrade(port, "/ws", forwarded(deviceKey()))).toBe(403);
      }),
    );

    it.effect("refuses a dial whose signature isn't the device's", () =>
      Effect.gen(function* () {
        const port = yield* portOf;
        const key = deviceKey();
        const headers = { ...forwarded(key), [DEVICE_SIGNATURE_HEADER]: "A".repeat(86) };
        expect(yield* upgrade(port, `${DEVICE_CONNECT_PATH}?workspace=${WORKSPACE}`, headers)).toBe(
          401,
        );
      }),
    );

    it.effect("connects a device whose dial is signed for the front's statement", () =>
      Effect.gen(function* () {
        const port = yield* portOf;
        const key = deviceKey();
        yield* dialAsDevice(
          port,
          `${DEVICE_CONNECT_PATH}?workspace=${WORKSPACE}`,
          forwarded(key),
          key.id,
        );
        yield* waitReal(
          "the device connected",
          Effect.sync(() =>
            sunk.some(
              (event) => event.type === "device.connected" && event.data["deviceId"] === key.id,
            ),
          ),
        );
      }),
    );

    it.effect("lists the device's tools to sessions that aren't a worker's", () =>
      Effect.gen(function* () {
        const registry = yield* AppToolRegistry;
        const names = (audience: "plain" | "orchestrator" | "worker") =>
          registry
            .forTransport(ThreadId.make("t-any"), audience)
            .map((tool) => tool.descriptor.name)
            .filter((name) => name.startsWith("device_"));
        const all = ["device_list_files", "device_read_file", "device_run"];
        expect(names("plain")).toEqual(all);
        expect(names("orchestrator")).toEqual(all);
        expect(names("worker")).toEqual([]);
      }),
    );
  });

  layer(server(false), { excludeTestServices: true })("with no decision hook", (it) => {
    it.effect("is refused: no device is reached ungoverned", () =>
      Effect.gen(function* () {
        const port = yield* portOf;
        expect(
          yield* upgrade(
            port,
            `${DEVICE_CONNECT_PATH}?workspace=${WORKSPACE}`,
            forwarded(deviceKey()),
          ),
        ).toBe(403);
      }),
    );
  });
});
