import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  DEVICE_ID_HEADER,
  DEVICE_NONCE_HEADER,
  DEVICE_PROTOCOL_VERSION,
  DEVICE_SIGNATURE_HEADER,
  DEVICE_TIME_HEADER,
  type DeviceHello,
  DeviceId,
  DeviceRpcs,
  deviceDialBytes,
} from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Stream from "effect/Stream";
import * as SocketServer from "effect/socket/SocketServer";
import type { SinkRecord } from "../embedding/event-sink.ts";
import type { DeviceCaller } from "../http/fronted-identity.ts";
import { streamPair } from "../host/test-stream.ts";
import type { Socket } from "../platform/unstable.ts";
import { DIALS_PER_PERSON, makeDevices } from "./devices.ts";

const ORIGIN = "https://gram.example.com";
const PATH = "/device/connect";
const WORKSPACE = "w1";
const PERSON = { id: "u-ada", name: "Ada", role: "member" as const };
const NOW = 1_800_000_000_000;

const deviceKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x as string;
  const id = DeviceId.make(
    `d-${createHash("sha256").update(Buffer.from(x, "base64url")).digest("hex").slice(0, 24)}`,
  );
  return { privateKey, publicKey: x, id };
};

interface DialFields {
  readonly origin?: string;
  readonly path?: string;
  readonly workspace?: string;
  readonly subject?: string;
  readonly token?: string;
  readonly signedToken?: string;
  readonly time?: number;
  readonly nonce?: string;
  readonly deviceId?: string;
}

/** The headers a device's dial carries, signed as the desktop app signs them. */
const dialHeaders = (
  key: { readonly privateKey: KeyObject; readonly id: string },
  fields: DialFields = {},
): Record<string, string> => {
  const token = fields.token ?? "access-token-for-the-device";
  const time = fields.time ?? NOW;
  const nonce = fields.nonce ?? randomBytes(16).toString("base64url");
  const deviceId = fields.deviceId ?? key.id;
  const bytes = deviceDialBytes({
    origin: fields.origin ?? ORIGIN,
    path: fields.path ?? PATH,
    workspace: fields.workspace ?? WORKSPACE,
    subject: fields.subject ?? PERSON.id,
    deviceId,
    tokenHash: createHash("sha256")
      .update(fields.signedToken ?? token)
      .digest("hex"),
    time,
    nonce,
  });
  return {
    authorization: `DPoP ${token}`,
    [DEVICE_ID_HEADER]: deviceId,
    [DEVICE_TIME_HEADER]: String(time),
    [DEVICE_NONCE_HEADER]: nonce,
    [DEVICE_SIGNATURE_HEADER]: sign(null, bytes, key.privateKey).toString("base64url"),
  };
};

const callerFor = (publicKey: string, over: Partial<DeviceCaller> = {}): DeviceCaller => ({
  actor: PERSON,
  publicKey,
  workspace: WORKSPACE,
  path: PATH,
  ...over,
});

describe("a device's dial", () => {
  it("takes a dial signed for this origin, path, workspace, person, device and token", () => {
    const key = deviceKey();
    const devices = makeDevices({ now: () => NOW });
    const admitted = devices.admit(ORIGIN, callerFor(key.publicKey), WORKSPACE, dialHeaders(key));
    expect(admitted).toMatchObject({ kind: "ok", device: { deviceId: key.id } });
  });

  it("refuses the same dial a second time", () => {
    const key = deviceKey();
    const devices = makeDevices({ now: () => NOW });
    const headers = dialHeaders(key);
    expect(devices.admit(ORIGIN, callerFor(key.publicKey), WORKSPACE, headers).kind).toBe("ok");
    expect(devices.admit(ORIGIN, callerFor(key.publicKey), WORKSPACE, headers)).toMatchObject({
      kind: "refused",
      message: "unauthorized: dial replayed",
    });
  });

  it.each<[string, DialFields | ((key: ReturnType<typeof deviceKey>) => DialFields)]>([
    ["for another person", { subject: "u-bob" }],
    ["for another origin", { origin: "https://elsewhere.example.com" }],
    ["for another path", { path: "/somewhere/else" }],
    ["for another workspace", { workspace: "w2" }],
    ["with another token than it signed", { signedToken: "a-token-it-signed-for" }],
    ["out of the clock's allowance", { time: NOW - 3 * 60_000 }],
    ["with a nonce of the wrong shape", { nonce: "short" }],
    ["naming another device", { deviceId: "d-000000000000000000000000" }],
  ])("refuses a dial %s", (_, fields) => {
    const key = deviceKey();
    const devices = makeDevices({ now: () => NOW });
    const headers = dialHeaders(key, typeof fields === "function" ? fields(key) : fields);
    expect(devices.admit(ORIGIN, callerFor(key.publicKey), WORKSPACE, headers).kind).toBe(
      "refused",
    );
  });

  it("refuses a dial signed by a key the front didn't register to the person", () => {
    const key = deviceKey();
    const other = deviceKey();
    const devices = makeDevices({ now: () => NOW });
    const headers = dialHeaders(key, { deviceId: other.id });
    expect(devices.admit(ORIGIN, callerFor(other.publicKey), WORKSPACE, headers).kind).toBe(
      "refused",
    );
  });

  it("refuses a dial whose address names another workspace than the front checked", () => {
    const key = deviceKey();
    const devices = makeDevices({ now: () => NOW });
    expect(devices.admit(ORIGIN, callerFor(key.publicKey), "w2", dialHeaders(key))).toMatchObject({
      kind: "refused",
      status: 403,
    });
  });

  it("takes only so many dials of one person's devices at once, and tells them to wait", () => {
    const devices = makeDevices({ now: () => NOW });
    for (let i = 0; i < DIALS_PER_PERSON; i++) {
      const key = deviceKey();
      expect(
        devices.admit(ORIGIN, callerFor(key.publicKey), WORKSPACE, dialHeaders(key)).kind,
      ).toBe("ok");
    }
    const key = deviceKey();
    expect(
      devices.admit(ORIGIN, callerFor(key.publicKey), WORKSPACE, dialHeaders(key)),
    ).toMatchObject({ kind: "refused", status: 503 });
    const other = deviceKey();
    expect(
      devices.admit(
        ORIGIN,
        callerFor(other.publicKey, { actor: { ...PERSON, id: "u-bob" } }),
        WORKSPACE,
        dialHeaders(other, { subject: "u-bob" }),
      ).kind,
    ).toBe("ok");
  });

  it("takes no dial while the history of dials can't be read", () => {
    const key = deviceKey();
    const devices = makeDevices({
      now: () => NOW,
      nonces: {
        read: () => {
          throw new Error("unreadable");
        },
        write: () => {},
      },
    });
    expect(
      devices.admit(ORIGIN, callerFor(key.publicKey), WORKSPACE, dialHeaders(key)),
    ).toMatchObject({ kind: "refused", status: 503 });
  });
});

/** Serves a fake device's `DeviceRpcs` on `socket`: its hello, and nothing it is asked runs. */
const serveFakeDevice = (socket: Socket.Socket, hello: DeviceHello) =>
  Layer.launch(
    RpcServer.layer(DeviceRpcs).pipe(
      Layer.provide(
        DeviceRpcs.toLayer(
          DeviceRpcs.of({
            "device.hello": () => Effect.succeed(hello),
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
  );

const helloOf = (id: DeviceId, over: Partial<DeviceHello> = {}): DeviceHello => ({
  protocol: DEVICE_PROTOCOL_VERSION,
  deviceId: id,
  platform: "darwin",
  capabilities: ["read", "exec"],
  folders: [{ id: "f-0123456789abcdef", label: "gram" }],
  ...over,
});

describe("a device's connection", () => {
  it.live("is online after its hello, owned by the person the front named, until it closes", () =>
    Effect.gen(function* () {
      const key = deviceKey();
      const events: SinkRecord[] = [];
      const devices = makeDevices({
        now: () => NOW,
        sink: {
          record: (event: SinkRecord) => Effect.sync(() => void events.push(event)),
        } as never,
      });
      const admitted = devices.admit(ORIGIN, callerFor(key.publicKey), WORKSPACE, dialHeaders(key));
      if (admitted.kind !== "ok") throw new Error(admitted.message);
      const { host, control } = yield* streamPair;
      const device = yield* Effect.forkScoped(
        serveFakeDevice(yield* NodeSocket.fromDuplex(Effect.succeed(host)), helloOf(key.id)),
      );
      const attached = yield* Effect.forkScoped(
        devices.attach(admitted.device, yield* NodeSocket.fromDuplex(Effect.succeed(control))),
      );
      while (devices.list(WORKSPACE).length === 0) yield* Effect.sleep("10 millis");
      expect(devices.list(WORKSPACE)).toMatchObject([
        { deviceId: key.id, owner: PERSON.id, capabilities: ["read", "exec"] },
      ]);
      expect(devices.ownedBy(PERSON.id, WORKSPACE, key.id)?.deviceId).toBe(key.id);
      expect(devices.ownedBy("u-bob", WORKSPACE, key.id)).toBeUndefined();
      expect(devices.list("w2")).toEqual([]);
      yield* Fiber.interrupt(device);
      host.destroy();
      yield* Fiber.join(attached);
      expect(devices.list(WORKSPACE)).toEqual([]);
      expect(events.map((event) => event.type)).toEqual([
        "device.connected",
        "device.disconnected",
      ]);
      expect(events[0]?.actor).toEqual({ kind: "person", id: PERSON.id });
    }),
  );

  it.live.each<[string, (id: DeviceId) => Partial<DeviceHello>]>([
    ["on another protocol", () => ({ protocol: DEVICE_PROTOCOL_VERSION + 1 })],
    [
      "answering as another device",
      () => ({ deviceId: DeviceId.make("d-111111111111111111111111") }),
    ],
    ["offering nothing", () => ({ capabilities: ["exec"] })],
    [
      "naming one folder twice",
      () => ({
        folders: [
          { id: "f-0123456789abcdef", label: "a" },
          { id: "f-0123456789abcdef", label: "b" },
        ],
      }),
    ],
  ])("is never online %s", ([, over]) =>
    Effect.gen(function* () {
      const key = deviceKey();
      const devices = makeDevices({ now: () => NOW });
      const admitted = devices.admit(ORIGIN, callerFor(key.publicKey), WORKSPACE, dialHeaders(key));
      if (admitted.kind !== "ok") throw new Error(admitted.message);
      const { host, control } = yield* streamPair;
      yield* Effect.forkScoped(
        serveFakeDevice(
          yield* NodeSocket.fromDuplex(Effect.succeed(host)),
          helloOf(key.id, over(key.id)),
        ),
      );
      yield* devices.attach(admitted.device, yield* NodeSocket.fromDuplex(Effect.succeed(control)));
      expect(devices.list(WORKSPACE)).toEqual([]);
    }),
  );

  it.live("ends once devices are turned off on the server", () =>
    Effect.gen(function* () {
      const key = deviceKey();
      let on = true;
      const devices = makeDevices({
        now: () => NOW,
        pingEveryMs: 20,
        allowed: Effect.sync(() => on),
      });
      const admitted = devices.admit(ORIGIN, callerFor(key.publicKey), WORKSPACE, dialHeaders(key));
      if (admitted.kind !== "ok") throw new Error(admitted.message);
      const { host, control } = yield* streamPair;
      yield* Effect.forkScoped(
        serveFakeDevice(yield* NodeSocket.fromDuplex(Effect.succeed(host)), helloOf(key.id)),
      );
      const attached = yield* Effect.forkScoped(
        devices.attach(admitted.device, yield* NodeSocket.fromDuplex(Effect.succeed(control))),
      );
      while (devices.list(WORKSPACE).length === 0) yield* Effect.sleep("5 millis");
      on = false;
      yield* Fiber.join(attached);
      expect(devices.list(WORKSPACE)).toEqual([]);
    }),
  );

  it.live("ends when the device stops answering its pings", () =>
    Effect.gen(function* () {
      const key = deviceKey();
      const done = yield* Deferred.make<void>();
      const devices = makeDevices({ now: () => NOW, pingEveryMs: 20 });
      const admitted = devices.admit(ORIGIN, callerFor(key.publicKey), WORKSPACE, dialHeaders(key));
      if (admitted.kind !== "ok") throw new Error(admitted.message);
      // The device's end, and a relay between it and the control plane that can go silent.
      const { host, control: deviceRelay } = yield* streamPair;
      const { host: controlRelay, control } = yield* streamPair;
      let silent = false;
      deviceRelay.on("data", (chunk: Buffer) => {
        if (!silent) controlRelay.write(chunk);
      });
      controlRelay.on("data", (chunk: Buffer) => deviceRelay.write(chunk));
      yield* Effect.forkScoped(
        serveFakeDevice(yield* NodeSocket.fromDuplex(Effect.succeed(host)), helloOf(key.id)),
      );
      yield* Effect.forkScoped(
        devices
          .attach(admitted.device, yield* NodeSocket.fromDuplex(Effect.succeed(control)))
          .pipe(Effect.andThen(Deferred.succeed(done, undefined))),
      );
      while (devices.list(WORKSPACE).length === 0) yield* Effect.sleep("5 millis");
      silent = true;
      yield* Deferred.await(done);
      expect(devices.list(WORKSPACE)).toEqual([]);
    }),
  );
});
