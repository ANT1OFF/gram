import { sign } from "node:crypto";
import {
  deviceRegistrationBytes,
  HostedDeviceChallenge,
  HostedDeviceRegistered,
  type DeviceId,
} from "@gram/contracts";
import * as Schema from "effect/Schema";
import { deviceIdOf, devicePublicKeyText } from "./keys.ts";
import {
  authorizedCall,
  failed,
  type Failed,
  type HostedCalls,
  jsonOf,
  UNREADABLE,
} from "./hosted.ts";

/**
 * Registers the device's key: the server gives a challenge for this person, the device signs it,
 * and the server answers with the id it derived from the key, which must be the device's own.
 */
export const registerHostedDevice = async (
  calls: HostedCalls & {
    readonly name: string;
    readonly platform: "darwin" | "linux" | "win32";
  },
): Promise<{ readonly ok: true; readonly deviceId: DeviceId } | Failed> => {
  const asked = await authorizedCall(
    calls.keeper,
    calls.key,
    "device:register",
    calls.fetch,
    "POST",
    `${calls.discovery.devices_endpoint}/challenge`,
    {},
  );
  if ("why" in asked) return asked;
  if (asked.status !== 200) return failed("The server refused to register this machine.");
  const challenge = Schema.decodeUnknownOption(HostedDeviceChallenge)(await jsonOf(asked));
  if (challenge._tag === "None") return failed(UNREADABLE);
  const publicKey = devicePublicKeyText(calls.key);
  const signature = sign(
    null,
    deviceRegistrationBytes({
      origin: calls.discovery.issuer,
      subject: calls.keeper.subject,
      publicKey,
      challenge: challenge.value.challenge,
    }),
    calls.key,
  ).toString("base64url");
  const registered = await authorizedCall(
    calls.keeper,
    calls.key,
    "device:register",
    calls.fetch,
    "POST",
    calls.discovery.devices_endpoint,
    {
      publicKey,
      challenge: challenge.value.challenge,
      signature,
      name: [...calls.name].slice(0, 128).join(""),
      platform: calls.platform,
    },
  );
  if ("why" in registered) return registered;
  if (registered.status !== 200 && registered.status !== 201)
    return failed("The server refused to register this machine.");
  const answer = Schema.decodeUnknownOption(HostedDeviceRegistered)(await jsonOf(registered));
  if (answer._tag === "None") return failed(UNREADABLE);
  if (answer.value.deviceId !== deviceIdOf(publicKey))
    return failed("The server registered another key.");
  return { ok: true, deviceId: answer.value.deviceId };
};

/** Forgets the device on the server, as **Sign out** does. Best effort: signing out goes on. */
export const forgetHostedDevice = async (
  calls: HostedCalls & { readonly deviceId: string },
): Promise<boolean> => {
  const response = await authorizedCall(
    calls.keeper,
    calls.key,
    "device:register",
    calls.fetch,
    "DELETE",
    `${calls.discovery.devices_endpoint}/${encodeURIComponent(calls.deviceId)}`,
  );
  if ("why" in response) return false;
  await response.body?.cancel().catch(() => undefined);
  return response.status >= 200 && response.status < 300;
};
