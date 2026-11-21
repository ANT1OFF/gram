// The real-socket helpers of the HTTP server's tests: raw requests and upgrades as a browser or
// another client makes them, each carrying the origin key the page holds unless a test asks not.

import { randomBytes } from "node:crypto";
import { type IncomingHttpHeaders, request as httpRequest } from "node:http";
import * as Effect from "effect/Effect";
import { HttpServer } from "../platform/unstable.ts";
import { ORIGIN_KEY_HEADER } from "./auth.ts";
import { LaunchToken, serverPort } from "./server.ts";

export interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/**
 * The origin key of the server `serverInfo` last read, which the page holds: every local request
 * here carries it, as the web app's do, unless a test asks for one without (`noKey`).
 */
let launchKey: string | undefined;
export const keyed = (
  headers: Record<string, string> = {},
  noKey = false,
): Record<string, string> =>
  noKey || launchKey === undefined ? headers : { [ORIGIN_KEY_HEADER]: launchKey, ...headers };

export const raw = (
  port: number,
  options: {
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    noKey?: boolean;
  } = {},
) =>
  Effect.promise(
    () =>
      new Promise<RawResponse>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: options.path ?? "/",
            method: options.method ?? "GET",
            headers: keyed(options.headers, options.noKey),
            // A fresh connection per request: a rejected upgrade leaves its socket unusable.
            agent: false,
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => (body += chunk));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
            );
          },
        );
        req.on("error", reject);
        req.end(options.body);
      }),
  );

/** The status a WebSocket upgrade of `/ws` gets: 101 when accepted. */
export const upgradeStatus = (
  port: number,
  headers: Record<string, string>,
  path = "/ws",
  noKey = false,
) =>
  Effect.promise(
    () =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest({
          host: "127.0.0.1",
          port,
          path,
          agent: false,
          headers: {
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": randomBytes(16).toString("base64"),
            ...keyed(headers, noKey),
          },
        });
        req.on("upgrade", (_res, socket) => {
          socket.destroy();
          resolve(101);
        });
        req.on("response", (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      }),
  );

/** A remote `/ws` upgrade held open, with a promise for when the server closes it. */
export const openSocket = (port: number, headers: Record<string, string>, path = "/ws") =>
  Effect.promise(
    () =>
      new Promise<{ closed: Promise<void>; isOpen: () => boolean }>((resolve, reject) => {
        const req = httpRequest({
          host: "127.0.0.1",
          port,
          path,
          agent: false,
          headers: {
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": randomBytes(16).toString("base64"),
            ...headers,
          },
        });
        req.on("upgrade", (_res, socket) => {
          let open = true;
          socket.resume();
          const closed = new Promise<void>((done) =>
            socket.once("close", () => {
              open = false;
              done();
            }),
          );
          resolve({ closed, isOpen: () => open });
        });
        req.on("response", (res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
        req.on("error", reject);
        req.end();
      }),
  );

export const serverInfo = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const { token, cookie, originKey } = yield* LaunchToken;
  launchKey = originKey;
  return { port: serverPort(server), token, cookie, originKey };
});

/** Performs the boot navigation and returns the resulting `Cookie` header value. */
export const bootCookie = Effect.gen(function* () {
  const { port, token } = yield* serverInfo;
  const response = yield* raw(port, { path: `/?boot=${token}` });
  const setCookie = response.headers["set-cookie"]?.[0] ?? "";
  return setCookie.split(";")[0] ?? "";
});
