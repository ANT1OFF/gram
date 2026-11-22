import { createHash, createPublicKey, type KeyObject, verify } from "node:crypto";
import { DEVICE_CLOCK_SKEW_MS, type DeviceDial, DeviceId, deviceDialBytes } from "@gram/contracts";

const SMALL_ORDER = new Set(
  [
    ["01", "00", "00"],
    ["01", "00", "80"],
    ["00", "00", "00"],
    ["00", "00", "80"],
    ["ec", "ff", "7f"],
    ["ec", "ff", "ff"],
    ["ed", "ff", "7f"],
    ["ed", "ff", "ff"],
    ["ee", "ff", "7f"],
    ["ee", "ff", "ff"],
  ]
    .map(([first, middle, last]) => `${first}${(middle ?? "").repeat(30)}${last}`)
    .concat([
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    ]),
);

/**
 * A device's public key from its text (raw 32 bytes, base64url), spelled as the desktop app spells
 * it (`packages/shell/src/modules/device/keys.ts`); undefined for anything else.
 */
export const devicePublicKeyFrom = (text: unknown): KeyObject | undefined => {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(text)) return undefined;
  if (SMALL_ORDER.has(Buffer.from(text, "base64url").toString("hex"))) return undefined;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: text }, format: "jwk" });
    const jwk = key.export({ format: "jwk" });
    return jwk.kty === "OKP" && jwk.crv === "Ed25519" && jwk.x === text ? key : undefined;
  } catch {
    return undefined;
  }
};

/** A device's id: a hash of its public key's 32 bytes, as the device derives it. */
export const deviceIdOf = (publicKey: string): DeviceId | undefined => {
  if (devicePublicKeyFrom(publicKey) === undefined) return undefined;
  const raw = Buffer.from(publicKey, "base64url");
  return DeviceId.make(`d-${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`);
};

/** SHA-256 of an access token, hex: what a dial's signature names it by. */
export const hashAccessToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const verifyText = (key: KeyObject, bytes: Uint8Array, signature: unknown): boolean => {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try {
    const raw = Buffer.from(signature, "base64url");
    if (raw.toString("base64url") !== signature) return false;
    return verify(null, bytes, key, raw);
  } catch {
    return false;
  }
};

/**
 * Whether a dial was signed by the key `publicKey` names, for exactly these fields, by the device
 * that key is, within the clock's allowance. The caller still refuses a nonce it has seen.
 */
export const deviceDialHolds = (
  publicKey: string,
  dial: DeviceDial,
  signature: unknown,
  now: number,
): boolean => {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(dial.time)) return false;
  if (Math.abs(now - dial.time) > DEVICE_CLOCK_SKEW_MS) return false;
  const key = devicePublicKeyFrom(publicKey);
  if (key === undefined || deviceIdOf(publicKey) !== dial.deviceId) return false;
  return verifyText(key, deviceDialBytes(dial), signature);
};

/** A dial's time as its header carries it: thirteen digits and nothing else. */
export const deviceDialTime = (header: unknown): number | undefined =>
  typeof header === "string" && /^\d{13}$/.test(header) ? Number(header) : undefined;
