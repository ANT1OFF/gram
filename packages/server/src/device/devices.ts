import {
  DEVICE_ID_HEADER,
  DEVICE_NONCE_HEADER,
  DEVICE_PROTOCOL_VERSION,
  DEVICE_SIGNATURE_HEADER,
  DEVICE_TIME_HEADER,
  type DeviceHello,
  type DeviceId,
  DeviceRpcs,
} from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { Socket } from "../platform/unstable.ts";
import type { EventSinkShape } from "../embedding/event-sink.ts";
import type { DeviceCaller } from "../http/fronted-identity.ts";
import { makeDialNonceRecord } from "../host/dial-nonce-record.ts";
import { type DialNonceStore, memoryNonceStore } from "../host/paired-machines.ts";
import { socketEndText, watchedSocket } from "../host/socket-end.ts";
import { deviceDialHolds, deviceDialTime, deviceIdOf, hashAccessToken } from "./keys.ts";

/**
 * The control plane's side of a personal device (`docs/design/personal-device.md`): the lent
 * machines of the people signed in through the platform in front, each dialled in for one
 * workspace. A device is never a host: nothing is placed on it, and the only calls this side can
 * make are `DeviceRpcs`'. What it holds of a device is what the front said (whose it is, its key,
 * the workspace) and what the device's hello said (its capabilities and the labels of its folders).
 */

/** Where the front sends a device's dial, once it has checked the person and their device. */
export const DEVICE_CONNECT_PATH = "/device/connect";

/** A device's dial nonce: 16 random bytes, base64url. */
export const DEVICE_DIAL_NONCE = /^[A-Za-z0-9_-]{22}$/;

/** The file a device's dial nonces are kept in, beside the machines'. */
export const DEVICE_NONCES_FILE = "device-dial-nonces.json";

const NONCES_KEPT = 4096;
const DIALS_PER_DEVICE = 12;
const NONCE_SKEW_MS = 2 * 60_000;
const ACCESS_TOKEN = /^DPoP ([\x21-\x7e]{16,4096})$/;

/** How often the control plane pings a device, and how many it may miss before it is offline. */
export const DEVICE_PING_EVERY_MS = 5_000;
export const DEVICE_PINGS_MISSED = 4;
const HELLO_TIMEOUT = Duration.seconds(5);

/**
 * How long one connection lasts. The device's token for it lives at most 15 minutes, and the front
 * checked it only at the dial: past that the connection is closed and the device dials again with
 * a fresh token, which the front checks again, so a revoked sign-in or device loses its connection
 * within this.
 */
export const DEVICE_CONNECTION_MOST_MS = 15 * 60_000;

/** A dial the front sent and this side checked, not yet connected. */
export interface AdmittedDevice {
  readonly deviceId: DeviceId;
  readonly caller: DeviceCaller;
}

export type DeviceAdmission =
  | { readonly kind: "ok"; readonly device: AdmittedDevice }
  | { readonly kind: "refused"; readonly status: 401 | 403 | 503; readonly message: string };

const makeClient = Effect.fnUntraced(function* (
  socket: Socket.Socket,
  pingEveryMs: number,
  silent: Effect.Effect<void>,
) {
  const protocol = yield* RpcClient.makeProtocolSocket({
    retryPolicy: Schedule.recurs(0),
    pingInterval: Duration.millis(pingEveryMs),
    pingTimeout: Duration.millis(pingEveryMs * DEVICE_PINGS_MISSED),
    onPingTimeout: silent,
  }).pipe(
    Effect.provideService(Socket.Socket, socket),
    Effect.provide(RpcSerialization.layerNdjson),
  );
  return yield* RpcClient.make(DeviceRpcs).pipe(
    Effect.provideService(RpcClient.Protocol, protocol),
  );
});

/** The calls a connected device serves, and nothing else. */
export type DeviceClient = Effect.Success<ReturnType<typeof makeClient>>;

/** A device that is dialled in now. */
export interface OnlineDevice {
  readonly deviceId: DeviceId;
  /** Whose it is: the person the front named at the dial, never what the device says. */
  readonly owner: DeviceCaller["actor"];
  readonly workspace: string;
  readonly hello: DeviceHello;
  readonly since: number;
  readonly client: DeviceClient;
}

/** What is said of a device to anyone but its own requests: no client, no key. */
export interface DeviceSummary {
  readonly deviceId: DeviceId;
  readonly owner: string;
  readonly workspace: string;
  readonly platform: DeviceHello["platform"];
  readonly capabilities: DeviceHello["capabilities"];
  readonly folders: DeviceHello["folders"];
  readonly since: number;
}

export interface DevicesOptions {
  readonly now?: () => number;
  readonly nonces?: DialNonceStore;
  readonly sink?: EventSinkShape;
  readonly pingEveryMs?: number;
  readonly connectionMostMs?: number;
}

/** Why a hello can't be taken, or undefined when it can. */
export const helloProblem = (hello: DeviceHello, deviceId: DeviceId): string | undefined => {
  if (hello.protocol !== DEVICE_PROTOCOL_VERSION)
    return `The device speaks protocol ${hello.protocol}; this server speaks ${DEVICE_PROTOCOL_VERSION}.`;
  if (hello.deviceId !== deviceId) return "The device answered as another device.";
  if (!hello.capabilities.includes("read")) return "The device offered nothing.";
  if (new Set(hello.capabilities).size !== hello.capabilities.length)
    return "The device said a capability twice.";
  if (new Set(hello.folders.map((folder) => folder.id)).size !== hello.folders.length)
    return "The device named a folder twice.";
  return undefined;
};

const keyOf = (deviceId: string, workspace: string) => `${deviceId}\u0000${workspace}`;

const refused = (status: 401 | 403 | 503, message: string): DeviceAdmission => ({
  kind: "refused",
  status,
  message,
});

export const makeDevices = (options: DevicesOptions = {}) => {
  const now = options.now ?? Date.now;
  const pingEveryMs = options.pingEveryMs ?? DEVICE_PING_EVERY_MS;
  const connectionMostMs = options.connectionMostMs ?? DEVICE_CONNECTION_MOST_MS;
  const dials = makeDialNonceRecord(options.nonces ?? memoryNonceStore(), now, {
    skewMs: NONCE_SKEW_MS,
    most: NONCES_KEPT,
    perKey: DIALS_PER_DEVICE,
  });
  const online = new Map<string, { device: OnlineDevice; close: (why: string) => void }>();
  const record = (event: Parameters<EventSinkShape["record"]>[0]) =>
    options.sink === undefined ? Effect.void : options.sink.record(event);

  const admit = (
    origin: string,
    caller: DeviceCaller,
    workspace: string | null,
    headers: Readonly<Record<string, string | undefined>>,
  ): DeviceAdmission => {
    const deviceId = deviceIdOf(caller.publicKey);
    if (deviceId === undefined) return refused(401, "unauthorized: not a device's key");
    if (headers[DEVICE_ID_HEADER] !== deviceId)
      return refused(401, "unauthorized: another device's dial");
    if (workspace !== caller.workspace)
      return refused(403, "forbidden: the dial is for another workspace");
    const token = ACCESS_TOKEN.exec(headers["authorization"] ?? "")?.[1];
    const time = deviceDialTime(headers[DEVICE_TIME_HEADER]);
    const nonce = headers[DEVICE_NONCE_HEADER];
    if (token === undefined || time === undefined || nonce === undefined)
      return refused(401, "unauthorized: signed dial required");
    if (!DEVICE_DIAL_NONCE.test(nonce)) return refused(401, "unauthorized: signed dial required");
    const at = now();
    const holds = deviceDialHolds(
      caller.publicKey,
      {
        origin,
        path: caller.path,
        workspace: caller.workspace,
        subject: caller.actor.id,
        deviceId,
        tokenHash: hashAccessToken(token),
        time,
        nonce,
      },
      headers[DEVICE_SIGNATURE_HEADER],
      at,
    );
    if (!holds) return refused(401, "unauthorized: bad signature");
    if (!dials.ready()) return refused(503, "unavailable: dial history unreadable");
    if (dials.stale(time)) return refused(401, "unauthorized: dial out of date");
    const taken = dials.record(deviceId, nonce, time, at);
    if (taken === "stale") return refused(401, "unauthorized: dial out of date");
    if (taken === "replayed") return refused(401, "unauthorized: dial replayed");
    if (taken === "full") return refused(401, "unauthorized: too many dials; wait");
    if (taken === "unsaved") return refused(503, "unavailable: dial couldn't be recorded");
    return { kind: "ok", device: { deviceId, caller } };
  };

  const attach = (admitted: AdmittedDevice, socket: Socket.Socket): Effect.Effect<void> =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deviceId, caller } = admitted;
        const ended = yield* Deferred.make<string>();
        const end = (why: string) => Deferred.doneUnsafe(ended, Exit.succeed(why));
        const watched = watchedSocket(socket, (error) =>
          Effect.sync(() => end(`its connection closed: ${socketEndText(error)}`)),
        );
        const silentSeconds = Math.round((pingEveryMs * DEVICE_PINGS_MISSED) / 1000);
        const client = yield* makeClient(
          watched,
          pingEveryMs,
          Effect.sync(() => end(`nothing from it for ${silentSeconds} seconds`)),
        );
        const hello = yield* client["device.hello"]().pipe(
          Effect.timeoutOrElse({
            duration: HELLO_TIMEOUT,
            orElse: () => Effect.succeed(undefined),
          }),
          Effect.raceFirst(Deferred.await(ended).pipe(Effect.as(undefined))),
          Effect.orElseSucceed(() => undefined),
        );
        const problem =
          hello === undefined ? "it didn't say hello in time" : helloProblem(hello, deviceId);
        if (hello === undefined || problem !== undefined) {
          yield* Effect.logWarning("devices: a device dialled in but didn't connect").pipe(
            Effect.annotateLogs({ deviceId, why: problem }),
          );
          return;
        }
        const key = keyOf(deviceId, caller.workspace);
        online.get(key)?.close("it dialled in again");
        const device: OnlineDevice = {
          deviceId,
          owner: caller.actor,
          workspace: caller.workspace,
          hello,
          since: now(),
          client,
        };
        const entry = { device, close: end };
        online.set(key, entry);
        yield* record({
          type: "device.connected",
          workspaceId: caller.workspace,
          actor: { kind: "person", id: caller.actor.id },
          data: {
            deviceId,
            platform: hello.platform,
            capabilities: [...hello.capabilities],
            folders: hello.folders.map((folder) => folder.label),
          },
        });
        const why = yield* Deferred.await(ended).pipe(
          Effect.raceFirst(
            Effect.sleep(Duration.millis(connectionMostMs)).pipe(
              Effect.as("its connection reached its most; it dials again"),
            ),
          ),
        );
        if (online.get(key) === entry) online.delete(key);
        yield* record({
          type: "device.disconnected",
          workspaceId: caller.workspace,
          actor: { kind: "person", id: caller.actor.id },
          data: { deviceId, why },
        });
      }),
    );

  const summary = ({ device }: { device: OnlineDevice }): DeviceSummary => ({
    deviceId: device.deviceId,
    owner: device.owner.id,
    workspace: device.workspace,
    platform: device.hello.platform,
    capabilities: device.hello.capabilities,
    folders: device.hello.folders,
    since: device.since,
  });

  return {
    /**
     * Checks a dial the front sent: the device it names is the key the front registered to this
     * person, it is for the workspace the front checked, and its signature covers this origin, the
     * path the device dialled, the workspace, the person, the device, the token it carries, a time
     * within the skew and a nonce never seen. A dishonest front can name any key; this guards
     * against a stolen token or a replayed dial, not against the front.
     */
    admit,
    /**
     * Serves one admitted device's connection until it ends: its socket closes, it misses its
     * pings, it dials again (the newer connection wins), the connection reaches its most, or
     * `closeAll` runs. It is online only between a hello this side can take and that end.
     */
    attach,
    /** The devices dialled in for `workspace`. */
    list: (workspace: string): ReadonlyArray<DeviceSummary> =>
      [...online.values()].filter((entry) => entry.device.workspace === workspace).map(summary),
    /**
     * `owner`'s device dialled in for `workspace`, for a request on their behalf. Another
     * person's device is never found this way, whatever is asked.
     */
    ownedBy: (owner: string, workspace: string, deviceId: string): OnlineDevice | undefined => {
      const entry = online.get(keyOf(deviceId, workspace));
      return entry !== undefined && entry.device.owner.id === owner ? entry.device : undefined;
    },
    /** Ends every connection, as hosted features turning off or the server stopping does. */
    closeAll: (why: string) => {
      for (const entry of online.values()) entry.close(why);
    },
  };
};

export type Devices = ReturnType<typeof makeDevices>;
