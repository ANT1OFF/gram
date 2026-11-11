import type { KeyObject } from "node:crypto";
import {
  DEVICE_PROTOCOL_VERSION,
  type DeviceCapability,
  type DeviceHello,
  type DeviceId,
  type HostedDiscovery,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import { deviceConnectUrl, deviceDialHeaders, layerWebSocketWithHeaders } from "./dial.ts";
import {
  type DeviceGate,
  type DeviceGateOptions,
  type GateFolder,
  makeDeviceGate,
} from "./gate.ts";
import type { GrantLedger } from "./grants.ts";
import type { TokenKeeper } from "./hosted.ts";
import type { AskLimits } from "./limits.ts";
import { type DeviceServeEnd, serveDevice } from "./serve.ts";

/**
 * Lending this machine to one hosted server's workspaces: one connection per lent workspace,
 * dialled with a fresh token and fresh headers each time, served through its own gate, and
 * closed by the device itself: when the person is away or stops lending, when the server is
 * paused, when the sign-in ends, and at the token's expiry unless it was renewed before.
 */

/** A workspace lent now: its folders, and what lending to it allows. */
export interface LentWorkspace {
  readonly id: string;
  readonly folders: ReadonlyMap<string, GateFolder>;
  /** What both the person and the organisation allow: `exec` is left out when either says read. */
  readonly capabilities: ReadonlyArray<DeviceCapability>;
}

/** After the refusals settle, how long they get to reach the server before the hang-up. */
export const LENDING_HANG_UP_GRACE_MS = 100;
/** The longest a hang-up waits for them. */
export const LENDING_HANG_UP_MOST_MS = 1_000;
/** How long a dial may take to open. */
export const LENDING_OPEN_MS = 15_000;
/** Waits between dials that failed, doubling from the first to the most. */
export const LENDING_RETRY_FIRST_MS = 1_000;
export const LENDING_RETRY_MOST_MS = 60_000;

export type Connect = (
  url: URL,
  headers: Readonly<Record<string, string>>,
) => Effect.Effect<Socket.Socket>;

/** The default dial: a WebSocket that sends its handshake headers. */
export const connectWebSocket: Connect = (url, headers) =>
  Socket.makeWebSocket(url.href, { headers, openTimeout: LENDING_OPEN_MS }).pipe(
    Effect.provide(layerWebSocketWithHeaders),
  );

export interface ServerLendingOptions extends Pick<
  DeviceGateOptions,
  "ask" | "environment" | "log" | "personId"
> {
  readonly origin: string;
  readonly discovery: HostedDiscovery;
  readonly key: KeyObject;
  readonly deviceId: DeviceId;
  readonly platform: DeviceHello["platform"];
  readonly keeper: TokenKeeper;
  readonly grants: GrantLedger;
  readonly limits: AskLimits;
  /** The workspaces lent to this server now. */
  readonly workspaces: () => ReadonlyArray<LentWorkspace>;
  /** Lending is on, the screen unlocked and the person at the machine. */
  readonly present: () => boolean;
  /** The wall clock, for what the server reads. */
  readonly now: () => number;
  /**
   * A clock that only goes forward, for when tokens end: the same clock as the keeper's `now`,
   * since a token's `expiresAt` is read by it.
   */
  readonly elapsed: () => number;
  readonly connect?: Connect;
  /** How each connection went, for the lending mark and the activity window. */
  readonly onConnection?: (workspace: string, state: "connected" | "closed") => void;
  readonly retryFirstMs?: number;
}

export interface ServerLending {
  /** Starts a connection for each workspace lent now, and ends the others. Call on any change. */
  readonly sync: () => void;
  /**
   * Ends every connection, with what was waiting on the person refused for `why`. "paused" when
   * the server was paused; "away" for everything else.
   */
  readonly stop: (why: "away" | "paused") => Promise<void>;
  /** The workspaces with a connection under way, dialling or connected. */
  readonly running: () => ReadonlyArray<string>;
}

interface Running {
  gate?: DeviceGate | undefined;
  fiber?: Fiber.Fiber<void> | undefined;
  /** Hanging up: it takes nothing new, and a new connection waits until it has gone. */
  closing?: boolean;
}

/**
 * Lending to one server, for as long as the scope it is made in: closing that scope, as signing
 * out or quitting does, ends every connection.
 */
export const makeServerLending = (
  options: ServerLendingOptions,
): Effect.Effect<ServerLending, never, Scope.Scope> =>
  Effect.gen(function* () {
    const fibers = yield* FiberMap.make<string>();
    const runIn = yield* FiberMap.runtime(fibers)<never>();
    const running = new Map<string, Running>();
    let over = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        over = true;
        running.clear();
      }),
    );
    const connect = options.connect ?? connectWebSocket;
    const first = options.retryFirstMs ?? LENDING_RETRY_FIRST_MS;

    const mayLend = () =>
      options.present() && !options.limits.paused() && !options.keeper.signedOut();

    const lentNow = (id: string) => options.workspaces().find((workspace) => workspace.id === id);

    /** One connection, from the dial to its end. */
    const once = (id: string, entry: Running) =>
      Effect.gen(function* () {
        const held = yield* Effect.promise(() => options.keeper.fresh("device:connect"));
        if (!held.ok) return held.signedOut === true ? "signed-out" : "failed";
        let deadline = held.token.expiresAt;
        const url = deviceConnectUrl(options.discovery.device_connect, id);
        const headers = deviceDialHeaders(options.key, {
          origin: options.origin,
          url,
          workspace: id,
          subject: options.keeper.subject,
          deviceId: options.deviceId,
          accessToken: held.token.accessToken,
          now: options.now(),
        });
        const socket = yield* connect(url, headers);
        // A pause isn't absence: the gate refuses for it by name.
        const lendingHere = () =>
          options.present() &&
          !options.keeper.signedOut() &&
          entry.closing !== true &&
          lentNow(id) !== undefined;
        const gate = makeDeviceGate({
          origin: options.origin,
          workspace: id,
          personId: options.personId,
          folders: () => lentNow(id)?.folders ?? new Map(),
          capabilities: () => (lendingHere() ? (lentNow(id)?.capabilities ?? []) : []),
          present: lendingHere,
          grants: options.grants,
          limits: options.limits,
          ask: options.ask,
          environment: options.environment,
          log: options.log,
          now: options.now,
        });
        entry.gate = gate;
        const hello = (): DeviceHello => {
          const workspace = lentNow(id);
          return {
            protocol: DEVICE_PROTOCOL_VERSION,
            deviceId: options.deviceId,
            platform: options.platform,
            capabilities: [...(workspace?.capabilities ?? [])],
            folders: [...(workspace?.folders ?? new Map()).entries()].map(([folderId, folder]) => ({
              id: folderId,
              label: folder.label,
            })),
          };
        };
        // The device closes the connection itself when the token it last handed over ends.
        const expiry = Effect.gen(function* () {
          for (;;) {
            const left = deadline - options.elapsed();
            if (left <= 0) return "expired" as const;
            yield* Effect.sleep(Math.min(left, 1_000));
          }
        });
        const served = serveDevice(socket, {
          hello,
          gate,
          token: async () => {
            const renewed = await options.keeper.fresh("device:connect");
            if (!renewed.ok) return undefined;
            deadline = renewed.token.expiresAt;
            return renewed.token.accessToken;
          },
        }).pipe(Effect.onExit(() => Effect.sync(() => options.onConnection?.(id, "closed"))));
        options.onConnection?.(id, "connected");
        const started = options.elapsed();
        const end: DeviceServeEnd | "expired" = yield* Effect.raceFirst(served, expiry);
        entry.gate = undefined;
        if (end === "no-token" && options.keeper.signedOut()) return "signed-out";
        return options.elapsed() - started > LENDING_RETRY_MOST_MS ? "lasted" : "failed";
      }).pipe(Effect.scoped);

    /** Dials again after each end, waiting longer each time it fails, until lending stops. */
    const loop = (id: string, entry: Running) =>
      Effect.gen(function* () {
        let wait = first;
        for (;;) {
          if (!mayLend() || lentNow(id) === undefined) return;
          const end = yield* once(id, entry).pipe(
            Effect.catchCause(() => Effect.succeed("failed" as const)),
          );
          if (end === "signed-out") return;
          if (end === "lasted") wait = first;
          yield* Effect.sleep(wait);
          wait = Math.min(wait * 2, LENDING_RETRY_MOST_MS);
        }
      });

    const end = async (id: string, why: "away" | "paused") => {
      const entry = running.get(id);
      if (entry === undefined || entry.closing === true) return;
      entry.closing = true;
      // The reason first, so what waits on the person is refused for it, not for the hang-up, and
      // a moment for the refusals to reach the server before the connection goes.
      const gate = entry.gate;
      if (gate !== undefined) {
        gate.stopAll(why);
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          gate
            .idle()
            .then(() => new Promise((later) => setTimeout(later, LENDING_HANG_UP_GRACE_MS))),
          new Promise((later) => {
            timer = setTimeout(later, LENDING_HANG_UP_MOST_MS);
          }),
        ]);
        clearTimeout(timer);
      }
      // This connection's own fiber: one started since for the same workspace is left alone.
      if (entry.fiber !== undefined) await Effect.runPromise(Fiber.interrupt(entry.fiber));
      if (running.get(id) === entry) running.delete(id);
      // Lent again while it hung up: it is dialled now.
      sync();
    };

    const sync = () => {
      if (over) return;
      if (!options.present()) options.grants.withdraw({ origin: options.origin });
      const lent = new Set(mayLend() ? options.workspaces().map((workspace) => workspace.id) : []);
      for (const id of running.keys())
        if (!lent.has(id)) void end(id, options.limits.paused() ? "paused" : "away");
      for (const id of lent) {
        if (running.has(id)) continue;
        const entry: Running = {};
        running.set(id, entry);
        entry.fiber = runIn(
          id,
          loop(id, entry).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (running.get(id) === entry && entry.closing !== true) running.delete(id);
              }),
            ),
          ),
        );
      }
    };

    return {
      sync,
      stop: async (why) => {
        if (why === "away") options.grants.withdraw({ origin: options.origin });
        await Promise.all([...running.keys()].map((id) => end(id, why)));
      },
      running: () =>
        [...running.entries()].filter(([, entry]) => entry.closing !== true).map(([id]) => id),
    } satisfies ServerLending;
  });
