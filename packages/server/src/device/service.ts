import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ServerConfig } from "../config.ts";
import { activeDecisionHook } from "../embedding/decision-hook.ts";
import { EventSink } from "../embedding/event-sink.ts";
import type { DeviceCaller } from "../http/fronted-identity.ts";
import { fileNonceStore } from "../host/paired-machines.ts";
import { HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";
import { ReadingAs, SERVER } from "../embedding/readable-by.ts";
import {
  DEVICE_CONNECT_PATH,
  DEVICE_DIAL_NONCE,
  DEVICE_NONCES_FILE,
  type Devices,
  makeDevices,
} from "./devices.ts";

/**
 * The lent devices of the people signed in through the platform in front. There are none unless
 * people sign in that way (`GRAM_IDENTITY_*`): a device's dial is checked against what the front
 * says of it, and with no front there is nobody to say it.
 */
export class LentDevices extends Context.Service<LentDevices, Devices | undefined>()(
  "@gram/server/LentDevices",
) {
  static readonly layer = Layer.effect(
    LentDevices,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      if (config.frontedIdentity === undefined) return undefined;
      const sink = yield* Effect.serviceOption(EventSink);
      const devices = makeDevices({
        nonces: fileNonceStore(config.dataDir, DEVICE_NONCES_FILE, DEVICE_DIAL_NONCE),
        ...(Option.isNone(sink) ? {} : { sink: sink.value }),
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => devices.closeAll("the server stopped")));
      return devices;
    }),
  );
  static readonly off = Layer.succeed(LentDevices, undefined);
}

/**
 * Whether devices may dial in now: only while the decision hook is on, which it is only with
 * hosted features on. A device is never reached ungoverned, so with no hook there are none.
 */
export const devicesOn: Effect.Effect<boolean> = Effect.map(
  activeDecisionHook,
  (hook) => hook !== undefined,
);

const refuse = (message: string, status: number) => HttpServerResponse.text(message, { status });

/**
 * A device's dial, as the front forwarded it with its statement (`caller`): checked, upgraded, and
 * served until it ends. `origin` is the public origin the device signed its dial for.
 */
export const deviceDialIn = (devices: Devices, origin: string, caller: DeviceCaller) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== "GET") return refuse("forbidden", 403);
    if (
      request.headers["upgrade"]?.toLowerCase() !== "websocket" ||
      !/(?:^|,)\s*upgrade\s*(?:,|$)/i.test(request.headers["connection"] ?? "")
    )
      return refuse("WebSocket required", 400);
    if (!(yield* devicesOn)) return refuse("forbidden: devices are off on this server", 403);
    const workspace = new URL(request.url, "http://device.invalid").searchParams.getAll(
      "workspace",
    );
    const admitted = devices.admit(
      origin,
      caller,
      workspace.length === 1 ? (workspace[0] ?? null) : null,
      request.headers,
    );
    if (admitted.kind === "refused") {
      yield* Effect.logInfo("devices: refused a device's dial").pipe(
        Effect.annotateLogs({ status: admitted.status, why: admitted.message }),
      );
      return refuse(admitted.message, admitted.status);
    }
    const socket = yield* request.upgrade.pipe(Effect.option);
    if (Option.isNone(socket)) return refuse("WebSocket required", 400);
    yield* devices.attach(admitted.device, socket.value);
    return HttpServerResponse.empty();
  });

/** What a statement that isn't a device's gets on the device's path. */
export const NOT_A_DEVICE = refuse("forbidden: a device's own dial", 403);

/**
 * A device's statement opens its own dial and nothing else: on any other path, or where nobody
 * signs in through a front, it is refused.
 */
export const deviceStatement = (
  devices: Devices | undefined,
  path: string,
  origin: string,
  caller: DeviceCaller,
) =>
  path !== DEVICE_CONNECT_PATH || devices === undefined
    ? Effect.logWarning("refused a device statement where it has no business").pipe(
        Effect.annotateLogs({ path }),
        Effect.as(refuse("forbidden: not for a device", 403)),
      )
    : Effect.provideService(ReadingAs, SERVER)(deviceDialIn(devices, origin, caller));
