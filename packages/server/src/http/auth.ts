import { randomBytes, timingSafeEqual } from "node:crypto";
import { authTarget } from "./auth-target.ts";

/**
 * Two independent layers: a loopback Host/Origin allowlist, then a per-launch
 * token exchanged for an HttpOnly per-port cookie.
 *
 * A foreign page can't be stopped from *sending* a cross-origin request or WebSocket upgrade to our
 * port (CORS only blocks reading the response), and DNS rebinding can forge same-origin reads. So
 * `Host` must be our loopback host:port and any `Origin` must be our own. Same-origin GETs omit
 * `Origin`, which is fine; the Host check still applies. The token then means loopback reachability
 * alone grants nothing.
 */
export interface AuthOptions {
  readonly port: number;
  readonly token: string;
  readonly extraOrigins?: ReadonlyArray<string>;
}

export interface AuthRequest {
  readonly method: string;
  /** Path plus query, as received. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly cookies: Readonly<Record<string, string | undefined>>;
}

export type AuthDecision =
  | { readonly kind: "pass" }
  /** A valid `/?boot=<token>` navigation: set the cookie and redirect to strip the token. */
  | { readonly kind: "boot" }
  /** An `/mcp` request with a bearer token; the caller must still check it against `McpTokens`. */
  | { readonly kind: "bearer"; readonly token: string }
  | { readonly kind: "reject"; readonly status: 401 | 403; readonly message: string };

/** The app-tool MCP endpoint: per-thread bearer tokens, never the launch cookie. */
export const MCP_PATH = "/mcp";

/** The token of an `Authorization: Bearer <token>` header, if present. */
export const bearerToken = (
  headers: Readonly<Record<string, string | undefined>>,
): string | undefined => /^Bearer\s+(\S+)\s*$/i.exec(headers["authorization"] ?? "")?.[1];

/** 256 random bits, hex-encoded. */
export const makeLaunchToken = (): string => randomBytes(32).toString("hex");

/** Cookies are host-scoped, not port-scoped: another instance's cookie must not shadow ours. */
export const tokenCookieName = (port: number): string => `sb_token_${port}`;

const allowedHosts = (port: number): ReadonlyArray<string> => [
  `127.0.0.1:${port}`,
  `localhost:${port}`,
  `[::1]:${port}`,
];

const allowedOrigins = (port: number, extra: ReadonlyArray<string> = []): ReadonlyArray<string> => [
  ...allowedHosts(port).map((host) => `http://${host}`),
  ...extra,
];

export const tokensEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Served as a header: the renderer loads over http://127.0.0.1:<port>, where no meta tag or Electron
 * config applies. `style-src 'unsafe-inline'` covers inline style attributes set by React/Motion.
 *
 * `'wasm-unsafe-eval'` is there for one thing: the Terminal tab's emulator is Ghostty's VT parser
 * compiled to WebAssembly, and without the keyword Chromium refuses `WebAssembly.compile` outright
 * ("'unsafe-eval' is not an allowed source"). It permits compiling WebAssembly and nothing else:
 * `eval`, `new Function` and string timers stay blocked, which is what `'unsafe-eval'` would have
 * given away. What it does give away: a script already running here may compile any bytes it can
 * build, not only ones it fetched, so it is no defence against a script that is already malicious.
 * Which scripts run is still `'self'`, and the emulator itself can only be fetched from this
 * origin, since `connect-src` allows no CDN and no `data:` URL.
 */
export const contentSecurityPolicy = (port: number, remoteOrigin?: string): string =>
  [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    remoteOrigin === undefined
      ? `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`
      : `connect-src 'self' ${remoteOrigin.replace("https:", "wss:")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "frame-src 'none'",
  ].join("; ");

export const authorize = (options: AuthOptions, request: AuthRequest): AuthDecision => {
  const host = request.headers["host"];
  const origin = request.headers["origin"];
  const hostOk = host !== undefined && allowedHosts(options.port).includes(host);
  const originOk =
    origin === undefined || allowedOrigins(options.port, options.extraOrigins).includes(origin);
  // Serve always adds forwarding headers, even if a raw client spoofs a loopback Host.
  // These headers may only deny local authority; their values never grant remote authority.
  const forwarded = [
    "forwarded",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-for",
    "tailscale-user-login",
    "tailscale-funnel-request",
  ].some((name) => request.headers[name] !== undefined);
  if (!hostOk || !originOk || forwarded) {
    return { kind: "reject", status: 403, message: "forbidden: non-local request" };
  }

  const target = authTarget(request.url);
  if (target === undefined)
    return { kind: "reject", status: 403, message: "forbidden: noncanonical request target" };
  if (target.path === MCP_PATH) {
    const token = bearerToken(request.headers);
    return token === undefined
      ? { kind: "reject", status: 401, message: "unauthorized: bearer token required" }
      : { kind: "bearer", token };
  }

  const boot = target.searchParams.get("boot");
  if (
    boot !== null &&
    request.method === "GET" &&
    target.path === "/" &&
    tokensEqual(boot, options.token)
  ) {
    return { kind: "boot" };
  }

  const cookie = request.cookies[tokenCookieName(options.port)];
  if (cookie !== undefined && tokensEqual(cookie, options.token)) return { kind: "pass" };
  return { kind: "reject", status: 401, message: "unauthorized: launch token required" };
};
