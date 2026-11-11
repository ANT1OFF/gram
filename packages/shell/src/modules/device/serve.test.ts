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
  /** Requests whose caller stopped listening. */
  const left: Array<string> = [];
  const listing: Array<string> = [];
  /** What happened, in order: callers leaving and everything being stopped. */
  const order: Array<string> = [];
  const leaves = (requestId: string, signal: AbortSignal | undefined) =>
    signal?.addEventListener(
      "abort",
      () => {
        left.push(requestId);
        order.push(`left ${requestId}`);
      },
      { once: true },
    );
  let hold: Promise<void> | undefined;
  let holdList: Promise<void> | undefined;
  const gate: DeviceGate = {
    exec: async (payload, emit, signal) => {
      leaves(payload.requestId, signal);
      emit({ kind: "asked" });
      if (hold !== undefined) await hold;
      emit({ kind: "started" });
      emit({ kind: "output", stream: "stdout", text: `ran ${payload.command}\n` });
      emit({ kind: "exit", code: 0, truncated: false, timedOut: false });
    },
    list: async (payload, signal) => {
      listing.push(payload.requestId);
      leaves(payload.requestId, signal);
      if (holdList !== undefined) await holdList;
      return { kind: "listed", entries: [{ name: "a", kind: "file" }], truncated: false };
    },
    read: async (payload, signal) => {
      listing.push(payload.requestId);
      leaves(payload.requestId, signal);
      if (holdList !== undefined) await holdList;
      return { kind: "refused", why: "credential-path" };
    },
    cancel: (id) => {
      cancelled.push(id);
    },
    idle: async () => undefined,
    stopAll: (why) => {
      stopped.push(why);
      order.push(`stopped ${why}`);
    },
  };
  return {
    gate,
    cancelled,
    stopped,
    left,
    listing,
    order,
    holdUntil: (promise: Promise<void>) => {
      hold = promise;
    },
    holdListUntil: (promise: Promise<void>) => {
      holdList = promise;
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

const connected = (connection: DeviceConnection, options?: { readonly tokenWaitMs?: number }) =>
  Effect.gen(function* () {
    const pair = yield* socketPair;
    const serving = yield* serveDevice(pair.device, connection, options).pipe(Effect.forkScoped);
    const protocol = yield* RpcClient.makeProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
      Effect.provideService(Socket.Socket, pair.server),
      Effect.provide(RpcSerialization.layerNdjson),
    );
    const client = yield* RpcClient.make(DeviceRpcs).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
    );
    return { client, serving, close: pair.close };
  });

/** Waits, on the real clock, for something the other side of the socket does. */
const until = (done: () => boolean) =>
  Effect.promise(async () => {
    for (let i = 0; i < 200 && !done(); i += 1) await new Promise((next) => setTimeout(next, 5));
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
      expect(fake.left).toEqual(["r1"]);
      held.resolve();
    }).pipe(Effect.scoped),
  );

  it.effect("takes a listing back when the control plane stops waiting for it", () =>
    Effect.gen(function* () {
      const fake = fakeGate();
      const held = Promise.withResolvers<void>();
      fake.holdListUntil(held.promise);
      const { client } = yield* connected({
        hello: () => hello,
        gate: fake.gate,
        token: async () => "fresh",
      });
      const listing = yield* client["device.files.list"]({
        ...request("r2"),
        path: ".",
        limit: 10,
      }).pipe(Effect.forkScoped);
      yield* until(() => fake.listing.length > 0);
      yield* Fiber.interrupt(listing);
      yield* until(() => fake.left.length > 0);
      expect(fake.left).toEqual(["r2"]);
      const reading = yield* client["device.files.read"]({
        ...request("r3"),
        path: "README.md",
        maxBytes: 10,
      }).pipe(Effect.forkScoped);
      yield* until(() => fake.listing.length > 1);
      yield* Fiber.interrupt(reading);
      yield* until(() => fake.left.length > 1);
      expect(fake.left).toEqual(["r2", "r3"]);
      held.resolve();
    }).pipe(Effect.scoped),
  );

  it.effect("asks for one token at a time, and ends the connection when none comes in time", () =>
    Effect.gen(function* () {
      const fake = fakeGate();
      let asked = 0;
      const { client, serving } = yield* connected(
        {
          hello: () => hello,
          gate: fake.gate,
          token: () => {
            asked += 1;
            return new Promise<string | undefined>(() => undefined);
          },
        },
        { tokenWaitMs: 50 },
      );
      for (let i = 0; i < 20; i += 1) yield* client["device.token"]().pipe(Effect.forkScoped);
      const end = yield* Fiber.join(serving);
      expect(end).toBe("no-token");
      expect(asked).toBe(1);
      expect(fake.stopped).toEqual(["away"]);
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

  it.effect("stops what waits on the person before the calls end, when the device ends it", () =>
    Effect.gen(function* () {
      const fake = fakeGate();
      const held = Promise.withResolvers<void>();
      fake.holdListUntil(held.promise);
      const { client, serving } = yield* connected({
        hello: () => hello,
        gate: fake.gate,
        token: async () => "fresh",
      });
      yield* client["device.files.list"]({ ...request("r1"), path: ".", limit: 10 }).pipe(
        Effect.forkScoped,
      );
      yield* until(() => fake.listing.length > 0);
      // A lock, a quit or lending stopping: the device interrupts serving.
      yield* Fiber.interrupt(serving);
      expect(fake.order[0]).toBe("stopped away");
      held.resolve();
    }).pipe(Effect.scoped),
  );
});
