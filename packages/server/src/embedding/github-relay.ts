import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { embeddingOn, type ThreadId } from "@gram/contracts";
import { ENDPOINT_UNUSABLE, type EndpointConfig, ServerConfig } from "../config.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { bytesOf } from "../shared/bytes.ts";

/** A relay configured on a server that runs work itself: refused at start. */
export const GITHUB_ROUTE_NEEDS_HEADLESS =
  "GRAM_GITHUB_ROUTE_URL is for a headless control plane (GRAM_HEADLESS=1), which runs no agent that could inherit it.";

/**
 * The relay's answer to a call made for no thread, which it never sends on: the route can hold a
 * read to what a thread may see only when it knows the thread, and an answer read for nobody in
 * particular could otherwise reach an agent.
 */
export const NO_THREAD =
  "this GitHub call names no thread, and behind a GitHub route every call must name the thread it is made for.";

const PLACEHOLDER = "gram-relay";
const THREAD_PREFIX = "gram-thread:";
const THREAD_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

const ROUTES: Readonly<Record<string, string>> = {
  "api.github.com": "api",
  "uploads.github.com": "uploads",
  "codeload.github.com": "codeload",
};

const DROPPED_REQUEST = new Set([
  "authorization",
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "x-gram-thread",
  "x-gram-upstream-host",
]);
const DROPPED_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "content-encoding",
  "content-length",
]);

const MAX_REQUEST_BYTES = 1024 * 1024;
const CALL_TIMEOUT_MS = 60_000;

let relaying = false;

/**
 * The environment a `gh` call made for `threadId` runs with: its handle, where a relay runs, and
 * nothing anywhere else, so a person's own `gh` sign-in is never overridden.
 */
export const ghThreadEnv = (threadId: ThreadId | string): Readonly<Record<string, string>> =>
  relaying && THREAD_ID.test(threadId) ? { GH_TOKEN: `${THREAD_PREFIX}${threadId}` } : {};

/** Whether this server's `gh` goes through a relay: true once one started. */
export const githubRelayed = (): boolean => relaying;

/** The thread a request's `Authorization` names, if it names one. */
export const threadOfAuthorization = (value: string | undefined): string | undefined => {
  const match = /^(?:token|bearer)\s+(\S+)$/i.exec(value?.trim() ?? "");
  const credential = match?.[1];
  if (credential === undefined || !credential.startsWith(THREAD_PREFIX)) return undefined;
  const id = credential.slice(THREAD_PREFIX.length);
  return THREAD_ID.test(id) ? id : undefined;
};

const bearerOf = async (endpoint: EndpointConfig): Promise<string | undefined> => {
  if (endpoint.tokenFile === undefined) return endpoint.token;
  const token = (await readFile(endpoint.tokenFile, "utf8")).trim();
  if (!/^[\x21-\x7e]+$/.test(token)) throw new Error("the token file holds no usable token");
  return token;
};

const answer = (res: ServerResponse, status: number, message: string) => {
  if (res.headersSent) return void res.destroy();
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ message: `Gram's GitHub relay: ${message}` }));
};

const bodyOf = async (req: IncomingMessage): Promise<Buffer | undefined> => {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of bytesOf(req)) {
    size += chunk.byteLength;
    if (size > MAX_REQUEST_BYTES) return undefined;
    parts.push(chunk);
  }
  return Buffer.concat(parts);
};

/** One request from `gh`, sent on to the route; exported for its tests. */
export const relayRequest =
  (endpoint: EndpointConfig, fetchImpl: typeof fetch = fetch) =>
  async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = (req.headers.host ?? "").toLowerCase().replace(/:443$/, "");
    const kind = ROUTES[host];
    const path = req.url ?? "";
    if (kind === undefined) return answer(res, 400, `${host || "no host"} is not GitHub's`);
    if (!path.startsWith("/") || path.startsWith("//"))
      return answer(res, 400, "the request has no path");
    const body =
      req.method === "GET" || req.method === "HEAD" ? Buffer.alloc(0) : await bodyOf(req);
    if (body === undefined) return answer(res, 413, "the request is too large");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || DROPPED_REQUEST.has(name)) continue;
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    const thread = threadOfAuthorization(req.headers.authorization);
    if (thread === undefined) return answer(res, 403, NO_THREAD);
    let token: string | undefined;
    try {
      token = await bearerOf(endpoint);
    } catch {
      return answer(res, 502, "the route's token could not be read");
    }
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    headers["x-gram-upstream-host"] = host;
    headers["x-gram-thread"] = thread;
    let response: Response;
    try {
      response = await fetchImpl(`${endpoint.url.replace(/\/+$/, "")}/${kind}${path}`, {
        method: req.method ?? "GET",
        headers,
        ...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      return answer(res, 502, "the route did not answer");
    }
    const out: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (!DROPPED_RESPONSE.has(name)) out[name] = value;
    });
    res.writeHead(response.status, out);
    if (response.body === null) return void res.end();
    try {
      for await (const chunk of response.body) res.write(chunk);
    } catch {
      return void res.destroy();
    }
    res.end();
  };

/** The folder the relay keeps `gh`'s config and its socket in, under the server's data. */
export const relayFolder = (dataDir: string) => join(dataDir, "github-relay");

/** `gh`'s config pointing it at `socket`. */
export const ghConfig = (socket: string) =>
  `# Written by Gram: every gh this server runs goes through its GitHub relay.\nhttp_unix_socket: ${JSON.stringify(socket)}\nprompt: disabled\n`;

/**
 * Starts the relay where one is configured, for as long as the server runs, and points every
 * `gh` the server starts at it. Inert while the hosted features are off. A route that was given
 * and can't be used, or one on a server that runs work itself, fails the start: a control plane
 * whose `gh` silently reached GitHub some other way would be the wrong way to fail.
 */
export const GitHubRelayLive: Layer.Layer<never, Error, ServerConfig | ThreadStore> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const route = config.githubRoute;
      if (route === undefined) return;
      if (route === ENDPOINT_UNUSABLE)
        return yield* Effect.fail(
          new Error("GRAM_GITHUB_ROUTE_URL or its token can't be used; the server won't start."),
        );
      if (config.headless !== true)
        return yield* Effect.fail(new Error(GITHUB_ROUTE_NEEDS_HEADLESS));
      if (!embeddingOn(yield* (yield* ThreadStore).getSettings)) return;
      const folder = relayFolder(config.dataDir);
      const socket = join(folder, "gh.sock");
      const configDir = join(folder, "config");
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            await mkdir(configDir, { recursive: true, mode: 0o700 });
            await writeFile(join(configDir, "config.yml"), ghConfig(socket), { mode: 0o600 });
            await rm(socket, { force: true });
            const server = createServer((req, res) => {
              relayRequest(route)(req, res).catch(() => answer(res, 502, "the call failed"));
            });
            await new Promise<void>((resolve, reject) => {
              server.once("error", reject);
              server.listen(socket, () => resolve());
            });
            return server;
          },
          catch: (error) =>
            new Error(
              `Gram's GitHub relay could not start: ${error instanceof Error ? error.message : "unknown"}`,
            ),
        }),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                relaying = false;
                server.close(() => resolve());
              }),
          ),
      );
      process.env["GH_CONFIG_DIR"] = configDir;
      process.env["GH_TOKEN"] = PLACEHOLDER;
      delete process.env["GITHUB_TOKEN"];
      delete process.env["GH_ENTERPRISE_TOKEN"];
      relaying = true;
      yield* Effect.logInfo("GitHub relay: gh goes through the configured route");
    }),
  );
