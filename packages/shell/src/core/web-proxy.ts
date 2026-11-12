// The web session's own proxy (`modules/preview`): every connection the Preview tab's web session
// makes goes through it, an HTTP proxy on loopback that this process owns. Chromium hands it the
// host name, unresolved, and it resolves the name once, checks every address (`proxyTargets`) and
// connects to one of those very addresses, so what was checked is what is reached: no second
// lookup, cache or other resolver can send the connection elsewhere. HTTPS and WebSockets are
// CONNECT tunnels, end to end, so a site's certificate is still checked against its name; plain
// http is forwarded one request at a time. It answers only a client with the credential made at
// launch, which Chromium gets from the app's `login` event, so no other process on this computer
// can use it as a way out.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  Agent,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { connect, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import { performance } from "node:perf_hooks";

import {
  destinationKey,
  hostZone,
  hostnameOf,
  proxyTargets,
  type WebLookup,
} from "./preview-rules.ts";

/** Opens a TCP connection to an address the proxy checked. */
export type WebDial = (address: string, port: number) => Socket;

export interface WebProxyOptions {
  /** The one lookup, the system's by default. */
  readonly lookup?: WebLookup | undefined;
  readonly dial?: WebDial | undefined;
  /**
   * The one private destination it reaches (`destinationKey`, `10.0.0.1:80`): a private network
   * page's own session's proxy, opened there by the user. Any other private address or name,
   * whatever asks for it (a frame, WebRTC, a preconnect), is refused. Fixed for its life; none for
   * the shared session's proxy, which reaches no private network at all.
   */
  readonly privateDestination?: string | undefined;
  /** Told of what the server itself can't do, such as accept a connection. */
  readonly onError?: ((error: Error) => void) | undefined;
}

export interface WebProxy {
  readonly port: number;
  /** The realm it asks for its credential in, so the `login` event answers only it. */
  readonly realm: string;
  readonly username: string;
  readonly password: string;
  close(): Promise<void>;
}

/** The system resolver's addresses for `host`, as getaddrinfo answers. */
export const systemLookup: WebLookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

const dialDirect: WebDial = (address, port) => connect({ host: address, port });

/** How long a lookup may take, and all of one connection's dialling together. */
export const LOOKUP_MS = 10_000;
export const DIAL_MS = 15_000;
/** The most clients served at once; more wait for the operating system to queue them. */
export const MAX_CLIENTS = 256;

/** `lookup`'s answer, or `undefined` for a failure, an empty answer or one too slow. */
export async function boundedLookup(
  lookup: WebLookup,
  host: string,
  ms = LOOKUP_MS,
): Promise<readonly string[] | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      Promise.resolve().then(() => lookup(host)),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
    return Array.isArray(answer) && answer.length > 0 ? answer : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Opens the first of `addresses` that answers, in order, within `DIAL_MS` for them all; stops as
 * soon as `signal` aborts, leaving nothing open. `undefined` when none answered.
 */
async function dialFirst(
  dial: WebDial,
  addresses: readonly string[],
  port: number,
  signal: AbortSignal,
): Promise<Socket | undefined> {
  // Monotonic, so a change to the wall clock neither stretches nor cuts it.
  const deadline = performance.now() + DIAL_MS;
  for (const address of addresses) {
    if (signal.aborted || performance.now() >= deadline) return undefined;
    const socket = await new Promise<Socket | undefined>((resolve) => {
      let upstream: Socket;
      try {
        upstream = dial(address, port);
      } catch {
        resolve(undefined);
        return;
      }
      const done = (result: Socket | undefined) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", fail);
        upstream.off("error", fail);
        resolve(result);
      };
      const fail = () => {
        upstream.destroy();
        done(undefined);
      };
      const timer = setTimeout(fail, Math.max(0, deadline - performance.now()));
      signal.addEventListener("abort", fail, { once: true });
      upstream.once("error", fail);
      upstream.once("connect", () => done(upstream));
    });
    if (socket !== undefined) return socket;
  }
  return undefined;
}

/** Headers that belong to one hop, never passed on. */
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const forwardable = (headers: IncomingHttpHeaders): OutgoingHttpHeaders => {
  const named = new Set(
    (typeof headers.connection === "string" ? headers.connection : "")
      .split(",")
      .map((name) => name.trim().toLowerCase()),
  );
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP.has(name) && !named.has(name)),
  );
};

/** Starts the proxy on a loopback port of its own, with a credential made for this launch. */
export async function startWebProxy(options: WebProxyOptions = {}): Promise<WebProxy> {
  const lookup = options.lookup ?? systemLookup;
  const dial = options.dial ?? dialDirect;
  const privateDestination = options.privateDestination;
  const realm = `gram-web-${randomBytes(8).toString("hex")}`;
  const username = "gram";
  const password = randomBytes(24).toString("base64url");
  const expected = Buffer.from(
    `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  );
  const authorized = (header: string | undefined) => {
    if (header === undefined) return false;
    const given = Buffer.from(header);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const challenge = `Basic realm="${realm}"`;

  /** Where a client may connect to `host:port`, looked up once and checked; `undefined` refuses. */
  const targets = async (host: string, port: number) => {
    const hostname = hostnameOf(host);
    if (hostname === undefined) return undefined;
    const allowPrivate =
      privateDestination !== undefined && destinationKey(hostname, port) === privateDestination;
    // A literal needs no lookup, nor a loopback or (here) unreachable private name; any other
    // name gets exactly one, bounded and failing closed.
    const named = hostZone(hostname);
    const needsLookup =
      isIP(hostname.replace(/^\[|\]$/g, "")) === 0 &&
      named !== "loopback" &&
      (named === "public" || allowPrivate);
    const addresses = needsLookup ? await boundedLookup(lookup, hostname) : undefined;
    return proxyTargets(hostname, addresses, allowPrivate);
  };

  const server = createServer();
  server.maxConnections = MAX_CLIENTS;
  server.on("error", (error) => options.onError?.(error));
  server.on("clientError", (_error, socket) => socket.destroy());

  // HTTPS and WebSockets: a tunnel to a checked address.
  server.on("connect", (req: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on("error", () => client.destroy());
    if (!authorized(req.headers["proxy-authorization"])) {
      client.end(
        `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: ${challenge}\r\nContent-Length: 0\r\n\r\n`,
      );
      return;
    }
    const at = /^(.+):(\d{1,5})$/.exec(req.url ?? "");
    const port = Number(at?.[2]);
    if (at === null || port < 1 || port > 65_535) {
      client.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const aborted = new AbortController();
    client.once("close", () => aborted.abort());
    void (async () => {
      const allowed = await targets(at[1]!, port);
      if (allowed === undefined) {
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const upstream = await dialFirst(dial, allowed, port, aborted.signal);
      if (upstream === undefined) {
        if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      if (client.destroyed) {
        upstream.destroy();
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    })();
  });

  // Plain http: one request at a time, to a checked address.
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    if (!authorized(req.headers["proxy-authorization"])) {
      res.writeHead(407, { "proxy-authenticate": challenge, "content-length": "0" }).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.protocol !== "http:" || url.username !== "" || url.password !== "") {
      res.writeHead(400).end();
      return;
    }
    const port = url.port === "" ? 80 : Number(url.port);
    const aborted = new AbortController();
    res.once("close", () => aborted.abort());
    void (async () => {
      const allowed = await targets(url.hostname, port);
      if (allowed === undefined) {
        res
          .writeHead(403, { "content-type": "text/plain; charset=utf-8" })
          .end(
            `Gram's Preview pane doesn't open ${url.host}: a page there can't reach this computer, ` +
              "a private network it wasn't opened on, or a public name that points at one.\n",
          );
        return;
      }
      const upstream = await dialFirst(dial, allowed, port, aborted.signal);
      if (upstream === undefined) {
        if (!res.headersSent && !res.destroyed)
          res
            .writeHead(502, { "content-type": "text/plain; charset=utf-8" })
            .end(
              `Gram's Preview pane couldn't connect to ${url.host}. It connects directly, not ` +
                "through a system or PAC proxy; open the page in your own browser instead.\n",
            );
        return;
      }
      // An agent of its own, whose one connection is the socket to the address just checked.
      const agent = new Agent({ keepAlive: false });
      agent.createConnection = () => upstream;
      const outgoing = httpRequest({
        host: allowed[0],
        port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: { ...forwardable(req.headers), host: url.host, connection: "close" },
        agent,
      });
      outgoing.on("response", (incoming) => {
        res.writeHead(incoming.statusCode ?? 502, forwardable(incoming.headers));
        incoming.pipe(res);
      });
      outgoing.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.destroy();
      });
      res.once("close", () => upstream.destroy());
      req.pipe(outgoing);
    })();
  });

  // An upgrade that isn't a tunnel: Chromium tunnels its WebSockets, so nothing else asks for one.
  server.on("upgrade", (_req: IncomingMessage, socket: Duplex) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no proxy port");
  return {
    port: address.port,
    realm,
    username,
    password,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
