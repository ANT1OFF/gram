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

/** The public key from its text, or undefined for anything that isn't a 32-byte Ed25519 key. */
export const devicePublicKeyFrom = (text: string): KeyObject | undefined => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return undefined;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: text }, format: "jwk" });
    return devicePublicKeyText(key) === text ? key : undefined;
  } catch {
    return undefined;
  }
};

export const deviceIdOf = (publicKey: string): DeviceId =>
  DeviceId.make(`d-${createHash("sha256").update(publicKey).digest("hex").slice(0, 24)}`);

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
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try {
    return verify(null, bytes, key, Buffer.from(signature, "base64url"));
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
  if (now < grant.issuedAt || now >= grant.expiresAt) return false;
  return verifyText(publicKey, turnGrantBytes(grant), signed.signature);
};

export const hashAccessToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

/** A dial's signature, base64url. */
export const signDeviceDial = (key: KeyObject, dial: DeviceDial): string =>
  signText(key, deviceDialBytes(dial));

/**
 * Whether a dial was signed by `publicKey` for exactly these fields, within the clock's allowance.
 * The caller still has to refuse a nonce it has seen.
 */
export const deviceDialHolds = (
  publicKey: KeyObject,
  dial: DeviceDial,
  signature: string,
  now: number,
): boolean =>
  Math.abs(now - dial.time) <= DEVICE_CLOCK_SKEW_MS &&
  verifyText(publicKey, deviceDialBytes(dial), signature);

/** The hash an answer is bound to: SHA-256 of everything the ask showed, hex. */
export const approvalHash = (approval: DeviceApproval): string =>
  createHash("sha256").update(deviceApprovalBytes(approval)).digest("hex");

export const sameHash = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
};
