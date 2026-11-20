// This Gram's answer to an app-tool call a machine carried over its own connection
// (`app-tools-tunnel`, `host/app-tools-tunnel.ts`). The call is let through as one over the
// tailnet is (`placedOnMachine`): only with a token issued for a thread whose session is placed on
// that machine, so a machine can use no token but its own threads'. It is then made to this Gram's
// own app-tools endpoint on loopback, as a session here makes it, and its answer goes back.

import { request as httpRequest } from "node:http";

import {
  type HostAppToolsAnswer,
  type HostAppToolsRequest,
  type HostId,
  sessionHostOf,
} from "@gram/contracts";
import * as Effect from "effect/Effect";

import { bearerToken, MCP_PATH } from "../http/auth.ts";
import type { McpTokens } from "../app-tools/mcp-tokens.ts";
import type { ThreadStore } from "../persistence/thread-store.ts";

type Answer = Omit<HostAppToolsAnswer, "id">;

/** The headers a carried call is made with here: MCP over HTTP's, and its token. */
const SENT = [
  "authorization",
  "content-type",
  "accept",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
] as const;
/** The most of an answer carried back, as the host's side takes it. */
const ANSWER_MOST_BYTES = 8 * 1024 * 1024;

const refused = (status: number, text: string): Answer => ({
  status,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body: text,
});

/** One call to this Gram's loopback endpoint, with no deadline: a tool can wait on the user. */
export type LoopbackSend = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<Answer>;

const nodeSend: LoopbackSend = (url, init) =>
  new Promise((resolve, reject) => {
    const sent = httpRequest(
      url,
      { method: init.method, headers: init.headers, signal: init.signal },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > ANSWER_MOST_BYTES) {
            response.destroy();
            reject(new Error("answer too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const type = response.headers["content-type"];
          const session = response.headers["mcp-session-id"];
          resolve({
            status: response.statusCode ?? 502,
            headers: {
              ...(typeof type === "string" ? { "content-type": type } : {}),
              ...(typeof session === "string" ? { "mcp-session-id": session } : {}),
            },
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", reject);
      },
    );
    sent.on("error", reject);
    sent.end(init.body);
  });

export interface ForwardDeps {
  readonly tokens: Pick<McpTokens["Service"], "threadFor">;
  readonly store: Pick<ThreadStore["Service"], "getThread">;
  /** This Gram's own port, where its app tools are served on loopback. */
  readonly port: () => number | undefined;
  readonly send?: LoopbackSend;
}

/** Answers `request`, carried from `machine`. Never fails: a refusal is an answer too. */
export const forwardAppTools =
  (deps: ForwardDeps) =>
  (machine: HostId, request: HostAppToolsRequest): Effect.Effect<Answer> =>
    Effect.gen(function* () {
      const token = bearerToken(request.headers);
      const threadId = token === undefined ? undefined : yield* deps.tokens.threadFor(token);
      if (threadId === undefined) return refused(401, "unauthorized: bearer token required");
      const thread = yield* deps.store.getThread(threadId).pipe(Effect.option);
      // Only a thread whose session is on the machine that carried the call.
      if (thread._tag === "None" || sessionHostOf(thread.value) !== machine)
        return refused(401, "unauthorized: not a thread on this machine");
      const port = deps.port();
      if (port === undefined) return refused(503, "Gram isn't serving app tools now.");
      const headers: Record<string, string> = {};
      for (const name of SENT) {
        const value = request.headers[name];
        if (value !== undefined) headers[name] = value;
      }
      const send = deps.send ?? nodeSend;
      return yield* Effect.tryPromise({
        try: (signal) =>
          send(`http://127.0.0.1:${port}${MCP_PATH}`, {
            method: request.method,
            headers,
            body: request.body,
            signal,
          }),
        catch: () => refused(502, "Gram couldn't answer the app-tool call."),
      }).pipe(Effect.catch((answer) => Effect.succeed(answer)));
    });
