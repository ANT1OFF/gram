import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import {
  DEVICE_CLOCK_SKEW_MS,
  DEVICE_GRANT_TTL_MS,
  type DeviceApproval,
  type DeviceDial,
  DeviceId,
  deviceApprovalBytes,
  deviceDialBytes,
  type SignedTurnGrant,
  type TurnGrant,
  turnGrantBytes,
} from "@gram/contracts";

/**
 * A device's identity: an Ed25519 key pair the desktop app makes for one hosted server and one
 * person. The private half stays in the main process and the keychain. The device's id comes from
 * the public half, so no other key can claim it.
 */

/** The raw 32-byte Ed25519 public key, base64url: what a device registers. */
export const devicePublicKeyText = (key: KeyObject): string => {
  const jwk = (key.type === "private" ? createPublicKey(key) : key).export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string")
    throw new Error("Not an Ed25519 key");
  return jwk.x;
};

/** The encodings of Ed25519's points of small order, canonical and not. */
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

/** The public key from its text, or undefined for anything that isn't a 32-byte Ed25519 key. */
export const devicePublicKeyFrom = (text: string): KeyObject | undefined => {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(text)) return undefined;
  // A point of small order verifies a forged signature over anything, so it is no identity.
  if (SMALL_ORDER.has(Buffer.from(text, "base64url").toString("hex"))) return undefined;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: text }, format: "jwk" });
    return devicePublicKeyText(key) === text ? key : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A device's id: a hash of its public key's 32 bytes. Only a key in its one valid spelling has an
 * id, so one key never has two.
 */
export const deviceIdOf = (publicKey: string): DeviceId => {
  if (devicePublicKeyFrom(publicKey) === undefined) throw new Error("Not a device's public key");
  const raw = Buffer.from(publicKey, "base64url");
  return DeviceId.make(`d-${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`);
};

/** A new key pair, the private half as PKCS #8 PEM for the keychain. */
export const generateDeviceKey = (): {
  readonly privateKeyPem: string;
  readonly publicKey: string;
  readonly deviceId: DeviceId;
} => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const text = devicePublicKeyText(publicKey);
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: text,
    deviceId: deviceIdOf(text),
  };
};

export const devicePrivateKeyFrom = (pem: string): KeyObject => {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The device key isn't an Ed25519 key.");
  return key;
};

const signText = (key: KeyObject, bytes: Uint8Array): string =>
  sign(null, bytes, key).toString("base64url");

const verifyText = (key: KeyObject, bytes: Uint8Array, signature: string): boolean => {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try {
    const raw = Buffer.from(signature, "base64url");
    // One spelling per signature: the last character's spare bits must be zero.
    if (raw.toString("base64url") !== signature) return false;
    return verify(null, bytes, key, raw);
  } catch {
    return false;
  }
};

/** A grant for a message the person is sending to `thread` now, signed by the device key. */
export const mintTurnGrant = (
  key: KeyObject,
  to: { readonly origin: string; readonly workspace: string; readonly thread: string },
  now: number,
): SignedTurnGrant => {
  const grant: TurnGrant = {
    v: 1,
    origin: to.origin,
    workspace: to.workspace,
    thread: to.thread,
    nonce: randomBytes(16).toString("base64url"),
    issuedAt: now,
    expiresAt: now + DEVICE_GRANT_TTL_MS,
  };
  return { grant, signature: signText(key, turnGrantBytes(grant)) };
};

/**
 * Whether a request's grant is one this device signed, for this server, workspace and thread, and
 * still in its time. Its lifetime is the device's own constant, whatever the grant says, and a
 * grant issued in the future is refused, so nothing a server sends can stretch one.
 */
export const turnGrantHolds = (
  publicKey: KeyObject,
  signed: SignedTurnGrant,
  expected: { readonly origin: string; readonly workspace: string; readonly thread: string },
  now: number,
): boolean => {
  const { grant } = signed;
  if (grant.v !== 1) return false;
  if (grant.origin !== expected.origin) return false;
  if (grant.workspace !== expected.workspace) return false;
  if (grant.thread !== expected.thread) return false;
  if (grant.expiresAt !== grant.issuedAt + DEVICE_GRANT_TTL_MS) return false;
  // A clock that isn't a number proves nothing, and neither comparison below would refuse it.
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(grant.issuedAt)) return false;
  if (grant.issuedAt < 0 || !(now >= grant.issuedAt && now < grant.expiresAt)) return false;
  return verifyText(publicKey, turnGrantBytes(grant), signed.signature);
};

export const hashAccessToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

/** A dial's signature, base64url. */
export const signDeviceDial = (key: KeyObject, dial: DeviceDial): string =>
  signText(key, deviceDialBytes(dial));

/**
 * Whether a dial was signed by `publicKey` for exactly these fields, by the device that key
 * names, within the clock's allowance. The caller still has to refuse a nonce it has seen.
 */
export const deviceDialHolds = (
  publicKey: KeyObject,
  dial: DeviceDial,
  signature: string,
  now: number,
): boolean => {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(dial.time)) return false;
  if (Math.abs(now - dial.time) > DEVICE_CLOCK_SKEW_MS) return false;
  let text: string;
  try {
    text = devicePublicKeyText(publicKey);
    if (deviceIdOf(text) !== dial.deviceId) return false;
  } catch {
    return false;
  }
  return verifyText(publicKey, deviceDialBytes(dial), signature);
};

/** A dial's time as its header carries it: thirteen digits and nothing else. */
export const deviceDialTime = (header: unknown): number | undefined =>
  typeof header === "string" && /^\d{13}$/.test(header) ? Number(header) : undefined;

/** The hash an answer is bound to: SHA-256 of everything the ask showed, hex. */
export const approvalHash = (approval: DeviceApproval): string =>
  createHash("sha256").update(deviceApprovalBytes(approval)).digest("hex");

export const sameHash = (a: string, b: string): boolean => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
};
