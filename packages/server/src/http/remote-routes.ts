import { MAX_REMOTE_DEVICES, type RemoteAccessStatus } from "@gram/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import { HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";
import {
  REMOTE_DISABLE_PATH,
  REMOTE_ENABLE_PATH,
  REMOTE_PAIR_PATH,
  REMOTE_REVOKE_PATH,
  REMOTE_STATUS_PATH,
  type RemoteAccess,
} from "./remote-access.ts";
import type { RemoteSession } from "./remote-sessions.ts";
import type { RemoteControlShape } from "./remote-control.ts";

/** Phone access settings, answered by the auth middleware itself and never by a route. */
export const REMOTE_MANAGEMENT_PATHS: ReadonlySet<string> = new Set([
  REMOTE_PAIR_PATH,
  REMOTE_STATUS_PATH,
  REMOTE_ENABLE_PATH,
  REMOTE_DISABLE_PATH,
  REMOTE_REVOKE_PATH,
]);

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });
const refuse = (message: string, status = 403) => HttpServerResponse.text(message, { status });

const UNSAVED = "Removed, but it couldn't be saved, so it comes back when Gram restarts";

/** Runs a removal, which takes effect at once; false when saving it failed. */
const keepRemoval = (removal: () => unknown): boolean => {
  try {
    removal();
    return true;
  } catch {
    return false;
  }
};

/** A small JSON object body, or undefined for anything else. */
const smallJson = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (Number(request.headers["content-length"] ?? 0) > 256) return undefined;
  const text = yield* request.text.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(256)),
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (text === undefined) return undefined;
  if (text === "") return {};
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
});

/**
 * Answers an authorized `/remote/*` management request. `remote` is set when a paired browser
 * asks: it may read the status and remove itself, nothing more. The local app may also pair,
 * switch access and remove any browser. Every call is a POST carrying an Origin, so a page on
 * another origin can neither read nor forge one.
 */
export const remoteManagement = (
  control: RemoteControlShape,
  path: string,
  remote: RemoteAccess | undefined,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== "POST" || request.headers["origin"] === undefined)
      return path === REMOTE_PAIR_PATH ? refuse("pairing unavailable") : refuse("forbidden");
    if (remote !== undefined) {
      const session = remote.sessionOf({
        method: request.method,
        url: request.url,
        headers: request.headers,
        cookies: request.cookies,
      });
      if (session === undefined) return refuse("unauthorized", 401);
      const own = remote.deviceIdOf(session);
      if (path === REMOTE_STATUS_PATH) {
        const { pairing: _pairing, ...status } = yield* control.status;
        return json({ ...status, current: own } satisfies RemoteAccessStatus);
      }
      if (path === REMOTE_REVOKE_PATH) {
        const body = yield* smallJson;
        if (body?.["id"] !== own) return refuse("forbidden: remove other browsers locally");
        const saved = keepRemoval(() => remote.revoke(own));
        return yield* HttpServerResponse.text(saved ? "removed" : UNSAVED, {
          status: saved ? 200 : 500,
        }).pipe(
          HttpServerResponse.expireCookie(remote.cookieName, {
            secure: true,
            httpOnly: true,
            sameSite: "strict",
            path: "/",
          }),
          Effect.orDie,
        );
      }
      return refuse("forbidden: local access only");
    }
    const current = control.current();
    switch (path) {
      case REMOTE_PAIR_PATH:
        if (current === undefined) return refuse("pairing unavailable");
        if (current.devices().length >= MAX_REMOTE_DEVICES)
          return json({ reason: "full", max: MAX_REMOTE_DEVICES }, 409);
        return json(current.mint());
      case REMOTE_STATUS_PATH:
        return json(yield* control.status);
      case REMOTE_ENABLE_PATH: {
        const body = yield* smallJson;
        const port = body?.["port"];
        if (
          body === undefined ||
          (port !== undefined &&
            !(Number.isInteger(port) && Number(port) > 0 && Number(port) < 65536))
        )
          return refuse("bad request", 400);
        return yield* control.enable(port === undefined ? undefined : Number(port)).pipe(
          Effect.map((status) => json(status)),
          Effect.catchTag("RemoteRefused", (error) =>
            Effect.succeed(json({ message: error.message }, 409)),
          ),
        );
      }
      case REMOTE_DISABLE_PATH:
        return yield* control.disable.pipe(
          Effect.map((status) => json(status)),
          Effect.catchTag("RemoteRefused", (error) =>
            Effect.succeed(json({ message: error.message }, 409)),
          ),
        );
      case REMOTE_REVOKE_PATH: {
        const body = yield* smallJson;
        if (current === undefined) return refuse("phone access is off", 409);
        const id = body?.["id"];
        if (
          body?.["all"] !== true &&
          (typeof id !== "string" || !current.devices().some((d) => d.id === id))
        )
          return refuse("no such browser", 404);
        const saved = keepRemoval(() =>
          body?.["all"] === true ? current.revokeAll() : current.revoke(String(id)),
        );
        return saved ? json(yield* control.status) : json({ message: UNSAVED }, 500);
      }
      default:
        return refuse("forbidden");
    }
  });

/** Runs a remote WebSocket until it ends or its browser is removed or access turns off. */
export const closedOnRevoke = <E, R>(
  remote: RemoteAccess,
  session: RemoteSession | undefined,
  socket: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  session === undefined
    ? Effect.succeed(refuse("unauthorized", 401))
    : Effect.raceFirst(
        socket,
        Effect.callback<HttpServerResponse.HttpServerResponse>((resume) => {
          const off = remote.onDisconnect(session, () =>
            resume(Effect.succeed(refuse("signed out", 401))),
          );
          return Effect.sync(off);
        }),
      );
