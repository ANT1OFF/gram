// What Squirrel.Mac downloads the update from: a loopback feed Gram owns for one staging attempt,
// serving the verified snapshot's descriptor (`native-snapshot.ts`), never electron-updater's
// shared cache path. The ZIP response completes only when the served bytes' SHA-256 is the
// verified one.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { CandidateSnapshot } from "./native-snapshot.ts";

/** Squirrel.Mac asks for the feed, then the ZIP; a couple of retries at most. */
const FEED_REQUESTS = 4;
const ZIP_REQUESTS = 2;

export interface SquirrelFeed {
  /** Squirrel.Mac's feed URL for this attempt; main-only, never logged. */
  readonly feedURL: string;
  close(): Promise<void>;
}

export async function createSquirrelFeed(
  snapshot: CandidateSnapshot,
  version: string,
): Promise<SquirrelFeed> {
  const capability = randomBytes(32).toString("hex");
  const feedPath = `/${capability}/feed`;
  const zipPath = `/${capability}/candidate.zip`;
  let port = 0;
  let feeds = 0;
  let zips = 0;
  let closed = false;
  const serve = (req: IncomingMessage, res: ServerResponse) => {
    const refuse = (status: number) => {
      res.writeHead(status, { Connection: "close", "Cache-Control": "no-store" });
      res.end();
    };
    if (
      closed ||
      req.method !== "GET" ||
      req.headers.host !== `127.0.0.1:${port}` ||
      req.socket.remoteAddress !== "127.0.0.1" ||
      req.headers.range !== undefined ||
      (req.url !== feedPath && req.url !== zipPath)
    )
      return refuse(404);
    if (req.url === feedPath) {
      if (++feeds > FEED_REQUESTS) return refuse(429);
      const body = JSON.stringify({ url: `http://127.0.0.1:${port}${zipPath}`, name: version });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        Connection: "close",
      });
      res.end(body);
      return;
    }
    if (++zips > ZIP_REQUESTS) return refuse(429);
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Length": snapshot.size,
      "Cache-Control": "no-store",
      Connection: "close",
    });
    void snapshot
      .deliver(
        (chunk) =>
          new Promise<void>((resolve, reject) => {
            if (res.destroyed) return reject(new Error("Squirrel.Mac went away."));
            res.write(chunk, (error) => (error ? reject(error) : resolve()));
          }),
      )
      .then(
        () => res.end(),
        () => res.destroy(),
      );
  };
  const server = createServer({ requestTimeout: 10 * 60_000 }, (req, res) => {
    try {
      serve(req, res);
    } catch {
      res.destroy();
    }
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      port = typeof address === "object" && address ? address.port : 0;
      resolve();
    });
  });
  return {
    feedURL: `http://127.0.0.1:${port}${feedPath}`,
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
