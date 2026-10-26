import { createHash } from "node:crypto";
import { sessionHash, type RemoteSession, type RemoteSessionStore } from "./remote-sessions.ts";
import { authTarget } from "./auth-target.ts";
import { makeLaunchToken, tokensEqual, type AuthDecision, type AuthRequest } from "./auth.ts";
import { DAY_MS } from "../zone-time.ts";

export const REMOTE_PAIR_PATH = "/remote/pair";
export const SESSION_LIFETIME_MS = 365 * DAY_MS;
export const REMOTE_CONNECT_PATH = "/remote/connect";
export const REMOTE_CLAIM_PATH = "/remote/claim";
export const PAIR_LIFETIME_MS = 15 * 60_000;

/** Deliberately one canonical HTTPS tailnet origin, never a wildcard or forwarded-header trust. */
export const remoteOrigin = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (
      value === url.origin &&
      url.protocol === "https:" &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ts\.net$/.test(
        url.hostname,
      )
    )
      return value;
  } catch {
    /* Refuse malformed input without echoing it into logs. */
  }
  throw new Error("GRAM_REMOTE_ORIGIN must be one canonical HTTPS device.tailnet.ts.net origin");
};

export const remoteCookieName = (port: number): string => `__Host-gram_remote_${port}`;

// This bridge is deliberately self-contained. The fragment never goes to HTTP/proxy logs; clear
// it before any request, and exchange using same-origin POST. Do not add analytics or assets here.
const bridgeScript = `"use strict";
const secret = new URLSearchParams(location.hash.slice(1)).get("pair");
history.replaceState(null, "", location.pathname);
if (!secret) { document.body.textContent = "Open a fresh pairing link from your local Gram session."; }
else { fetch("${REMOTE_CLAIM_PATH}", { method: "POST", credentials: "same-origin", headers: { "content-type": "text/plain" }, body: secret }).then(response => {
if (response.ok) { location.replace("/"); }
else { document.body.textContent = "Pairing refused. Use a fresh link, or your existing paired session."; }
}).catch(() => { document.body.textContent = "Connection failed. Create a fresh pairing link locally."; }); }`;
export const pairingDocument = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gram pairing</title><body><script>${bridgeScript}</script></body>`;
export const pairingCsp = `default-src 'none'; script-src 'sha256-${createHash("sha256").update(bridgeScript).digest("base64")}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;

/** One ephemeral invitation and up to eight durable, expiring browser sessions. */
export const createRemoteAccess = (
  origin: string,
  port: number,
  now = Date.now,
  store?: RemoteSessionStore,
) => {
  remoteOrigin(origin);
  const host = new URL(origin).host;
  let invitation: { code: string; expiresAt: number } | undefined;
  let sessions: RemoteSession[] = store?.read() ?? [];
  const paired = (request: AuthRequest) => {
    const cookie = request.cookies[remoteCookieName(port)];
    return (
      cookie !== undefined &&
      sessions.some(
        (session) => now() < session.expiresAt && tokensEqual(sessionHash(cookie), session.hash),
      )
    );
  };
  return {
    origin,
    host,
    mint: () => {
      const code = makeLaunchToken();
      invitation = { code, expiresAt: now() + PAIR_LIFETIME_MS };
      return {
        url: `${origin}${REMOTE_CONNECT_PATH}#pair=${code}`,
        expiresAt: invitation.expiresAt,
      };
    },
    /** Atomically consumes before issuing a session; wrong attempts don't consume an invitation. */
    claim: (request: AuthRequest, code: string): string | undefined => {
      const target = authTarget(request.url);
      if (
        target?.path !== REMOTE_CLAIM_PATH ||
        target.searchParams.has("boot") ||
        request.headers["host"] !== host ||
        request.headers["origin"] !== origin ||
        request.method !== "POST" ||
        paired(request) ||
        sessions.filter((session) => now() < session.expiresAt).length >= 8 ||
        invitation === undefined ||
        now() >= invitation.expiresAt ||
        !tokensEqual(code, invitation.code)
      )
        return undefined;
      invitation = undefined;
      const session = makeLaunchToken();
      const next = [
        ...sessions.filter((existing) => now() < existing.expiresAt),
        { hash: sessionHash(session), expiresAt: now() + SESSION_LIFETIME_MS },
      ];
      store?.write(next);
      sessions = next;
      return session;
    },
    authorize: (request: AuthRequest): AuthDecision => {
      if (
        request.headers["host"] !== host ||
        (request.headers["origin"] !== undefined && request.headers["origin"] !== origin)
      )
        return { kind: "reject", status: 403, message: "forbidden: remote origin mismatch" };
      const target = authTarget(request.url);
      if (target === undefined)
        return { kind: "reject", status: 403, message: "forbidden: noncanonical request target" };
      if (target.path === "/ws" && request.headers["origin"] !== origin)
        return { kind: "reject", status: 403, message: "forbidden: WebSocket origin required" };
      if (
        target.path === "/mcp" ||
        target.path === REMOTE_PAIR_PATH ||
        target.searchParams.has("boot")
      )
        return { kind: "reject", status: 403, message: "forbidden: local access only" };
      return paired(request)
        ? { kind: "pass" }
        : { kind: "reject", status: 401, message: "unauthorized: pair this browser locally" };
    },
  };
};
