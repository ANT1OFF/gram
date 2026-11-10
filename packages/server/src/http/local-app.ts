import { randomBytes, timingSafeEqual } from "node:crypto";
import { Headers, type HttpServerRequest } from "../platform/unstable.ts";

/**
 * Which RPC calls came over the local app's own connection, as the transport authenticated it.
 *
 * The RPC socket a paired phone opens is the same `/ws` the local app opens, and an RPC handler
 * sees only headers: the upgrade request's, then any a caller adds to its own messages, which win.
 * So no header a caller can name tells them apart. Instead, the server's auth middleware, having
 * decided the upgrade is the local app's (loopback host, launch token), stamps it with a secret made
 * for this run of the server; any other connection has the header taken off. A caller can add the
 * header to its messages, but not its value, which never leaves this process.
 */
export const LOCAL_APP_HEADER = "x-gram-local-app";

const MARK = randomBytes(32).toString("hex");

/** `request` as the local app's: stamped with this run's secret. */
export const markLocalApp = (request: HttpServerRequest.HttpServerRequest) =>
  request.modify({ headers: Headers.set(request.headers, LOCAL_APP_HEADER, MARK) });

/** `request` as any other caller's: whatever it said of itself is taken off. */
export const unmarkLocalApp = (request: HttpServerRequest.HttpServerRequest) => {
  if (!(LOCAL_APP_HEADER in request.headers)) return request;
  return request.modify({ headers: Headers.remove(request.headers, LOCAL_APP_HEADER) });
};

/**
 * Whether an RPC call came over the local app's connection: its headers carry this run's secret.
 * A call without headers (made in-process, in a test) is not the local app's.
 */
export const isLocalApp = (
  headers: Readonly<Record<string, string | undefined>> | undefined,
): boolean => {
  const value = headers?.[LOCAL_APP_HEADER];
  if (value === undefined) return false;
  const given = Buffer.from(value);
  const mark = Buffer.from(MARK);
  return given.length === mark.length && timingSafeEqual(given, mark);
};

/** The headers of a call made as the local app's, for a test that calls a handler in-process. */
export const localAppHeadersForTests = (): Record<string, string> => ({ [LOCAL_APP_HEADER]: MARK });
