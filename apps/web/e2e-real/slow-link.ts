// A slow connection between a browser and the harness server: a proxy on its own port that
// delays and paces the bytes on the wire, both ways, for pages, files and the socket alike.
// DevTools' own throttling isn't used because it paces a socket's messages after they are
// inflated, so it can't show what compression saves.
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import type { Duplex, Readable, Writable } from "node:stream";

export interface LinkProfile {
  /** Added to everything, each way. */
  readonly latencyMs: number;
  /** Bytes a second each way; `Infinity` for no limit. */
  readonly bytesPerSecond: number;
}

/** Chrome DevTools' "Slow 3G" preset: 400 ms each way, 400 kbit/s both ways. */
export const SLOW_3G: LinkProfile = { latencyMs: 400, bytesPerSecond: (400 * 1000) / 8 };
export const UNLIMITED: LinkProfile = { latencyMs: 0, bytesPerSecond: Infinity };

export interface SlowLink {
  /** e.g. `http://127.0.0.1:51300`: where a page goes to reach the server through the link. */
  readonly origin: string;
  /** Changes the link for everything sent from now on, open connections included. */
  set(profile: LinkProfile): void;
  /** Bytes carried towards the browser since the last call, as they were on the wire. */
  takeBytesDown(): number;
  close(): Promise<void>;
}

/** One direction of the link: every connection's bytes queue behind each other, as on one radio. */
class Lane {
  private freeAt = 0;
  private lastAt = 0;
  private readonly queue: Array<{ at: number; run: () => void }> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  carried = 0;
  private readonly profile: () => LinkProfile;
  constructor(profile: () => LinkProfile) {
    this.profile = profile;
  }

  /** Runs `run` when the link would have delivered `bytes` sent now, never out of order. */
  after(bytes: number, run: () => void): void {
    const { latencyMs, bytesPerSecond } = this.profile();
    this.carried += bytes;
    const now = performance.now();
    this.freeAt = Math.max(now, this.freeAt) + (bytes / bytesPerSecond) * 1000;
    this.lastAt = Math.max(this.lastAt, this.freeAt + latencyMs);
    this.queue.push({ at: this.lastAt, run });
    this.drain();
  }

  private drain(): void {
    if (this.timer !== undefined) return;
    while (this.queue.length > 0 && this.queue[0]!.at <= performance.now()) {
      this.queue.shift()!.run();
    }
    const next = this.queue[0];
    if (next === undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.drain();
    }, next.at - performance.now());
  }

  pipe(from: Readable, to: Writable): void {
    from.on("data", (chunk: Buffer) =>
      this.after(chunk.byteLength, () => {
        if (!to.destroyed) to.write(chunk);
      }),
    );
    from.on("end", () => this.after(0, () => to.end()));
    from.on("error", () => to.destroy());
  }
}

/**
 * Starts the link in front of the server at `target()` (read for each connection, since a restart
 * moves the server). Requests reach the server under its own Host and Origin, as if the browser had
 * gone to it directly, so its allowlist and cookie apply unchanged.
 */
export async function startSlowLink(target: () => string): Promise<SlowLink> {
  let profile = UNLIMITED;
  const up = new Lane(() => profile);
  const down = new Lane(() => profile);
  const sockets = new Set<Socket | Duplex>();

  const rewritten = (headers: IncomingHttpHeaders, own: string): IncomingHttpHeaders => {
    const to = new URL(target());
    const out: IncomingHttpHeaders = { ...headers, host: to.host };
    if (headers.origin === own) out.origin = to.origin;
    if (typeof headers.referer === "string") out.referer = headers.referer.replace(own, to.origin);
    return out;
  };

  const server = createServer((request, response) => {
    const own = `http://${request.headers.host}`;
    const upstream = httpRequest(
      `${target()}${request.url}`,
      { method: request.method, headers: rewritten(request.headers, own), agent: false },
      (answer) => {
        // The head rides the link too: it waits its turn and the latency like the body.
        const head = Object.entries(answer.headers).reduce(
          (bytes, [name, value]) => bytes + name.length + String(value).length + 4,
          20,
        );
        down.after(head, () => response.writeHead(answer.statusCode ?? 502, answer.headers));
        down.pipe(answer, response);
      },
    );
    upstream.on("error", () => response.destroy());
    up.pipe(request, upstream);
  });

  server.on("upgrade", (request, client, head) => {
    const own = `http://${request.headers.host}`;
    const to = new URL(target());
    const upstream = connect(Number(to.port), to.hostname);
    sockets.add(client);
    sockets.add(upstream);
    const lines = [`${request.method} ${request.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(rewritten(request.headers, own))) {
      for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`);
    }
    upstream.on("connect", () => {
      const opening = Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`), head]);
      up.after(opening.byteLength, () => upstream.write(opening));
      up.pipe(client, upstream);
      down.pipe(upstream, client);
    });
    const drop = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    upstream.on("error", drop);
    client.on("error", drop);
    upstream.on("close", drop);
    client.on("close", drop);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    set: (next) => {
      profile = next;
    },
    takeBytesDown: () => {
      const out = down.carried;
      down.carried = 0;
      return out;
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
