// A host's sessions reaching their threads' app tools over the host's own connection
// (`app-tools-tunnel`), for a host that can't reach the control plane's address: one a hosted
// server started for a desktop's worker, whose connection that server relays
// (`docs/design/desktop-worker-machines.md`).
//
// The host serves `/host/mcp` on its own loopback, at an address only processes on that machine
// reach, and carries each call to the control plane as `host.appTools.requests`; the control plane
// answers it (`host.appTools.answer`) and the host writes the answer back to the session. The host
// checks nothing about the call: the control plane checks its token, and that its thread is placed
// on this machine, as it does for a call over the tailnet. A call the control plane never answers
// (its connection ended) gets a 503, so the session's tool says why rather than waiting for good.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  HOST_APP_TOOLS_MOST_CHARS,
  HostFailed,
  type HostAppToolsAnswer,
  type HostAppToolsRequest,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { HOST_MCP_PATH } from "./machine-keys.ts";

/** Why a relayed machine runs no session: its gram-host can't carry app tools over its connection. */
export const noAppToolsTunnel = (machine: string) =>
  `${machine}'s gram-host is older than this Gram and can't carry its sessions' app tools over its connection, so no session runs there. The hosted server that started it has to run a newer gram-host; leave out sandbox to run the worker on your machine.`;

/** What a host serves of `app-tools-tunnel`. */
export interface HostAppTools {
  /** Starts the loopback listener, once: the address its sessions are given. */
  readonly open: Effect.Effect<{ readonly url: string }, HostFailed>;
  /** Each call as a session makes it, for the control plane on this connection to answer. */
  readonly requests: Stream.Stream<HostAppToolsRequest, HostFailed>;
  readonly answer: (answer: HostAppToolsAnswer) => Effect.Effect<void, HostFailed>;
}

/** The headers a call carries to the control plane: what MCP over HTTP needs, and its token. */
const CALL_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
] as const;
/**
 * Headers a proxy that passed a request on adds. Not `sec-fetch-*`: Node's own `fetch`, which an
 * agent's MCP client may use, sends those too; a page in a browser is refused by its `Origin`.
 */
const FORWARDED = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
] as const;

/** The headers an answer carries back. */
const ANSWER_HEADERS = new Set(["content-type", "mcp-session-id"]);

const plain = (res: ServerResponse, status: number, text: string) => {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
};

/** One call waiting on its answer. `delivered`: the control plane was handed it. */
interface Waiting {
  readonly res: ServerResponse;
  delivered: boolean;
}

/** The tunnel's listener and its calls, kept for the host's life. */
export const makeAppToolsTunnel: Effect.Effect<HostAppTools, never, Scope.Scope> = Effect.gen(
  function* () {
    const calls = yield* Queue.unbounded<HostAppToolsRequest>();
    const waiting = new Map<string, Waiting>();
    let listening: Promise<string> | undefined;
    let server: Server | undefined;

    const take = (req: IncomingMessage, res: ServerResponse, host: string) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      // Only a process on this machine that names this address, never a page in a browser.
      if (url.pathname !== HOST_MCP_PATH) return plain(res, 404, "not found");
      if (
        req.headers["host"] !== host ||
        req.headers["origin"] !== undefined ||
        // Nor one a proxy passed on.
        FORWARDED.some((name) => req.headers[name] !== undefined)
      )
        return plain(res, 403, "forbidden");
      if (method !== "POST" && method !== "GET" && method !== "DELETE")
        return plain(res, 405, "method not allowed");
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > HOST_APP_TOOLS_MOST_CHARS) {
          plain(res, 413, "too large");
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (res.headersSent) return;
        const headers: Record<string, string> = {};
        for (const name of CALL_HEADERS) {
          const value = req.headers[name];
          if (typeof value === "string" && value.length <= 8192) headers[name] = value;
        }
        const id = randomUUID();
        waiting.set(id, { res, delivered: false });
        res.once("close", () => waiting.delete(id));
        Queue.offerUnsafe(calls, {
          id,
          method: method as HostAppToolsRequest["method"],
          headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    };

    const open = Effect.tryPromise({
      try: () => {
        listening ??= new Promise<string>((resolve, reject) => {
          const made = createServer();
          made.once("error", reject);
          made.listen(0, "127.0.0.1", () => {
            const address = made.address();
            if (typeof address !== "object" || address === null) {
              reject(new Error("no address"));
              return;
            }
            const host = `127.0.0.1:${address.port}`;
            made.on("request", (req, res) => take(req, res, host));
            server = made;
            resolve(`http://${host}`);
          });
        });
        return listening;
      },
      catch: () =>
        new HostFailed({ message: "The host couldn't serve app tools on its loopback." }),
    }).pipe(Effect.map((url) => ({ url })));

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const each of waiting.values()) plain(each.res, 503, "the host is stopping");
        waiting.clear();
        server?.close();
      }),
    );

    return {
      open,
      // The calls handed to this control plane and not answered when its stream ends (its
      // connection went) are answered 503; those not handed yet wait for the next.
      requests: Stream.fromQueue(calls).pipe(
        Stream.tap((call) =>
          Effect.sync(() => {
            const each = waiting.get(call.id);
            if (each !== undefined) each.delivered = true;
          }),
        ),
        Stream.ensuring(
          Effect.sync(() => {
            for (const [id, each] of waiting)
              if (each.delivered) {
                plain(each.res, 503, "Gram's connection to this machine ended; try again.");
                waiting.delete(id);
              }
          }),
        ),
      ),
      answer: (answer) =>
        Effect.sync(() => {
          const each = waiting.get(answer.id);
          if (each === undefined || each.res.headersSent) return;
          waiting.delete(answer.id);
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(answer.headers))
            if (ANSWER_HEADERS.has(name)) headers[name] = value;
          const status = answer.status >= 200 && answer.status <= 599 ? answer.status : 502;
          each.res.writeHead(status, headers);
          each.res.end(answer.body);
        }),
    };
  },
);
