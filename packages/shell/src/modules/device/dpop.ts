import { createHash, type KeyObject, randomBytes, sign } from "node:crypto";
import { devicePublicKeyText } from "./keys.ts";

/**
 * DPoP proofs (RFC 9449) signed with the device key, so a token the server binds to that key is
 * useless to anyone who copies it without the key. Ed25519, as `EdDSA` with an `OKP` key.
 */

export interface DpopFor {
  /** The HTTP method, upper case. */
  readonly method: string;
  /** The address the request goes to. Its query and fragment are not part of the proof. */
  readonly url: string;
  /** For a call made with an access token: that token, which the proof then names by hash. */
  readonly accessToken?: string;
  /** The nonce the server last gave in `DPoP-Nonce`, if it gave one. */
  readonly nonce?: string;
  /** Milliseconds since the epoch. */
  readonly now: number;
}

const json64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

/** The address as a proof names it: no query, no fragment. */
export const dpopTarget = (address: string): string => {
  const url = new URL(address);
  url.search = "";
  url.hash = "";
  return url.href;
};

/** A proof for one request: a compact JWS, as the `DPoP` header carries it. */
export const dpopProof = (key: KeyObject, request: DpopFor): string => {
  const header = {
    typ: "dpop+jwt",
    alg: "EdDSA",
    jwk: { kty: "OKP", crv: "Ed25519", x: devicePublicKeyText(key) },
  };
  const claims = {
    jti: randomBytes(16).toString("base64url"),
    htm: request.method.toUpperCase(),
    htu: dpopTarget(request.url),
    iat: Math.floor(request.now / 1000),
    ...(request.accessToken === undefined
      ? {}
      : { ath: createHash("sha256").update(request.accessToken).digest("base64url") }),
    ...(request.nonce === undefined ? {} : { nonce: request.nonce }),
  };
  const signed = `${json64(header)}.${json64(claims)}`;
  return `${signed}.${sign(null, Buffer.from(signed), key).toString("base64url")}`;
};

/** The thumbprint of the device key (RFC 7638), as a server binds a token to it (`cnf.jkt`). */
export const dpopThumbprint = (key: KeyObject): string =>
  createHash("sha256")
    .update(`{"crv":"Ed25519","kty":"OKP","x":"${devicePublicKeyText(key)}"}`)
    .digest("base64url");
