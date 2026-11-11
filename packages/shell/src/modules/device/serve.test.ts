import { type DeviceExecEvent, type DeviceHello, DeviceRpcs } from "@gram/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import type { DeviceGate, ExecPayload } from "./gate.ts";
import { type DeviceConnection, serveDevice } from "./serve.ts";

/** Two sockets joined back to back, as a dial would join the device and the control plane. */
const socketPair = Effect.gen(function* () {
  const ends: Array<TransformStreamDefaultController<Uint8Array>> = [];
  const pipe = () =>
    new TransformStream<Uint8Array, Uint8Array>({
      start: (controller) => {
        ends.push(controller);
      },
    });
  const there = pipe();
  const back = pipe();
  const device = yield* Socket.fromTransformStream(
    Effect.succeed({ readable: there.readable, writable: back.writable }),
  );
  const server = yield* Socket.fromTransformStream(
    Effect.succeed({ readable: back.readable, writable: there.writable }),
  );
  // Both directions end, as a closed connection's do.
  const close = () => {
    for (const end of ends) end.terminate();
  };
  return { device, server, close };
});

const hello: DeviceHello = {
  protocol: 1,
  deviceId: "d-0123456789abcdef01234567" as DeviceHello["deviceId"],
  platform: "linux",
  capabilities: ["read", "exec"],
  folders: [{ id: "f-0123456789abcdef", label: "app" }],
};

/** A gate that records what reached it and answers as told. */
const fakeGate = () => {
  const cancelled: Array<string> = [];
  const stopped: Array<string> = [];
  let hold: Promise<void> | undefined;
  const gate: DeviceGate = {
    exec: async (payload, emit) => {
      emit({ kind: "asked" });
      if (hold !== undefined) await hold;
      emit({ kind: "started" });
      emit({ kind: "output", stream: "stdout", text: `ran ${payload.command}\n` });
      emit({ kind: "exit", code: 0, truncated: false, timedOut: false });
    },
    list: async () => ({
      kind: "listed",
      entries: [{ name: "a", kind: "file" }],
      truncated: false,
    }),
    read: async () => ({ kind: "refused", why: "credential-path" }),
    cancel: (id) => {
      cancelled.push(id);
    },
    stopAll: (why) => {
      stopped.push(why);
    },
  };
  return {
    gate,
    cancelled,
    stopped,
    holdUntil: (promise: Promise<void>) => {
      hold = promise;
    },
  };
};

const request = (requestId: string): ExecPayload => ({
  requestId,
  grant: {
    grant: {
      v: 1,
      origin: "https://gram.example.com",
      workspace: "w1",
      thread: "t1",
      nonce: "bm9uY2Vub25jZW5vbmNl",
      issuedAt: 0,
      expiresAt: 600_000,
    },
    signature: "A".repeat(86),
  },
  thread: { id: "t1", title: "Fix the build" },
  actor: { id: "ada", name: "Ada" },
  folderId: "f-0123456789abcdef",
  command: "npm test",
});

const connected = (connection: DeviceConnection) =>
  Effect.gen(function* () {
    const pair = yield* socketPair;
    const serving = yield* serveDevice(pair.device, connection).pipe(Effect.forkScoped);
    const protocol = yield* RpcClient.makeProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
      Effect.provideService(Socket.Socket, pair.server),
      Effect.provide(RpcSerialization.layerNdjson),
    );
    const client = yield* RpcClient.make(DeviceRpcs).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
    );
    return { client, serving, close: pair.close };
  });

describe("serving a device", () => {
  it.effect("says hello, and runs, lists and reads through the gate", () =>
    Effect.gen(function* () {
      const fake = fakeGate();
      const { client } = yield* connected({
        hello: () => hello,
        gate: fake.gate,
        token: async () => "fresh",
      });
      expect(yield* client["device.hello"]()).toEqual(hello);
      const events = yield* client["device.exec"](request("r1")).pipe(Stream.runCollect);
      expect([...events].map((event: DeviceExecEvent) => event.kind)).toEqual([
        "asked",
        "started",
        "output",
        "exit",
      ]);
      const listed = yield* client["device.files.list"]({ ...request("r2"), path: "", limit: 5 });
      expect(listed).toMatchObject({ kind: "listed" });
      const read = yield* client["device.files.read"]({
        ...request("r3"),
        path: ".env",
        maxBytes: 5,
      });
      expect(read).toEqual({ kind: "refused", why: "credential-path" });
      yield* client["device.cancel"]({ requestId: "r9" });
      expect(fake.cancelled).toEqual(["r9"]);
      const token = yield* client["device.token"]();
      expect(Redacted.value(token.accessToken)).toBe("fresh");
    }).pipe(Effect.scoped),
  );

  it.effect("takes a command back when the control plane stops listening to it", () =>
    Effect.gen(function* () {
      const fake = fakeGate();
      const held = Promise.withResolvers<void>();
      fake.holdUntil(held.promise);
      const { client } = yield* connected({
        hello: () => hello,
        gate: fake.gate,
        token: async () => "fresh",
      });
      const listening = yield* client["device.exec"](request("r1")).pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      expect([...listening]).toEqual([{ kind: "asked" }]);
      // Taking one event and stopping is the control plane cancelling the call.
      expect(fake.cancelled).toEqual(["r1"]);
      held.resolve();
    }).pipe(Effect.scoped),
  );

  it.effect("closes the connection itself when it can't renew its token", () =>
    Effect.gen(function* () {
      const fake = fakeGate();
      const { client, serving } = yield* connected({
        hello: () => hello,
        gate: fake.gate,
        token: async () => undefined,
      });
      yield* client["device.token"]().pipe(Effect.forkScoped);
      expect(yield* Fiber.join(serving)).toBe("no-token");
      expect(fake.stopped).toEqual(["away"]);
    }).pipe(Effect.scoped),
  );

  it.effect("ends, stopping everything under way, when the other side closes", () =>
    Effect.gen(function* () {
      const fake = fakeGate();
      const { client, serving, close } = yield* connected({
        hello: () => hello,
        gate: fake.gate,
        token: async () => "fresh",
      });
      yield* client["device.hello"]();
      close();
      expect(yield* Fiber.join(serving)).toBe("closed");
      expect(fake.stopped).toEqual(["away"]);
    }).pipe(Effect.scoped),
  );

  it.effect("stops everything under way when the device ends the connection", () =>
    Effect.gen(function* () {
      const fake = fakeGate();
      const { client, serving } = yield* connected({
        hello: () => hello,
        gate: fake.gate,
        token: async () => "fresh",
      });
      yield* client["device.hello"]();
      yield* Fiber.interrupt(serving);
      expect(fake.stopped).toEqual(["away"]);
    }).pipe(Effect.scoped),
  );
});
