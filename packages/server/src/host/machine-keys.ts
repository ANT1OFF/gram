import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { HostId } from "@gram/contracts";

/**
 * A joined machine's identity: an Ed25519 key pair it makes itself when it joins. The main Gram
 * pins the public half; the private half never leaves the machine. Its host id and fingerprint
 * both come from the public key, so neither can be claimed by another machine.
 */

/** Where a machine joins, with the code in the link's fragment: `<origin>/host/join#code=…`. */
export const HOST_JOIN_PATH = "/host/join";
/** Where a joined machine's host dials in, as a WebSocket. */
export const HOST_CONNECT_PATH = "/host/connect";

/** The headers a host proves itself with when it dials in. */
export const HOST_ID_HEADER = "x-gram-host-id";
export const HOST_TIME_HEADER = "x-gram-host-time";
export const HOST_NONCE_HEADER = "x-gram-host-nonce";
export const HOST_SIGNATURE_HEADER = "x-gram-host-signature";

/** How far a dial's signed time may be from the main Gram's clock. */
export const CONNECT_SKEW_MS = 2 * 60_000;

/** The raw 32-byte Ed25519 public key, base64url: what a machine sends when it joins. */
export const publicKeyText = (key: KeyObject): string => {
  const jwk = key.export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string")
    throw new Error("Not an Ed25519 key");
  return jwk.x;
};

/** The public key from its text, or undefined for anything that isn't a 32-byte Ed25519 key. */
export const publicKeyFrom = (text: string): KeyObject | undefined => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return undefined;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: text }, format: "jwk" });
    return publicKeyText(key) === text ? key : undefined;
  } catch {
    return undefined;
  }
};

/** A new key pair, the private half as PKCS #8 PEM for the machine's own config folder. */
export const generateHostKey = (): {
  readonly privateKeyPem: string;
  readonly publicKey: string;
} => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: publicKeyText(publicKey),
  };
};

export const privateKeyFrom = (pem: string): KeyObject => {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The host key isn't an Ed25519 key.");
  return key;
};

const digest = (publicKey: string) =>
  createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest();

/**
 * What a person compares on both machines before the main one gives the new one work: the key's
 * SHA-256, its first 80 bits in five groups of four hex digits.
 */
export const fingerprintOf = (publicKey: string): string =>
  (digest(publicKey).toString("hex").slice(0, 20).match(/.{4}/g) ?? []).join("-").toUpperCase();

/** The machine's host id, from its key: `m-` and the key digest's first 96 bits. */
export const hostIdOf = (publicKey: string): HostId =>
  HostId.make(`m-${digest(publicKey).toString("hex").slice(0, 24)}`);

export interface ConnectClaim {
  /** The main Gram's origin the host dials, so a dial signed for one can't be replayed at another. */
  readonly origin: string;
  readonly hostId: string;
  readonly time: number;
  readonly nonce: string;
}

const connectPayload = (claim: ConnectClaim) =>
  Buffer.from(
    `gram-host-connect v1\n${claim.origin}\n${claim.hostId}\n${claim.time}\n${claim.nonce}`,
  );

/** The headers of one dial: a fresh nonce and the time, signed with the machine's key. */
export const signedConnectHeaders = (
  key: KeyObject,
  origin: string,
  hostId: string,
  now = Date.now(),
): Record<string, string> => {
  const claim: ConnectClaim = { origin, hostId, time: now, nonce: randomBytes(16).toString("hex") };
  return {
    [HOST_ID_HEADER]: hostId,
    [HOST_TIME_HEADER]: String(claim.time),
    [HOST_NONCE_HEADER]: claim.nonce,
    [HOST_SIGNATURE_HEADER]: sign(null, connectPayload(claim), key).toString("base64url"),
  };
};

/** The claim a dial's headers carry, when they are well formed; its signature isn't checked here. */
export const connectClaimOf = (
  origin: string,
  headers: Readonly<Record<string, string | undefined>>,
): (ConnectClaim & { readonly signature: string }) | undefined => {
  const hostId = headers[HOST_ID_HEADER];
  const time = headers[HOST_TIME_HEADER];
  const nonce = headers[HOST_NONCE_HEADER];
  const signature = headers[HOST_SIGNATURE_HEADER];
  if (
    hostId === undefined ||
    !/^m-[a-f0-9]{24}$/.test(hostId) ||
    time === undefined ||
    !/^[0-9]{1,16}$/.test(time) ||
    nonce === undefined ||
    !/^[a-f0-9]{32}$/.test(nonce) ||
    signature === undefined ||
    !/^[A-Za-z0-9_-]{86}$/.test(signature)
  )
    return undefined;
  return { origin, hostId, time: Number(time), nonce, signature };
};

/** Whether `signature` is the machine's own over `claim`. */
export const verifyConnect = (
  publicKey: KeyObject,
  claim: ConnectClaim,
  signature: string,
): boolean => {
  try {
    return verify(null, connectPayload(claim), publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
};
