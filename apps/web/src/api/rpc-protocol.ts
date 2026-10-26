import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import type * as Socket from "effect/socket/Socket";

import type { ConnectionControl } from "./connection";

/** Three quick retries for a brief stall, then doubling to 5 s for a sustained outage. */
export const transportRetryDelay = (attempt: number): number =>
  Math.min(5000, 500 * 2 ** Math.max(0, attempt - 3));

/** The window's RPC transport, waking failed feeds as soon as a socket reconnects. */
export const rpcProtocolLayer = (
  socket: Layer.Layer<Socket.Socket>,
  connection: ConnectionControl,
) =>
  Layer.effect(RpcClient.Protocol)(
    Effect.gen(function* () {
      let attempt = 0;
      const unsubscribe = connection.subscribe(() => {
        // A completed upgrade alone can still be a stalled server. Reset after feeds answer so a sustained
        // outage keeps its backoff instead of restarting the quick retries.
        if (connection.get().status === "open") attempt = 0;
      });
      yield* Scope.addFinalizer(yield* Effect.scope, Effect.sync(unsubscribe));
      // A Ping timeout closes the reader scope (and its socket) before failing old feeds.
      // retryTransientErrors would keep those feeds subscribed to the socket that was closed.
      return yield* RpcClient.makeProtocolSocket({
        retryPolicy: Schedule.fromStep(
          Effect.succeed(() =>
            Effect.sync(() => {
              const delay = transportRetryDelay(++attempt);
              return [delay, Duration.millis(delay)] as [number, Duration.Duration];
            }),
          ),
        ),
      });
    }),
  ).pipe(
    Layer.provide(socket),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(
      Layer.succeed(RpcClient.ConnectionHooks)({
        onConnect: Effect.sync(() => connection.retryNow()),
        onDisconnect: Effect.void,
      }),
    ),
  );
