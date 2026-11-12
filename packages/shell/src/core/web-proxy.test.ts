import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { boundedLookup, startWebProxy, type WebProxy } from "./web-proxy.ts";
import type { WebLookup } from "./preview-rules.ts";

/** A TCP listener on loopback that counts who reached it and answers each with "hello". */
async function target() {
  const reached: string[] = [];
  const server: Server = createServer((socket) => {
    reached.push(socket.remoteAddress ?? "");
    socket.end("hello");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return { reached, port, close: () => new Promise((resolve) => server.close(resolve)) };
}

const credential = (proxy: WebProxy) =>
  `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}`;

/** A plain http GET through the proxy, in the absolute form Chromium sends one: the raw reply. */
async function forward(proxy: WebProxy, url: string, authorization?: string) {
  const socket: Socket = connect({ host: "127.0.0.1", port: proxy.port });
  await once(socket, "connect");
  let text = "";
  socket.on("data", (chunk: Buffer) => (text += chunk.toString()));
  const closed = once(socket, "close");
  socket.write(
    `GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\nConnection: close\r\n` +
      (authorization === undefined ? "" : `Proxy-Authorization: ${authorization}\r\n`) +
      "\r\n",
  );
  await closed;
  return { status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1]), text };
}

/** A CONNECT to `host:port` through the proxy: its status code, and what came back after it. */
async function tunnel(proxy: WebProxy, host: string, port: number, authorization?: string) {
  const socket: Socket = connect({ host: "127.0.0.1", port: proxy.port });
  await once(socket, "connect");
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  const closed = once(socket, "close");
  socket.write(
    `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n` +
      (authorization === undefined ? "" : `Proxy-Authorization: ${authorization}\r\n`) +
      "\r\n",
  );
  await closed;
  const text = Buffer.concat(chunks).toString();
  return {
    status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1]),
    body: text.split("\r\n\r\n").slice(1).join("\r\n\r\n"),
    challenge: /Proxy-Authenticate: (.+)\r\n/.exec(text)?.[1],
  };
}

const publicLookup: WebLookup = async () => ["93.184.216.34"];
const never: WebLookup = () => new Promise(() => {});

describe("the web session's proxy", () => {
  const owned: Array<{ close(): Promise<unknown> }> = [];
  afterEach(async () => {
    for (const item of owned.splice(0)) await item.close();
  });

  /** Names resolve as `lookup` says; the "public" address, and 10.77.0.9, dial the loopback target. */
  const start = async (lookup: WebLookup, allowPrivate = false) => {
    const proxy = await startWebProxy({
      lookup,
      allowPrivate,
      dial: (address, port) =>
        connect({
          host: address === "93.184.216.34" || address === "10.77.0.9" ? "127.0.0.1" : address,
          port,
        }),
    });
    owned.push(proxy);
    return proxy;
  };

  it("connects a public name to the address it checked, for its own credential", async () => {
    const site = await target();
    owned.push(site);
    const proxy = await start(publicLookup);
    expect(await tunnel(proxy, "site.example", site.port, credential(proxy))).toMatchObject({
      status: 200,
      body: "hello",
    });
    expect(site.reached).toHaveLength(1);
  });

  it("is no relay for anyone without its credential", async () => {
    const site = await target();
    owned.push(site);
    const proxy = await start(publicLookup);
    const none = await tunnel(proxy, "site.example", site.port);
    expect(none.status).toBe(407);
    expect(none.challenge).toBe(`Basic realm="${proxy.realm}"`);
    const wrong = `Basic ${Buffer.from(`${proxy.username}:guess`).toString("base64")}`;
    expect((await tunnel(proxy, "site.example", site.port, wrong)).status).toBe(407);
    expect(site.reached).toEqual([]);
    // Each launch makes its own.
    const other = await start(publicLookup);
    expect(other.password).not.toBe(proxy.password);
    expect((await tunnel(other, "site.example", site.port, credential(proxy))).status).toBe(407);
  });

  it("refuses a name that resolves to loopback or a private address, and reaches nothing", async () => {
    const gram = await target();
    owned.push(gram);
    for (const answer of [["127.0.0.1"], ["93.184.216.34", "127.0.0.1"], ["10.0.0.1"]]) {
      const proxy = await start(async () => answer);
      expect((await tunnel(proxy, "rebind.example", gram.port, credential(proxy))).status).toBe(
        403,
      );
    }
    expect(gram.reached).toEqual([]);
  });

  it("refuses loopback by its address or name, without a lookup", async () => {
    const gram = await target();
    owned.push(gram);
    let lookups = 0;
    const proxy = await start(async () => {
      lookups += 1;
      return ["93.184.216.34"];
    }, true);
    for (const host of ["127.0.0.1", "localhost", "gram.localhost", "0.0.0.0", "[::1]"]) {
      expect((await tunnel(proxy, host, gram.port, credential(proxy))).status, host).toBe(403);
    }
    expect(gram.reached).toEqual([]);
    expect(lookups).toBe(0);
  });

  it("reaches a private address only as a private network page's own session's proxy", async () => {
    const lan = await target();
    owned.push(lan);
    // The shared session's: a TURN server or preconnect on the office network reaches nothing,
    // and nothing it can be given changes that.
    const shared = await start(publicLookup);
    expect((await tunnel(shared, "10.77.0.9", lan.port, credential(shared))).status).toBe(403);
    expect(lan.reached).toEqual([]);
    // A private network page's own.
    const own = await start(publicLookup, true);
    expect((await tunnel(own, "10.77.0.9", lan.port, credential(own))).status).toBe(200);
    expect(lan.reached).toHaveLength(1);
    // Each has its own credential: one's doesn't open the other.
    expect((await tunnel(own, "10.77.0.9", lan.port, credential(shared))).status).toBe(407);
    expect(lan.reached).toHaveLength(1);
  });

  it("fails closed when the lookup rejects, throws or answers nothing", async () => {
    const gram = await target();
    owned.push(gram);
    const failing: WebLookup[] = [
      () => Promise.reject(new Error("SERVFAIL")),
      () => {
        throw new Error("resolver gone");
      },
      async () => [],
    ];
    for (const lookup of failing) {
      const proxy = await start(lookup);
      expect((await tunnel(proxy, "flaky.example", gram.port, credential(proxy))).status).toBe(403);
    }
    expect(gram.reached).toEqual([]);
  });

  it("looks a name up once per connection, so a second answer can't redirect it", async () => {
    const gram = await target();
    owned.push(gram);
    const answers = [["93.184.216.34"], ["127.0.0.1"]];
    let calls = 0;
    const proxy = await start(async () => answers[Math.min(calls++, 1)]!);
    const first = await tunnel(proxy, "flip.example", gram.port, credential(proxy));
    const second = await tunnel(proxy, "flip.example", gram.port, credential(proxy));
    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
    expect(calls).toBe(2);
  });

  it("forwards plain http to the checked address, and refuses in words a person can read", async () => {
    const seen: string[] = [];
    const site = createHttpServer((request, response) => {
      seen.push(
        `${request.headers.host} ${request.url} ${request.headers["proxy-authorization"] ?? ""}`,
      );
      response.writeHead(200, { "content-type": "text/plain" }).end("hello over http");
    });
    site.listen(0, "127.0.0.1");
    await once(site, "listening");
    owned.push({ close: () => new Promise((resolve) => site.close(resolve)) });
    const port = (site.address() as { port: number }).port;
    const proxy = await start(publicLookup);
    const ok = await forward(proxy, `http://site.example:${port}/page?x=1`, credential(proxy));
    expect(ok.status).toBe(200);
    expect(ok.text).toContain("hello over http");
    // The origin sees the page's own request, without the proxy's credential.
    expect(seen).toEqual([`site.example:${port} /page?x=1 `]);
    expect((await forward(proxy, `http://site.example:${port}/`)).status).toBe(407);
    const refused = await forward(proxy, `http://10.77.0.9:${port}/`, credential(proxy));
    expect(refused.status).toBe(403);
    expect(refused.text).toContain("Gram's Preview pane doesn't open 10.77.0.9");
    expect(seen).toHaveLength(1);
  });

  it("gives up on a lookup that never answers", async () => {
    expect(await boundedLookup(never, "slow.example", 20)).toBeUndefined();
    expect(await boundedLookup(publicLookup, "site.example", 20)).toEqual(["93.184.216.34"]);
  });
});
