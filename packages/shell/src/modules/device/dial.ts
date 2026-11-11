import { randomBytes, type KeyObject } from "node:crypto";
import {
  DEVICE_ID_HEADER,
  DEVICE_NONCE_HEADER,
  DEVICE_SIGNATURE_HEADER,
  DEVICE_TIME_HEADER,
  type DeviceId,
} from "@gram/contracts";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import { hashAccessToken, signDeviceDial } from "./keys.ts";

/**
 * How a device dials its hosted server: one WebSocket per lent workspace, its headers signed
 * afresh by the device key over the server, the path, the workspace, the person, the device and
 * the token, so a captured set works with nothing else.
 */

/**
 * The address a device dials for one workspace: the discovery document's `device_connect`, which
 * was checked to be on the server's own origin, with the workspace added.
 */
export const deviceConnectUrl = (deviceConnect: string, workspace: string): URL => {
  const url = new URL(deviceConnect);
  url.searchParams.set("workspace", workspace);
  return url;
};

export interface DeviceDialFor {
  /** The server's origin, as the person signed in to it. */
  readonly origin: string;
  readonly url: URL;
  readonly workspace: string;
  /** The signed-in person's subject id, as the server issued it. */
  readonly subject: string;
  readonly deviceId: DeviceId;
  readonly accessToken: string;
  readonly now: number;
}

/** The headers one dial proves itself with. Made for each dial; never reused. */
export const deviceDialHeaders = (key: KeyObject, dial: DeviceDialFor): Record<string, string> => {
  const nonce = randomBytes(16).toString("base64url");
  const signature = signDeviceDial(key, {
    origin: dial.origin,
    path: dial.url.pathname,
    workspace: dial.workspace,
    subject: dial.subject,
    deviceId: dial.deviceId,
    tokenHash: hashAccessToken(dial.accessToken),
    time: dial.now,
    nonce,
  });
  return {
    authorization: `DPoP ${dial.accessToken}`,
    [DEVICE_ID_HEADER]: dial.deviceId,
    [DEVICE_TIME_HEADER]: String(dial.now),
    [DEVICE_NONCE_HEADER]: nonce,
    [DEVICE_SIGNATURE_HEADER]: signature,
  };
};

/**
 * A WebSocket constructor that sends handshake headers, as Node's and Electron's own WebSocket
 * does when it is handed them (the browser's can't). The device's main process dials with this.
 */
export const layerWebSocketWithHeaders = Layer.succeed(Socket.WebSocketConstructor)(
  (url, options) =>
    new globalThis.WebSocket(
      url,
      // Node's WebSocket takes `{ protocols, headers }` where the standard takes protocols only.
      options as unknown as string | Array<string> | undefined,
    ),
);
