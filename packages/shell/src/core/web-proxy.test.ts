import { once } from "node:events";
import { connect, createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { startWebProxy, type WebProxy } from "./web-proxy.ts";
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

/** A SOCKS5 CONNECT to `host:port` through the proxy: its reply code, and what came back. */
async function socksConnect(proxy: WebProxy, host: string, port: number) {
  const socket: Socket = connect({ host: "127.0.0.1", port: proxy.port });
  await once(socket, "connect");
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  const closed = once(socket, "close");
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  const name = Buffer.from(host, "latin1");
  const request = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
    name,
    Buffer.from([port >> 8, port & 0xff]),
  ]);
  socket.write(request);
  await closed;
  const all = Buffer.concat(chunks);
  // The method choice, then the reply, then the target's bytes.
  return { code: all[3], body: all.subarray(12).toString() };
}

describe("the web session's proxy", () => {
  const owned: Array<{ close(): Promise<unknown> }> = [];
  afterEach(async () => {
    for (const item of owned.splice(0)) await item.close();
  });

  /** Names resolve as `answers` says; a "public" address is dialled at the loopback target. */
  const start = async (lookup: WebLookup) => {
    const proxy = await startWebProxy({
      lookup,
      dial: (address, port) =>
        connect({ host: address === "93.184.216.34" ? "127.0.0.1" : address, port }),
    });
    owned.push(proxy);
    return proxy;
  };

  it("connects a public name to the address it checked", async () => {
    const site = await target();
    owned.push(site);
    const proxy = await start(async () => ["93.184.216.34"]);
    expect(await socksConnect(proxy, "site.example", site.port)).toEqual({
      code: 0x00,
      body: "hello",
    });
    expect(site.reached).toHaveLength(1);
  });

  it("refuses a name that resolves to loopback or a private address, and reaches nothing", async () => {
    const gram = await target();
    owned.push(gram);
    for (const answer of [["127.0.0.1"], ["93.184.216.34", "127.0.0.1"], ["10.0.0.1"]]) {
      const proxy = await start(async () => answer);
      expect((await socksConnect(proxy, "rebind.example", gram.port)).code).toBe(0x02);
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
    });
    for (const host of ["127.0.0.1", "localhost", "gram.localhost", "0.0.0.0"]) {
      expect((await socksConnect(proxy, host, gram.port)).code, host).toBe(0x02);
    }
    expect(gram.reached).toEqual([]);
    expect(lookups).toBe(0);
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
      expect((await socksConnect(proxy, "flaky.example", gram.port)).code).toBe(0x02);
    }
    expect(gram.reached).toEqual([]);
  });

  it("looks a name up once per connection, so a second answer can't redirect it", async () => {
    const gram = await target();
    owned.push(gram);
    const answers = [["93.184.216.34"], ["127.0.0.1"]];
    let calls = 0;
    const proxy = await start(async () => answers[Math.min(calls++, 1)]!);
    // The first connection is checked and dialled against its own answer; the second, rebound,
    // is refused. Nothing ever reaches the loopback listener by the rebound answer.
    const first = await socksConnect(proxy, "flip.example", gram.port);
    const second = await socksConnect(proxy, "flip.example", gram.port);
    expect(first.code).toBe(0x00);
    expect(second.code).toBe(0x02);
    expect(calls).toBe(2);
  });
});
