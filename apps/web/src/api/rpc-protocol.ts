import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import type * as Socket from "effect/socket/Socket";

import type { ConnectionControl } from "./connection";

/**
 * The first redial is at once: a socket that drops on a phone changing networks or waking is
 * usually back by then, and half a second of waiting was most of a reconnect on a good link. Then
 * two quick retries for a brief stall, doubling to 5 s for a sustained outage.
 */
export const transportRetryDelay = (attempt: number): number =>
  attempt <= 1 ? FIRST_REDIAL_MS : Math.min(5000, 500 * 2 ** Math.max(0, attempt - 3));
const FIRST_REDIAL_MS = 50;

/**
 * Calls `back` when the window says the network or the person is back: the browser's `online`, or
 * the page shown again as a phone wakes or a tab comes forward. Returns what stops listening.
 */
export type WakeSource = (back: () => void) => () => void;
export const backInTouch: WakeSource = (back) => {
  if (typeof window === "undefined") return () => {};
  const shown = () => {
    if (document.visibilityState === "visible") back();
  };
  window.addEventListener("online", back);
  document.addEventListener("visibilitychange", shown);
  return () => {
    window.removeEventListener("online", back);
    document.removeEventListener("visibilitychange", shown);
  };
};

/** Waits `ms`, or until `wake` says the window is back, whichever is first; true when woken. */
const redialWait = (ms: number, wake: WakeSource) =>
  Effect.callback<boolean>((resume) => {
    let stop: (() => void) | undefined;
    const end = () => {
      clearTimeout(timer);
      stop?.();
    };
    const done = (woken: boolean) => {
      end();
      resume(Effect.succeed(woken));
    };
    const timer = setTimeout(() => done(false), ms);
    stop = wake(() => done(true));
    return Effect.sync(end);
  });

/**
 * The window's RPC transport, waking failed feeds as soon as a socket reconnects. A redial's wait
 * ends early on `wake`: after a long outage the backoff is 5 s, and the network coming back is the
 * moment to dial, not up to 5 s later.
 */
export const rpcProtocolLayer = (
  socket: Layer.Layer<Socket.Socket>,
  connection: ConnectionControl,
  wake: WakeSource = backInTouch,
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
            // All but the last millisecond of the wait is here and not in the schedule's own
            // delay, so `wake` can end it; the schedule sleeps the rest, or nothing once woken.
            Effect.suspend(() => {
              const delay = transportRetryDelay(++attempt);
              return Effect.map(
                redialWait(delay - 1, wake),
                (woken) => [delay, Duration.millis(woken ? 0 : 1)] as [number, Duration.Duration],
              );
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
