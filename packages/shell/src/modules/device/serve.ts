import { type DeviceExecEvent, type DeviceHello, DeviceRpcs } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as NetAddress from "effect/net/NetAddress";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import type * as Socket from "effect/socket/Socket";
import * as SocketServer from "effect/socket/SocketServer";
import type { DeviceGate } from "./gate.ts";

/**
 * Serves `DeviceRpcs` on one connection the device dialled: the control plane is the client, and
 * everything it asks goes through the gate. The connection is the device's to end: on a lock, a
 * quit, lending stopping, or a sign-in it can't renew, the caller interrupts this, and every ask
 * and command under way is stopped with it.
 */

export interface DeviceConnection {
  readonly hello: () => DeviceHello;
  readonly gate: DeviceGate;
  /**
   * A fresh access token for this connection, minted from the device's own sign-in. Undefined
   * when it can't be had: the device then closes the connection itself.
   */
  readonly token: () => Promise<string | undefined>;
}

/** Why a served connection ended. */
export type DeviceServeEnd = "closed" | "no-token";

/** How long a fresh token may take before the connection ends without one. */
export const DEVICE_TOKEN_WAIT_MS = 30_000;

/**
 * One token asked for at a time, however many calls ask: they all wait on the same one. A token
 * that doesn't come in time is none.
 */
const sharedToken = (token: () => Promise<string | undefined>, waitMs: number) => {
  let pending: Promise<string | undefined> | undefined;
  return (): Promise<string | undefined> => {
    if (pending !== undefined) return pending;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<undefined>((done) => {
      timer = setTimeout(() => done(undefined), waitMs);
    });
    const next = Promise.race([
      Promise.resolve()
        .then(token)
        .catch(() => undefined),
      late,
    ]).finally(() => {
      clearTimeout(timer);
      pending = undefined;
    });
    pending = next;
    return next;
  };
};

const handlersFor = (
  connection: DeviceConnection,
  end: Deferred.Deferred<DeviceServeEnd>,
  tokenWaitMs: number,
) => {
  const freshToken = sharedToken(connection.token, tokenWaitMs);
  return DeviceRpcs.toLayer(
    DeviceRpcs.of({
      "device.hello": () => Effect.sync(() => connection.hello()),
      "device.exec": (payload) =>
        Stream.callback<DeviceExecEvent>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              let over = false;
              const left = new AbortController();
              void connection.gate
                .exec(
                  payload,
                  (event) => {
                    if (!over) Queue.offerUnsafe(queue, event);
                  },
                  left.signal,
                )
                // The gate answers every refusal as an event; a throw is a bug, and ends the call.
                .catch(() => undefined)
                .finally(() => {
                  over = true;
                  Queue.endUnsafe(queue);
                });
              return left;
            }),
            // The control plane stopped listening (it cancelled the call, or the connection
            // went): the request is taken back, as a `device.cancel` would, once no other call
            // is waiting on it.
            (left) => Effect.sync(() => left.abort()),
          ),
        ),
      // Interrupted, the promise's signal aborts, and the gate takes the request back.
      "device.files.list": (payload) =>
        Effect.promise((left) => connection.gate.list(payload, left)),
      "device.files.read": (payload) =>
        Effect.promise((left) => connection.gate.read(payload, left)),
      "device.cancel": ({ requestId }) => Effect.sync(() => connection.gate.cancel(requestId)),
      "device.token": () =>
        Effect.promise(freshToken).pipe(
          Effect.flatMap((token) =>
            token === undefined
              ? // No answer: the connection ends, and the call with it.
                Deferred.succeed(end, "no-token").pipe(Effect.andThen(Effect.never))
              : Effect.succeed({ accessToken: Redacted.make(token) }),
          ),
        ),
    }),
  );
};

/**
 * Serves until the other end closes the socket or the device can't renew its token. Interrupted,
 * it stops every ask and command under way.
 */
export const serveDevice = (
  socket: Socket.Socket,
  connection: DeviceConnection,
  options: { readonly tokenWaitMs?: number } = {},
): Effect.Effect<DeviceServeEnd> =>
  Effect.gen(function* () {
    const end = yield* Deferred.make<DeviceServeEnd>();
    const oneConnection = Layer.succeed(SocketServer.SocketServer, {
      address: NetAddress.unixPathAddress("device-stream"),
      run: (handler) =>
        handler(socket).pipe(
          Effect.ignore,
          Effect.andThen(Deferred.succeed(end, "closed")),
          Effect.andThen(Effect.never),
        ),
    });
    yield* Layer.build(
      RpcServer.layer(DeviceRpcs).pipe(
        Layer.provide(handlersFor(connection, end, options.tokenWaitMs ?? DEVICE_TOKEN_WAIT_MS)),
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(oneConnection),
        Layer.provide(RpcSerialization.layerNdjson),
      ),
    );
    return yield* Deferred.await(end);
  }).pipe(
    Effect.scoped,
    // However it ends, nothing it started keeps running or waiting on the person.
    Effect.ensuring(Effect.sync(() => connection.gate.stopAll("away"))),
  );
