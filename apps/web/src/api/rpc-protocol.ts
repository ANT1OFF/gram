import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import type * as Socket from "effect/socket/Socket";

import type { ConnectionControl } from "./connection";
import { type PageVisibility, visibleTimeClock } from "./visible-clock";

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
 * moment to dial, not up to 5 s later. Its heartbeat counts only the time `page` is shown, so a
 * hidden tab's late timers never drop the socket.
 */
export const rpcProtocolLayer = (
  socket: Layer.Layer<Socket.Socket>,
  connection: ConnectionControl,
  wake: WakeSource = backInTouch,
  page: PageVisibility | undefined = typeof document === "undefined" ? undefined : document,
) =>
  Layer.effect(RpcClient.Protocol)(
    Effect.gen(function* () {
      let attempt = 0;
      const unsubscribe = connection.subscribe(() => {
        if (connection.get().status === "open") attempt = 0;
      });
      const scope = yield* Effect.scope;
      yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe));
      const visible = page === undefined ? undefined : visibleTimeClock(yield* Clock.Clock, page);
      if (visible !== undefined) yield* Scope.addFinalizer(scope, Effect.sync(visible.stop));
      return yield* RpcClient.makeProtocolSocket({
        retryPolicy: Schedule.fromStep(
          Effect.succeed(() =>
            Effect.suspend(() => {
              const delay = transportRetryDelay(++attempt);
              return Effect.map(
                redialWait(delay - 1, wake),
                (woken) => [delay, Duration.millis(woken ? 0 : 1)] as [number, Duration.Duration],
              );
            }),
          ),
        ),
      }).pipe(
        visible === undefined
          ? (protocol) => protocol
          : Effect.provideService(Clock.Clock, visible.clock),
      );
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
