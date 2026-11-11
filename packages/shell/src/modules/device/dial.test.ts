import { DEVICE_NONCE_HEADER, DEVICE_SIGNATURE_HEADER, DEVICE_TIME_HEADER } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { deviceConnectUrl, deviceDialHeaders } from "./dial.ts";
import {
  deviceDialHolds,
  devicePrivateKeyFrom,
  devicePublicKeyFrom,
  generateDeviceKey,
  hashAccessToken,
} from "./keys.ts";

const NOW = 1_800_000_000_000;

describe("a device's dial", () => {
  it("adds the workspace to the address, whatever the address already had", () => {
    expect(deviceConnectUrl("wss://gram.example.com/device/connect", "w1").href).toBe(
      "wss://gram.example.com/device/connect?workspace=w1",
    );
    expect(
      deviceConnectUrl("wss://gram.example.com/device/connect", "a&b=c").searchParams.get(
        "workspace",
      ),
    ).toBe("a&b=c");
  });

  it("signs headers that a server holding the key verifies, and that name nothing else", () => {
    const made = generateDeviceKey();
    const key = devicePrivateKeyFrom(made.privateKeyPem);
    const publicKey = devicePublicKeyFrom(made.publicKey);
    if (publicKey === undefined) throw new Error("no key");
    const url = deviceConnectUrl("wss://gram.example.com/device/connect", "w1");
    const dial = {
      origin: "https://gram.example.com",
      url,
      workspace: "w1",
      subject: "ada",
      deviceId: made.deviceId,
      accessToken: "token-a",
      now: NOW,
    };
    const headers = deviceDialHeaders(key, dial);
    expect(headers.authorization).toBe("DPoP token-a");
    const signed = {
      origin: dial.origin,
      path: url.pathname,
      workspace: "w1",
      subject: "ada",
      deviceId: made.deviceId,
      tokenHash: hashAccessToken("token-a"),
      time: Number(headers[DEVICE_TIME_HEADER]),
      nonce: headers[DEVICE_NONCE_HEADER] ?? "",
    };
    const signature = headers[DEVICE_SIGNATURE_HEADER] ?? "";
    expect(deviceDialHolds(publicKey, signed, signature, NOW)).toBe(true);
    for (const other of [
      { ...signed, tokenHash: hashAccessToken("token-b") },
      { ...signed, workspace: "w2" },
      { ...signed, subject: "bo" },
    ])
      expect(deviceDialHolds(publicKey, other, signature, NOW)).toBe(false);
    expect(deviceDialHeaders(key, dial)[DEVICE_NONCE_HEADER]).not.toBe(signed.nonce);
  });
});
