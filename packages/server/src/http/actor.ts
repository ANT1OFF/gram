import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Headers, type HttpServerRequest } from "../platform/unstable.ts";
import { ActorRoles, type Actor } from "./fronted-identity.ts";

/**
 * Who an RPC call is from, as the transport authenticated it, carried to the RPC layer.
 *
 * An RPC handler sees only headers: the WebSocket upgrade's, then any the caller adds to its own
 * messages, which win. So, as with the local app's mark (`local-app.ts`), the auth middleware
 * stamps the upgrade with the person the proxy's signed statement named, sealed with a key made
 * for this run of the server, and takes the header off every other request. A caller can add the
 * header to a message, but can't seal it: a value that doesn't verify is no actor at all, and
 * fronted sign-in refuses a call with no actor.
 */
export const ACTOR_HEADER = "x-gram-actor";

const SEAL_KEY = randomBytes(32);

const seal = (body: string): string =>
  createHmac("sha256", SEAL_KEY).update(body).digest("base64url");

const stamp = (actor: Actor): string => {
  const body = Buffer.from(
    JSON.stringify({ id: actor.id, name: actor.name, role: actor.role }),
  ).toString("base64url");
  return `${body}.${seal(body)}`;
};

/** `request` as `actor`'s: stamped and sealed with this run's key. */
export const markActor = (request: HttpServerRequest.HttpServerRequest, actor: Actor) =>
  request.modify({ headers: Headers.set(request.headers, ACTOR_HEADER, stamp(actor)) });

/** `request` as nobody's: whatever it said of its actor is taken off. */
export const unmarkActor = (request: HttpServerRequest.HttpServerRequest) => {
  if (!(ACTOR_HEADER in request.headers)) return request;
  return request.modify({ headers: Headers.remove(request.headers, ACTOR_HEADER) });
};

/** The actor a call's headers carry, when this server sealed it; undefined otherwise. */
export const actorOf = (
  headers: Readonly<Record<string, string | undefined>> | undefined,
): Actor | undefined => {
  const value = headers?.[ACTOR_HEADER];
  if (value === undefined) return undefined;
  const dot = value.indexOf(".");
  if (dot <= 0) return undefined;
  const body = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(seal(body));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<Actor>;
    return typeof parsed.id === "string" &&
      typeof parsed.name === "string" &&
      ActorRoles.includes(parsed.role as never)
      ? { id: parsed.id, name: parsed.name, role: parsed.role! }
      : undefined;
  } catch {
    return undefined;
  }
};

/** The headers of a call made as `actor`, for a test that calls a handler in-process. */
export const actorHeadersForTests = (actor: Actor): Record<string, string> => ({
  [ACTOR_HEADER]: stamp(actor),
});
