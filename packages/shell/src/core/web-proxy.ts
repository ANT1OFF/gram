// The web session's own proxy (`modules/preview`): every connection the Preview tab's web session
// makes goes through it, a SOCKS5 proxy on loopback that this process owns. Chromium hands it the
// host name, unresolved, and it resolves the name once, checks every address (`proxyTargets`) and
// connects to one of those very addresses, so what was checked is what is reached: no second
// lookup, cache or other resolver can send the connection elsewhere. TLS is end to end through it,
// so a site's certificate is still checked against its name. CONNECT only; no UDP.

import { lookup as dnsLookup } from "node:dns/promises";
import { connect, createServer, isIP, type Server, type Socket } from "node:net";

import { hostZone, proxyTargets, type WebLookup } from "./preview-rules.ts";

/** Opens a TCP connection to an address the proxy checked. */
export type WebDial = (address: string, port: number) => Socket;

export interface WebProxyOptions {
  /** The one lookup, the system's by default. */
  readonly lookup?: WebLookup | undefined;
  readonly dial?: WebDial | undefined;
}

export interface WebProxy {
  readonly port: number;
  close(): Promise<void>;
}

/** The system resolver's addresses for `host`, as getaddrinfo answers. */
export const systemLookup: WebLookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

const dialDirect: WebDial = (address, port) => connect({ host: address, port });

/** How long a client has to ask for its connection, and a connection to open. */
const HANDSHAKE_MS = 15_000;

const REPLY = { ok: 0x00, failure: 0x01, notAllowed: 0x02, unreachable: 0x04, command: 0x07 };

const reply = (code: number) => Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);

/** An IPv6 address from its 16 bytes, as text the URL parser compresses. */
const ipv6 = (bytes: Buffer) =>
  Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(":");

/** One SOCKS5 CONNECT request, parsed from the start of `buffer`; `null` while it's incomplete. */
function parseRequest(
  buffer: Buffer,
): { command: number; host: string; port: number; length: number } | null | undefined {
  if (buffer.length < 5) return null;
  if (buffer[0] !== 0x05) return undefined;
  const command = buffer[1]!;
  const type = buffer[3];
  let host: string;
  let at: number;
  if (type === 0x01) {
    if (buffer.length < 10) return null;
    host = [...buffer.subarray(4, 8)].join(".");
    at = 8;
  } else if (type === 0x03) {
    const size = buffer[4]!;
    if (buffer.length < 5 + size + 2) return null;
    host = buffer.subarray(5, 5 + size).toString("latin1");
    at = 5 + size;
  } else if (type === 0x04) {
    if (buffer.length < 22) return null;
    host = ipv6(buffer.subarray(4, 20));
    at = 20;
  } else {
    return undefined;
  }
  return { command, host, port: buffer.readUInt16BE(at), length: at + 2 };
}

/** Opens the first of `addresses` that answers, in order; `undefined` if none does. */
async function dialFirst(
  dial: WebDial,
  addresses: readonly string[],
  port: number,
): Promise<Socket | undefined> {
  for (const address of addresses) {
    const socket = await new Promise<Socket | undefined>((resolve) => {
      let upstream: Socket;
      try {
        upstream = dial(address, port);
      } catch {
        resolve(undefined);
        return;
      }
      const timer = setTimeout(() => fail(), HANDSHAKE_MS);
      const fail = () => {
        clearTimeout(timer);
        upstream.destroy();
        resolve(undefined);
      };
      upstream.once("error", fail);
      upstream.once("connect", () => {
        clearTimeout(timer);
        upstream.off("error", fail);
        resolve(upstream);
      });
    });
    if (socket !== undefined) return socket;
  }
  return undefined;
}

/** Serves one client: greeting, one CONNECT, then bytes both ways. */
function serve(client: Socket, lookup: WebLookup, dial: WebDial) {
  let buffer = Buffer.alloc(0);
  let stage: "greeting" | "request" | "busy" = "greeting";
  const timer = setTimeout(() => client.destroy(), HANDSHAKE_MS);
  const refuse = (code: number) => {
    clearTimeout(timer);
    client.end(reply(code));
  };
  client.on("error", () => client.destroy());
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (stage === "greeting") {
      if (buffer.length < 2) return;
      const count = buffer[1]!;
      if (buffer[0] !== 0x05) return refuse(REPLY.failure);
      if (buffer.length < 2 + count) return;
      const methods = buffer.subarray(2, 2 + count);
      buffer = buffer.subarray(2 + count);
      if (!methods.includes(0x00)) {
        clearTimeout(timer);
        client.end(Buffer.from([0x05, 0xff]));
        return;
      }
      client.write(Buffer.from([0x05, 0x00]));
      stage = "request";
    }
    if (stage !== "request") return;
    const request = parseRequest(buffer);
    if (request === null) return;
    if (request === undefined) return refuse(REPLY.failure);
    if (request.command !== 0x01) return refuse(REPLY.command);
    stage = "busy";
    client.off("data", onData);
    client.pause();
    const rest = buffer.subarray(request.length);
    void open(request.host, request.port, rest);
  };
  const open = async (host: string, port: number, rest: Buffer) => {
    // A literal needs no lookup, nor a loopback name; any other name gets exactly one, failing
    // closed.
    let addresses: readonly string[] | undefined;
    if (isIP(host) === 0 && hostZone(host) !== "loopback") {
      try {
        addresses = await lookup(host);
      } catch {
        addresses = undefined;
      }
    }
    const targets = proxyTargets(host, Array.isArray(addresses) ? addresses : undefined);
    if (targets === undefined) return refuse(REPLY.notAllowed);
    const upstream = await dialFirst(dial, targets, port);
    if (client.destroyed) {
      upstream?.destroy();
      return;
    }
    if (upstream === undefined) return refuse(REPLY.unreachable);
    clearTimeout(timer);
    client.write(reply(REPLY.ok));
    if (rest.length > 0) upstream.write(rest);
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  };
  client.on("data", onData);
}

/** Starts the proxy on a loopback port of its own. */
export async function startWebProxy(options: WebProxyOptions = {}): Promise<WebProxy> {
  const lookup = options.lookup ?? systemLookup;
  const dial = options.dial ?? dialDirect;
  const server: Server = createServer((client) => serve(client, lookup, dial));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no proxy port");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
