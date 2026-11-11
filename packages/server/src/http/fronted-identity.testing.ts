import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { FrontedIdentityConfig } from "./fronted-identity.ts";

/** A synthetic fronting proxy for tests: a key pair made here, and statements signed with it. */
export interface TestProxy {
  readonly config: FrontedIdentityConfig;
  /** The public key as the environment would carry it (`GRAM_IDENTITY_KEYS`). */
  readonly jwks: string;
  /** A statement with `claims` over the defaults; `header` overrides the JOSE header. */
  readonly statement: (
    claims?: Record<string, unknown>,
    options?: { readonly header?: Record<string, unknown>; readonly key?: KeyObject },
  ) => string;
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A compact JWS over `header` and `claims`, signed with `key` (Ed25519). */
export const signStatement = (
  key: KeyObject,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): string => {
  const input = `${encode(header)}.${encode(claims)}`;
  return `${input}.${sign(null, Buffer.from(input), key).toString("base64url")}`;
};

export const makeTestProxy = (
  options: { readonly origin?: string; readonly now?: () => number } = {},
): TestProxy => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const kid = "test-key";
  const now = options.now ?? Date.now;
  const config: FrontedIdentityConfig = {
    issuer: "https://proxy.example.test",
    audience: "gram-test",
    origin: options.origin ?? "https://gram.example.test",
    keys: new Map([[kid, publicKey]]),
  };
  return {
    config,
    jwks: JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid }] }),
    statement: (claims = {}, { header, key } = {}) => {
      const iat = Math.floor(now() / 1000);
      return signStatement(
        key ?? privateKey,
        { alg: "EdDSA", kid, ...header },
        {
          iss: config.issuer,
          aud: config.audience,
          sub: "user-ada",
          name: "Ada",
          role: "member",
          iat,
          exp: iat + 60,
          ...claims,
        },
      );
    },
  };
};
