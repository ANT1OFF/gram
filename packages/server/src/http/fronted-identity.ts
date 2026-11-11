import { createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * Sign-in by a trusted proxy. A deployment that puts its own sign-in in front of Gram (an identity
 * aware proxy, a gateway of its own) has the proxy say who each request is from, in a statement it
 * signs: a compact JWS (a JWT) in the `x-gram-identity` header, signed with Ed25519. The server
 * holds only the proxy's public keys, so nothing it stores or leaks can sign a statement.
 *
 * With it configured and switched on, the statement is the only way in for people: the launch token
 * and its cookie are not accepted, and a request without a valid statement is refused. The proxy
 * must remove any `x-gram-identity` a client sent and set its own, and must be the only route to
 * the server's port; a statement is a bearer credential for the minutes it lives. It must not
 * route `/mcp` or `/host/*`, which are the agents' and hosts' own and take no person.
 *
 * What a statement must say:
 * - header: `alg` `EdDSA`, and `kid` when more than one key is configured;
 * - `iss` and `aud`: exactly the configured issuer and audience. The audience names this one
 *   server, so a statement made for another is refused here;
 * - `sub`: the person, an id that never changes for them; `name`, optionally, to show;
 * - `role`: `member`, who may do everything, or `viewer`, who may only read;
 * - `iat` and `exp`: seconds. A statement lives at most {@link MAX_LIFETIME_SECONDS}.
 *
 * The platform in front can also speak for itself, as no person: a statement whose header has
 * `typ` {@link SERVICE_TYP}, with `role` `service` and a `path` claim naming the one path it is
 * for. It is let through only to register and remove the hosts it starts and to move workspaces
 * in and out (`SERVICE_PATHS` in `server.ts`). The header marks it, not the role alone, so a
 * proxy that copies a role from a directory can never make one by accident, and the path means
 * a statement seen on its way is good for that one call's path and nothing more.
 */
export const IDENTITY_HEADER = "x-gram-identity";

/** How long after `iat` a statement may still be presented. */
export const MAX_LIFETIME_SECONDS = 300;
/** How far the proxy's clock and this one may disagree. */
export const CLOCK_SKEW_SECONDS = 30;
/**
 * How long a WebSocket opened on a statement lasts before the server closes it. A socket is
 * checked when it opens, so this bounds how long a person who signed out, or whose role changed,
 * keeps what the statement gave them when the proxy doesn't close their connections itself.
 */
export const SOCKET_LIFETIME_MS = 15 * 60_000;
/** A statement longer than this is refused unread. */
const MAX_STATEMENT_LENGTH = 4096;
const MAX_TEXT_LENGTH = 256;

export const ActorRoles = ["member", "viewer"] as const;
export type ActorRole = (typeof ActorRoles)[number];

/** The person a request is from, as the proxy stated it. */
export interface Actor {
  /** The proxy's stable id for the person (`sub`). */
  readonly id: string;
  /** What to show for them; their id when the proxy named none. */
  readonly name: string;
  readonly role: ActorRole;
}

export interface FrontedIdentityConfig {
  readonly issuer: string;
  readonly audience: string;
  /** The one origin browsers reach this server on, through the proxy. */
  readonly origin: string;
  /** The proxy's public keys by `kid`; a key configured without one is under `""`. */
  readonly keys: ReadonlyMap<string, KeyObject>;
  /** Overrides {@link SOCKET_LIFETIME_MS}, for a test that can't wait that long. */
  readonly socketLifetimeMs?: number;
}

export type IdentityRefusal =
  | "missing"
  | "malformed"
  | "algorithm"
  | "key"
  | "signature"
  | "issuer"
  | "audience"
  | "expired"
  | "lifetime"
  | "subject"
  | "role";

/**
 * The platform in front, speaking for itself and no person (`role` `service`). Whoever signs
 * statements can make one, so it is the proxy's operator, never someone signed in through it.
 */
export interface ServiceCaller {
  /** What the platform calls this caller (`sub`), for the record. */
  readonly id: string;
  readonly name: string;
  /** The one path this statement is for, which the request's must equal. */
  readonly path: string;
}

/** The JOSE `typ` of a platform's own statement; a person's has another or none. */
export const SERVICE_TYP = "gram-service+jwt";

export const SERVICE_ROLE = "service";

export type IdentityResult =
  | { readonly ok: true; readonly actor: Actor }
  | { readonly ok: true; readonly service: ServiceCaller }
  | { readonly ok: false; readonly reason: IdentityRefusal };

const refuse = (reason: IdentityRefusal): IdentityResult => ({ ok: false, reason });

/** Canonical unpadded base64url, or undefined: a second spelling of the same bytes is refused. */
const decodeBase64Url = (text: string): Buffer | undefined => {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : undefined;
};

const parseObject = (bytes: Buffer): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Printable text of a sane length: no control characters to carry into a log or a header, and no
 * invisible or direction-changing ones to make one name read as another.
 */
const plainText = (value: unknown): string | undefined =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_TEXT_LENGTH &&
  value.trim() === value &&
  // oxlint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/.test(value)
    ? value
    : undefined;

/**
 * Who `statement` says the request is from, when it is the configured proxy's and still current.
 * Every check must pass; nothing about a refused statement is trusted, its reason included, which
 * is for the server's log and never for the caller.
 */
export const verifyIdentity = (
  config: FrontedIdentityConfig,
  statement: string | undefined,
  nowMs: number = Date.now(),
): IdentityResult => {
  if (statement === undefined || statement === "") return refuse("missing");
  if (statement.length > MAX_STATEMENT_LENGTH) return refuse("malformed");
  const segments = statement.split(".");
  if (segments.length !== 3) return refuse("malformed");
  const [headerText, payloadText, signatureText] = segments as [string, string, string];
  const headerBytes = decodeBase64Url(headerText);
  const payloadBytes = decodeBase64Url(payloadText);
  const signature = decodeBase64Url(signatureText);
  if (headerBytes === undefined || payloadBytes === undefined || signature === undefined)
    return refuse("malformed");
  const header = parseObject(headerBytes);
  if (header === undefined) return refuse("malformed");
  // One algorithm, named here and never read from the statement as a choice: `none`, an HMAC keyed
  // with the public key, and every other substitution end at this line.
  if (header["alg"] !== "EdDSA") return refuse("algorithm");
  // Extensions this reader doesn't know must not be skipped past.
  if ("crit" in header || "b64" in header || "jwk" in header || "jku" in header || "x5u" in header)
    return refuse("malformed");
  const kid = header["kid"];
  if (kid !== undefined && typeof kid !== "string") return refuse("malformed");
  const key =
    kid === undefined
      ? config.keys.size === 1
        ? [...config.keys.values()][0]
        : undefined
      : config.keys.get(kid);
  if (key === undefined) return refuse("key");
  if (signature.length !== 64) return refuse("signature");
  let signed = false;
  try {
    signed = verify(null, Buffer.from(`${headerText}.${payloadText}`, "ascii"), key, signature);
  } catch {
    signed = false;
  }
  if (!signed) return refuse("signature");

  const claims = parseObject(payloadBytes);
  if (claims === undefined) return refuse("malformed");
  if (claims["iss"] !== config.issuer) return refuse("issuer");
  // A statement for several audiences is one another server could have been handed.
  if (claims["aud"] !== config.audience) return refuse("audience");
  const iat = claims["iat"];
  const exp = claims["exp"];
  const nbf = claims["nbf"];
  if (typeof iat !== "number" || typeof exp !== "number" || !Number.isFinite(iat + exp))
    return refuse("malformed");
  if (nbf !== undefined && typeof nbf !== "number") return refuse("malformed");
  const now = nowMs / 1000;
  if (exp <= iat || exp - iat > MAX_LIFETIME_SECONDS) return refuse("lifetime");
  if (now >= exp + CLOCK_SKEW_SECONDS) return refuse("expired");
  if (iat > now + CLOCK_SKEW_SECONDS) return refuse("expired");
  if (nbf !== undefined && nbf > now + CLOCK_SKEW_SECONDS) return refuse("expired");
  const id = plainText(claims["sub"]);
  if (id === undefined) return refuse("subject");
  const name = claims["name"] === undefined ? id : plainText(claims["name"]);
  if (name === undefined) return refuse("subject");
  const role = claims["role"];
  // Both or neither: the header says what kind of statement this is, and the role agrees.
  const forService = header["typ"] === SERVICE_TYP;
  if (forService !== (role === SERVICE_ROLE)) return refuse("role");
  if (forService) {
    const path = claims["path"];
    if (typeof path !== "string" || !/^\/[a-z/-]{0,64}$/.test(path)) return refuse("role");
    return { ok: true, service: { id, name, path } };
  }
  if (role !== "member" && role !== "viewer") return refuse("role");
  return { ok: true, actor: { id, name, role } };
};

/** The environment a fronted server is configured by. All four are set, or none. */
export const IDENTITY_ENV = {
  keys: "GRAM_IDENTITY_KEYS",
  issuer: "GRAM_IDENTITY_ISSUER",
  audience: "GRAM_IDENTITY_AUDIENCE",
  origin: "GRAM_PUBLIC_ORIGIN",
} as const;

export class FrontedIdentityConfigError extends Error {
  override readonly name = "FrontedIdentityConfigError";
}

const invalid = (message: string): never => {
  throw new FrontedIdentityConfigError(`fronted sign-in: ${message}`);
};

/** `https://host[:port]`, or plain `http` on loopback for a proxy tried out on one machine. */
const publicOrigin = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid(`${IDENTITY_ENV.origin} is not a URL`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    return invalid(`${IDENTITY_ENV.origin} must be an https origin`);
  if (url.origin !== value)
    return invalid(`${IDENTITY_ENV.origin} must be an origin alone, like ${url.origin}`);
  return url.origin;
};

/** The proxy's Ed25519 public keys, from a JWK Set (`{"keys":[…]}`). */
const publicKeys = (text: string): ReadonlyMap<string, KeyObject> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid(`${IDENTITY_ENV.keys} is not JSON`);
  }
  const list = (parsed as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(list) || list.length === 0)
    return invalid(`${IDENTITY_ENV.keys} must be a JWK Set with at least one key`);
  const keys = new Map<string, KeyObject>();
  for (const jwk of list as ReadonlyArray<Record<string, unknown> | null>) {
    if (typeof jwk !== "object" || jwk === null)
      return invalid(`${IDENTITY_ENV.keys} holds something that is not a key`);
    // A private key here means the signing key was handed to the server it is meant to convince.
    if ("d" in jwk) return invalid(`${IDENTITY_ENV.keys} must hold public keys only`);
    if (jwk["kty"] !== "OKP" || jwk["crv"] !== "Ed25519" || typeof jwk["x"] !== "string")
      return invalid(`${IDENTITY_ENV.keys} takes Ed25519 keys only (kty OKP, crv Ed25519)`);
    const kid = jwk["kid"] === undefined ? "" : jwk["kid"];
    if (typeof kid !== "string") return invalid(`a key's kid must be text`);
    if (keys.has(kid))
      return invalid(
        kid === ""
          ? "more than one key has no kid"
          : `two keys share the kid ${JSON.stringify(kid)}`,
      );
    try {
      keys.set(
        kid,
        createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk["x"] }, format: "jwk" }),
      );
    } catch {
      return invalid(`${IDENTITY_ENV.keys} holds a key that is not a valid Ed25519 public key`);
    }
  }
  // Without a `kid` a statement can only mean the one key there is.
  if (keys.size > 1 && keys.has(""))
    return invalid("with more than one key, every key needs a kid");
  return keys;
};

/**
 * The fronted sign-in an environment configures: undefined with none of {@link IDENTITY_ENV} set.
 * A partial or malformed configuration throws, so a server meant to sit behind a proxy never
 * starts as one that doesn't ask who is calling.
 */
export const frontedIdentityFrom = (
  env: Record<string, string | undefined>,
): FrontedIdentityConfig | undefined => {
  const given = Object.values(IDENTITY_ENV).filter((name) => (env[name] ?? "") !== "");
  if (given.length === 0) return undefined;
  const missing = Object.values(IDENTITY_ENV).filter((name) => !given.includes(name));
  if (missing.length > 0) return invalid(`${missing.join(", ")} must be set too`);
  const issuer = plainText(env[IDENTITY_ENV.issuer]);
  const audience = plainText(env[IDENTITY_ENV.audience]);
  if (issuer === undefined) return invalid(`${IDENTITY_ENV.issuer} is not plain text`);
  if (audience === undefined) return invalid(`${IDENTITY_ENV.audience} is not plain text`);
  return {
    issuer,
    audience,
    origin: publicOrigin(env[IDENTITY_ENV.origin]!),
    keys: publicKeys(env[IDENTITY_ENV.keys]!),
  };
};
