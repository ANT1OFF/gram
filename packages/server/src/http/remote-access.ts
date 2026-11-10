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
export const REMOTE_STATUS_PATH = "/remote/status";
export const REMOTE_ENABLE_PATH = "/remote/enable";
export const REMOTE_DISABLE_PATH = "/remote/disable";
export const REMOTE_REVOKE_PATH = "/remote/revoke";
/** Management routes: only the local app may call them, never a paired browser. */
export const LOCAL_ONLY_PATHS: ReadonlySet<string> = new Set([
  REMOTE_PAIR_PATH,
  REMOTE_ENABLE_PATH,
  REMOTE_DISABLE_PATH,
]);

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

/** What a browser that isn't paired, or was removed, sees: no script, no assets, no data. */
export const unpairedDocument = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gram</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;max-width:28rem;color:#222;background:#fff}@media (prefers-color-scheme:dark){body{color:#ddd;background:#161616}}h1{font-size:20px;margin:0 0 8px}p{margin:0;opacity:.75}</style><h1>This browser isn't paired with Gram</h1><p>It was never paired, or it was removed from Gram's settings on your computer. To use it, pair it again from Settings → Machines → Phones and browsers there.</p>`;
export const unpairedCsp = `default-src 'none'; style-src 'sha256-${createHash("sha256")
  .update(/<style>(.*)<\/style>/.exec(unpairedDocument)![1]!)
  .digest("base64")}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;

/** Where the current pairing link stands, for the local dialog that shows its QR code. */
export type PairingState =
  | { readonly state: "waiting"; readonly expiresAt: number }
  | { readonly state: "paired"; readonly device: string }
  | { readonly state: "expired" };

/** A paired browser as the local settings page lists it; `id` is a prefix of the session hash. */
export interface RemoteDevice {
  readonly id: string;
  readonly label: string;
  readonly pairedAt?: number;
  readonly lastSeenAt?: number;
  readonly expiresAt: number;
}

export const MAX_REMOTE_SESSIONS = 8;
const LAST_SEEN_STEP_MS = 60 * 60_000;
const deviceId = (session: RemoteSession) => session.hash.slice(0, 16);

/**
 * Names a browser from its user agent at pairing, from a fixed vocabulary only, so no user agent
 * text is ever stored or shown.
 */
export const deviceLabel = (userAgent: string | undefined): string => {
  const ua = userAgent ?? "";
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /CrOS/.test(ua)
          ? "Chromebook"
          : /Macintosh|Mac OS X/.test(ua)
            ? "Mac"
            : /Windows/.test(ua)
              ? "Windows"
              : /Linux/.test(ua)
                ? "Linux"
                : "Browser";
  const browser = /EdgiOS|EdgA|Edg\//.test(ua)
    ? "Edge"
    : /FxiOS|Firefox\//.test(ua)
      ? "Firefox"
      : /CriOS|Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : undefined;
  return browser === undefined || device === "Browser"
    ? (browser ?? device)
    : `${device} · ${browser}`;
};

export type RemoteAccess = ReturnType<typeof createRemoteAccess>;

/**
 * One ephemeral invitation and up to eight durable, expiring browser sessions. `cookiePort` names
 * the cookie: the loopback port under `GRAM_REMOTE_ORIGIN`, the Serve port when settings turn it on.
 */
export const createRemoteAccess = (
  origin: string,
  cookiePort: number,
  now = Date.now,
  store?: RemoteSessionStore,
) => {
  remoteOrigin(origin);
  const host = new URL(origin).host;
  const cookieName = remoteCookieName(cookiePort);
  let invitation: { code: string; expiresAt: number } | undefined;
  let lastPairing: PairingState | undefined;
  /**
   * Set when this access is closed (turned off, or Tailscale went away): a request that began on
   * it, such as a claim still reading its body, gets nothing from it after.
   */
  let closed = false;
  let sessions: RemoteSession[] = store?.read() ?? [];
  /** Live remote connections by session hash; revoking or turning off closes them. */
  const connections = new Map<string, Set<() => void>>();
  const live = () => sessions.filter((session) => now() < session.expiresAt);
  const sessionOf = (request: AuthRequest): RemoteSession | undefined => {
    if (closed) return undefined;
    const cookie = request.cookies[cookieName];
    if (cookie === undefined) return undefined;
    const hash = sessionHash(cookie);
    return sessions.find((session) => now() < session.expiresAt && tokensEqual(hash, session.hash));
  };
  const save = (next: RemoteSession[]) => {
    store?.write(next);
    sessions = next;
  };
  const disconnect = (hashes: ReadonlyArray<string>) => {
    for (const hash of hashes) {
      const closers = connections.get(hash);
      connections.delete(hash);
      for (const close of closers ?? []) close();
    }
  };
  const forget = (gone: ReadonlyArray<RemoteSession>) => {
    sessions = sessions.filter((session) => !gone.includes(session));
    disconnect(gone.map((session) => session.hash));
    store?.write(sessions);
  };
  const touch = (session: RemoteSession) => {
    const seen = now() - (now() % LAST_SEEN_STEP_MS);
    if (session.lastSeenAt !== undefined && session.lastSeenAt >= seen) return;
    try {
      save(
        sessions.map((existing) =>
          existing === session ? { ...existing, lastSeenAt: seen } : existing,
        ),
      );
    } catch {
      /* Last seen is a hint; a failed write must not refuse an authorized request. */
    }
  };
  return {
    origin,
    host,
    cookieName,
    /** The paired session a request carries, if any. */
    sessionOf,
    mint: () => {
      const code = makeLaunchToken();
      invitation = { code, expiresAt: now() + PAIR_LIFETIME_MS };
      lastPairing = undefined;
      return {
        url: `${origin}${REMOTE_CONNECT_PATH}#pair=${code}`,
        expiresAt: invitation.expiresAt,
      };
    },
    pairing: (): PairingState | undefined => {
      if (invitation !== undefined)
        return now() < invitation.expiresAt
          ? { state: "waiting", expiresAt: invitation.expiresAt }
          : { state: "expired" };
      return lastPairing;
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
        closed ||
        sessionOf(request) !== undefined ||
        live().length >= MAX_REMOTE_SESSIONS ||
        invitation === undefined ||
        now() >= invitation.expiresAt ||
        !tokensEqual(code, invitation.code)
      )
        return undefined;
      invitation = undefined;
      const token = makeLaunchToken();
      const session: RemoteSession = {
        hash: sessionHash(token),
        expiresAt: now() + SESSION_LIFETIME_MS,
        label: deviceLabel(request.headers["user-agent"]),
        pairedAt: now(),
      };
      save([...live(), session]);
      lastPairing = { state: "paired", device: deviceId(session) };
      return token;
    },
    devices: (): RemoteDevice[] =>
      live().map((session) => ({
        id: deviceId(session),
        label: session.label ?? "Browser",
        ...(session.pairedAt === undefined ? {} : { pairedAt: session.pairedAt }),
        ...(session.lastSeenAt === undefined ? {} : { lastSeenAt: session.lastSeenAt }),
        expiresAt: session.expiresAt,
      })),
    deviceIdOf: deviceId,
    /** Signs one browser out at once: its session goes and its open connections close. */
    /**
     * Signs one browser out at once: its session goes and its open connections close. Memory is
     * changed first, so a removal holds even when saving it throws (until a restart re-reads it).
     */
    revoke: (id: string): boolean => {
      const gone = sessions.filter((session) => deviceId(session) === id);
      if (gone.length === 0) return false;
      forget(gone);
      return true;
    },
    revokeAll: () => forget(sessions),
    /** Closes every open remote connection, keeping the pairings (turning access off). */
    disconnectAll: () => disconnect([...connections.keys()]),
    /**
     * Retires this access for good: its open connections close, its pairing link goes, and it
     * authorizes, pairs and connects nothing more. Pairings stay saved for the access that
     * replaces it.
     */
    close: () => {
      closed = true;
      invitation = undefined;
      disconnect([...connections.keys()]);
    },
    /** Registers `close` for as long as a connection of `session` stays open. */
    onDisconnect: (session: RemoteSession, close: () => void): (() => void) => {
      // A connection that arrives after this access closed is closed at once.
      if (closed) {
        close();
        return () => {};
      }
      const closers = connections.get(session.hash) ?? new Set();
      closers.add(close);
      connections.set(session.hash, closers);
      return () => {
        closers.delete(close);
        if (closers.size === 0 && connections.get(session.hash) === closers)
          connections.delete(session.hash);
      };
    },
    authorize: (request: AuthRequest): AuthDecision => {
      if (closed) return { kind: "reject", status: 401, message: "unauthorized: access closed" };
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
        LOCAL_ONLY_PATHS.has(target.path) ||
        target.searchParams.has("boot")
      )
        return { kind: "reject", status: 403, message: "forbidden: local access only" };
      const session = sessionOf(request);
      if (session === undefined)
        return { kind: "reject", status: 401, message: "unauthorized: pair this browser locally" };
      touch(session);
      return { kind: "pass" };
    },
  };
};
